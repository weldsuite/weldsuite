import { and, eq, inArray, isNull } from 'drizzle-orm';
import { MetaMarketingClient } from '@weldsuite/meta-ads';
import { decryptField, encryptField, type EncryptionKeyring } from '@weldsuite/db/lib/crypto';
import { schema, type Database } from '../../db';
import { generateId } from '../../lib/id';
import { syncAdConnection } from './campaign-management';
import { touchAdSyncIndexAfterMetricsSync, upsertAdSyncIndex } from './sync-index';
import type { Env } from '../../types';

const {
  adPlatformConnections,
  adAccounts,
  adCampaigns,
} = schema;

export interface SyncScope {
  scope?: 'full' | 'push' | 'pull' | 'metrics' | 'incremental';
  platformAccountId?: string;
  platformCampaignId?: string;
}

function normalizeScope(scope?: SyncScope['scope']): 'full' | 'push' | 'pull' {
  if (scope === 'push') return 'push';
  if (scope === 'pull' || scope === 'metrics' || scope === 'incremental') return 'pull';
  return 'full';
}

function keyringFromEnv(env: Env): EncryptionKeyring {
  return { v1: env.DATABASE_ENCRYPTION_KEY, v2: env.DATABASE_ENCRYPTION_KEY_V2 };
}

export async function decryptAccessToken(
  encrypted: string | undefined,
  keyring: EncryptionKeyring,
): Promise<string | undefined> {
  if (!encrypted) return undefined;
  return decryptField(encrypted, keyring);
}

export function stripConnectionSecrets<T extends { oauthTokens?: unknown }>(row: T) {
  return { ...row, oauthTokens: undefined };
}

export async function discoverAdAccounts(
  db: Database,
  _env: Env,
  connectionId: string,
  accessToken: string,
): Promise<void> {
  const client = new MetaMarketingClient({ accessToken });
  const remoteAccounts = await client.listAdAccounts();
  const now = new Date();

  for (const remote of remoteAccounts) {
    const [existing] = await db
      .select({ id: adAccounts.id })
      .from(adAccounts)
      .where(
        and(
          eq(adAccounts.connectionId, connectionId),
          eq(adAccounts.platformAccountId, remote.platformAccountId),
          isNull(adAccounts.deletedAt),
        ),
      )
      .limit(1);

    if (existing) {
      await db
        .update(adAccounts)
        .set({
          name: remote.name,
          currency: remote.currency,
          timezone: remote.timezone,
          status: remote.status,
          updatedAt: now,
        })
        .where(eq(adAccounts.id, existing.id));
      continue;
    }

    await db.insert(adAccounts).values({
      id: generateId('adac'),
      connectionId,
      platformAccountId: remote.platformAccountId,
      name: remote.name,
      currency: remote.currency,
      timezone: remote.timezone,
      status: remote.status,
      isSelected: false,
      createdAt: now,
      updatedAt: now,
    });
  }
}

export async function syncSelectedAccounts(
  db: Database,
  env: Env,
  connectionId: string,
  accessToken: string,
  workspaceId: string,
  _clerkOrgId: string,
  options: SyncScope = {},
): Promise<{ syncedCampaigns: number; writtenCampaigns: number; pushed: number; failed: number; pulled: number }> {
  const scope = normalizeScope(options.scope);
  const result = await syncAdConnection(db, env, connectionId, accessToken, scope, {
    platformAccountId: options.platformAccountId,
    platformCampaignId: options.platformCampaignId,
  });

  const now = new Date();
  await db
    .update(adPlatformConnections)
    .set({ lastSyncAt: now, updatedAt: now, lastError: null })
    .where(eq(adPlatformConnections.id, connectionId));

  if (scope === 'pull' || scope === 'full') {
    await touchAdSyncIndexAfterMetricsSync(env, workspaceId, connectionId);
  }

  return {
    syncedCampaigns: result.pushed + result.pulled,
    writtenCampaigns: result.pushed + result.pulled,
    pushed: result.pushed,
    failed: result.failed,
    pulled: result.pulled,
  };
}

export async function setAccountSelection(
  db: Database,
  env: Env,
  input: {
    accountId: string;
    isSelected: boolean;
    workspaceId: string;
    clerkOrgId: string;
    connectionId: string;
  },
): Promise<void> {
  const now = new Date();
  await db
    .update(adAccounts)
    .set({ isSelected: input.isSelected, updatedAt: now })
    .where(eq(adAccounts.id, input.accountId));

  const selectedCount = await db
    .select({ id: adAccounts.id })
    .from(adAccounts)
    .where(
      and(
        eq(adAccounts.connectionId, input.connectionId),
        eq(adAccounts.isSelected, true),
        isNull(adAccounts.deletedAt),
      ),
    );

  await upsertAdSyncIndex(env, {
    workspaceId: input.workspaceId,
    connectionId: input.connectionId,
    clerkOrgId: input.clerkOrgId,
    isEnabled: selectedCount.length > 0,
    webhookSubscribedAt: null,
  });
}

export async function cleanupConnectionMappings(
  db: Database,
  env: Env,
  connectionId: string,
): Promise<void> {
  const accounts = await db
    .select({ id: adAccounts.id })
    .from(adAccounts)
    .where(and(eq(adAccounts.connectionId, connectionId), isNull(adAccounts.deletedAt)));

  const now = new Date();
  const accountIds = accounts.map((a) => a.id);
  if (accountIds.length > 0) {
    await db
      .update(adCampaigns)
      .set({ deletedAt: now, updatedAt: now })
      .where(and(inArray(adCampaigns.adAccountId, accountIds), isNull(adCampaigns.deletedAt)));
  }

  await db
    .update(adAccounts)
    .set({ deletedAt: now, updatedAt: now, isSelected: false })
    .where(and(eq(adAccounts.connectionId, connectionId), isNull(adAccounts.deletedAt)));
}

export async function encryptOAuthTokens(
  accessToken: string,
  keyring: EncryptionKeyring,
): Promise<{ accessToken: string; tokenType?: string }> {
  return {
    accessToken: await encryptField(accessToken, keyring),
    tokenType: 'bearer',
  };
}
