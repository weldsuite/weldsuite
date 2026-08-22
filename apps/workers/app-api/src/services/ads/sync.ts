import { and, eq, inArray, isNull } from 'drizzle-orm';
import { MetaMarketingClient } from '@weldsuite/meta-ads';
import { hashCampaignPayload } from '@weldsuite/meta-ads';
import { decryptField, encryptField, type EncryptionKeyring } from '@weldsuite/db/lib/crypto';
import type { AdCampaignMetrics } from '@weldsuite/db/schema';
import { schema, type Database } from '../../db';
import { generateId } from '../../lib/id';
import {
  deleteAdAccountKvMapping,
  writeAdAccountKvMapping,
} from './meta-oauth';
import { touchAdSyncIndexAfterMetricsSync, upsertAdSyncIndex } from './sync-index';
import type { Env } from '../../types';

const {
  adPlatformConnections,
  adAccounts,
  adCampaigns,
} = schema;

export interface SyncScope {
  scope?: 'full' | 'metrics' | 'incremental';
  platformAccountId?: string;
  platformCampaignId?: string;
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
  env: Env,
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
  clerkOrgId: string,
  options: SyncScope = {},
): Promise<{ syncedCampaigns: number; writtenCampaigns: number }> {
  const selected = await db
    .select()
    .from(adAccounts)
    .where(
      and(
        eq(adAccounts.connectionId, connectionId),
        eq(adAccounts.isSelected, true),
        isNull(adAccounts.deletedAt),
        ...(options.platformAccountId
          ? [eq(adAccounts.platformAccountId, options.platformAccountId)]
          : []),
      ),
    );

  const client = new MetaMarketingClient({ accessToken });
  let syncedCampaigns = 0;
  let writtenCampaigns = 0;

  for (const account of selected) {
    if (options.scope === 'incremental' && options.platformCampaignId) {
      const campaign = await client.getCampaign(account.platformAccountId, options.platformCampaignId);
      if (campaign) {
        syncedCampaigns += 1;
        const wrote = await upsertCampaignIfChanged(db, account.id, account.currency, campaign);
        if (wrote) writtenCampaigns += 1;
      }
      continue;
    }

    const campaigns =
      options.scope === 'metrics'
        ? await refreshMetricsForAccount(db, client, account.id, account.platformAccountId)
        : await client.listCampaignsWithInsights(account.platformAccountId);

    syncedCampaigns += campaigns.length;
    for (const campaign of campaigns) {
      const wrote = await upsertCampaignIfChanged(db, account.id, account.currency, campaign);
      if (wrote) writtenCampaigns += 1;
    }

    await writeAdAccountKvMapping(env.WORKSPACE_CACHE, account.platformAccountId, {
      workspaceId,
      connectionId,
      clerkOrgId,
    });
  }

  const now = new Date();
  await db
    .update(adPlatformConnections)
    .set({ lastSyncAt: now, updatedAt: now, lastError: null })
    .where(eq(adPlatformConnections.id, connectionId));

  if (options.scope === 'metrics' || options.scope === 'full') {
    await touchAdSyncIndexAfterMetricsSync(env, workspaceId, connectionId);
  }

  return { syncedCampaigns, writtenCampaigns };
}

async function refreshMetricsForAccount(
  db: Database,
  client: MetaMarketingClient,
  adAccountId: string,
  platformAccountId: string,
) {
  const existing = await db
    .select()
    .from(adCampaigns)
    .where(and(eq(adCampaigns.adAccountId, adAccountId), isNull(adCampaigns.deletedAt)));

  const refreshed = [];
  for (const row of existing) {
    const campaign = await client.getCampaign(platformAccountId, row.platformCampaignId);
    if (campaign) refreshed.push(campaign);
  }
  return refreshed;
}

async function upsertCampaignIfChanged(
  db: Database,
  adAccountId: string,
  currency: string | null | undefined,
  campaign: {
    platformCampaignId: string;
    name: string;
    status?: string;
    objective?: string;
    dailyBudget?: number;
    lifetimeBudget?: number;
    metrics?: AdCampaignMetrics;
  },
): Promise<boolean> {
  const contentHash = hashCampaignPayload({
    name: campaign.name,
    status: campaign.status ?? null,
    objective: campaign.objective ?? null,
    dailyBudget: campaign.dailyBudget ?? null,
    lifetimeBudget: campaign.lifetimeBudget ?? null,
    metrics: campaign.metrics ?? null,
  });

  const [existing] = await db
    .select({ id: adCampaigns.id, contentHash: adCampaigns.contentHash })
    .from(adCampaigns)
    .where(
      and(
        eq(adCampaigns.adAccountId, adAccountId),
        eq(adCampaigns.platformCampaignId, campaign.platformCampaignId),
        isNull(adCampaigns.deletedAt),
      ),
    )
    .limit(1);

  if (existing?.contentHash === contentHash) return false;

  const now = new Date();
  const values = {
    name: campaign.name,
    status: campaign.status,
    objective: campaign.objective,
    dailyBudget: campaign.dailyBudget,
    lifetimeBudget: campaign.lifetimeBudget,
    currency: currency ?? undefined,
    metrics: campaign.metrics,
    metricsSyncedAt: now,
    contentHash,
    updatedAt: now,
  };

  if (existing) {
    await db.update(adCampaigns).set(values).where(eq(adCampaigns.id, existing.id));
    return true;
  }

  await db.insert(adCampaigns).values({
    id: generateId('adcp'),
    adAccountId,
    platformCampaignId: campaign.platformCampaignId,
    createdAt: now,
    ...values,
  });
  return true;
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
    accessToken: string;
    webhookCallbackUrl?: string;
    webhookVerifyToken?: string;
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

  const [account] = await db
    .select()
    .from(adAccounts)
    .where(eq(adAccounts.id, input.accountId))
    .limit(1);
  if (!account) return;

  if (input.isSelected) {
    await writeAdAccountKvMapping(env.WORKSPACE_CACHE, account.platformAccountId, {
      workspaceId: input.workspaceId,
      connectionId: input.connectionId,
      clerkOrgId: input.clerkOrgId,
    });
    if (input.webhookCallbackUrl && input.webhookVerifyToken) {
      const client = new MetaMarketingClient({ accessToken: input.accessToken });
      await client.subscribeAdAccountWebhooks(
        account.platformAccountId,
        input.webhookCallbackUrl,
        input.webhookVerifyToken,
      );
    }
  } else {
    await deleteAdAccountKvMapping(env.WORKSPACE_CACHE, account.platformAccountId);
    try {
      const client = new MetaMarketingClient({ accessToken: input.accessToken });
      await client.unsubscribeAdAccountWebhooks(account.platformAccountId);
    } catch (err) {
      console.warn('[ads/sync] webhook unsubscribe failed:', err);
    }
  }

  await upsertAdSyncIndex(env, {
    workspaceId: input.workspaceId,
    connectionId: input.connectionId,
    clerkOrgId: input.clerkOrgId,
    isEnabled: selectedCount.length > 0,
    webhookSubscribedAt: input.isSelected ? now : null,
  });
}

export async function cleanupConnectionMappings(
  db: Database,
  env: Env,
  connectionId: string,
): Promise<void> {
  const accounts = await db
    .select({ id: adAccounts.id, platformAccountId: adAccounts.platformAccountId })
    .from(adAccounts)
    .where(and(eq(adAccounts.connectionId, connectionId), isNull(adAccounts.deletedAt)));

  for (const account of accounts) {
    await deleteAdAccountKvMapping(env.WORKSPACE_CACHE, account.platformAccountId);
  }

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
