import { and, eq, inArray, isNull } from 'drizzle-orm';
import { MetaMarketingClient, type MetaCampaignObjective, type UpdateMetaCampaignInput } from '@weldsuite/meta-ads';
import { hashCampaignPayload } from '@weldsuite/meta-ads';
import type { AdCampaignMetrics } from '@weldsuite/db/schema';
import { schema, type Database } from '../../db';
import type { Env } from '../../types';

const { adAccounts, adCampaigns } = schema;

async function markCampaignSyncError(
  db: Database,
  campaignId: string,
  message: string,
): Promise<void> {
  await db
    .update(adCampaigns)
    .set({
      syncStatus: 'error',
      syncError: message,
      updatedAt: new Date(),
    })
    .where(eq(adCampaigns.id, campaignId));
}

async function applyRemoteCampaignState(
  db: Database,
  campaignId: string,
  accountCurrency: string | null | undefined,
  remote: {
    platformCampaignId: string;
    name: string;
    status?: string;
    objective?: string;
    dailyBudget?: number;
    lifetimeBudget?: number;
    metrics?: AdCampaignMetrics;
  },
) {
  const contentHash = hashCampaignPayload({
    name: remote.name,
    status: remote.status ?? null,
    objective: remote.objective ?? null,
    dailyBudget: remote.dailyBudget ?? null,
    lifetimeBudget: remote.lifetimeBudget ?? null,
    metrics: remote.metrics ?? null,
  });

  const now = new Date();
  await db
    .update(adCampaigns)
    .set({
      platformCampaignId: remote.platformCampaignId,
      name: remote.name,
      status: remote.status,
      objective: remote.objective,
      dailyBudget: remote.dailyBudget,
      lifetimeBudget: remote.lifetimeBudget,
      currency: accountCurrency ?? undefined,
      metrics: remote.metrics,
      metricsSyncedAt: remote.metrics ? now : undefined,
      contentHash,
      syncStatus: 'synced',
      syncError: null,
      lastSyncedAt: now,
      updatedAt: now,
    })
    .where(eq(adCampaigns.id, campaignId));
}

export async function pushPendingCampaigns(
  db: Database,
  env: Env,
  connectionId: string,
  accessToken: string,
  platformAccountId?: string,
): Promise<{ pushed: number; failed: number }> {
  const selectedAccounts = await db
    .select()
    .from(adAccounts)
    .where(
      and(
        eq(adAccounts.connectionId, connectionId),
        eq(adAccounts.isSelected, true),
        isNull(adAccounts.deletedAt),
        ...(platformAccountId ? [eq(adAccounts.platformAccountId, platformAccountId)] : []),
      ),
    );

  const accountIds = selectedAccounts.map((account) => account.id);
  if (accountIds.length === 0) return { pushed: 0, failed: 0 };

  const pending = await db
    .select()
    .from(adCampaigns)
    .where(
      and(
        inArray(adCampaigns.adAccountId, accountIds),
        eq(adCampaigns.syncStatus, 'pending_push'),
        isNull(adCampaigns.deletedAt),
      ),
    );

  const client = new MetaMarketingClient({ accessToken });
  let pushed = 0;
  let failed = 0;

  for (const campaign of pending) {
    const account = selectedAccounts.find((row) => row.id === campaign.adAccountId);
    if (!account) continue;

    try {
      let remote;
      if (!campaign.platformCampaignId) {
        if (!campaign.objective) {
          throw new Error('Campaign objective is required before syncing');
        }
        if (campaign.dailyBudget == null && campaign.lifetimeBudget == null) {
          throw new Error('Campaign budget is required before syncing');
        }
        remote = await client.createCampaign(account.platformAccountId, {
          name: campaign.name,
          objective: campaign.objective as MetaCampaignObjective,
          status: (campaign.status as 'ACTIVE' | 'PAUSED' | undefined) ?? 'PAUSED',
          dailyBudget: campaign.dailyBudget ?? undefined,
          lifetimeBudget: campaign.lifetimeBudget ?? undefined,
        });
      } else {
        const update: UpdateMetaCampaignInput = {
          name: campaign.name,
          ...(campaign.objective ? { objective: campaign.objective as UpdateMetaCampaignInput['objective'] } : {}),
          ...(campaign.status ? { status: campaign.status as 'ACTIVE' | 'PAUSED' } : {}),
          ...(campaign.dailyBudget != null ? { dailyBudget: campaign.dailyBudget } : {}),
          ...(campaign.lifetimeBudget != null ? { lifetimeBudget: campaign.lifetimeBudget } : {}),
        };
        remote = await client.updateCampaign(
          account.platformAccountId,
          campaign.platformCampaignId,
          update,
        );
      }

      await applyRemoteCampaignState(db, campaign.id, account.currency, remote);
      pushed += 1;
    } catch (err) {
      failed += 1;
      await markCampaignSyncError(
        db,
        campaign.id,
        err instanceof Error ? err.message : 'Failed to sync campaign',
      );
    }
  }

  return { pushed, failed };
}

export async function pullSyncedCampaigns(
  db: Database,
  accessToken: string,
  connectionId: string,
  platformAccountId?: string,
  platformCampaignId?: string,
): Promise<{ pulled: number }> {
  const selectedAccounts = await db
    .select()
    .from(adAccounts)
    .where(
      and(
        eq(adAccounts.connectionId, connectionId),
        eq(adAccounts.isSelected, true),
        isNull(adAccounts.deletedAt),
        ...(platformAccountId ? [eq(adAccounts.platformAccountId, platformAccountId)] : []),
      ),
    );

  const accountIds = selectedAccounts.map((account) => account.id);
  if (accountIds.length === 0) return { pulled: 0 };

  const synced = await db
    .select()
    .from(adCampaigns)
    .where(
      and(
        inArray(adCampaigns.adAccountId, accountIds),
        eq(adCampaigns.syncStatus, 'synced'),
        isNull(adCampaigns.deletedAt),
        ...(platformCampaignId ? [eq(adCampaigns.platformCampaignId, platformCampaignId)] : []),
      ),
    );

  const client = new MetaMarketingClient({ accessToken });
  let pulled = 0;

  for (const campaign of synced) {
    if (!campaign.platformCampaignId) continue;
    const account = selectedAccounts.find((row) => row.id === campaign.adAccountId);
    if (!account) continue;

    const remote = await client.getCampaign(account.platformAccountId, campaign.platformCampaignId);
    if (!remote) continue;

    const contentHash = hashCampaignPayload({
      name: remote.name,
      status: remote.status ?? null,
      objective: remote.objective ?? null,
      dailyBudget: remote.dailyBudget ?? null,
      lifetimeBudget: remote.lifetimeBudget ?? null,
      metrics: remote.metrics ?? null,
    });
    if (campaign.contentHash === contentHash) continue;

    await applyRemoteCampaignState(db, campaign.id, account.currency, remote);
    pulled += 1;
  }

  return { pulled };
}

export async function syncAdConnection(
  db: Database,
  env: Env,
  connectionId: string,
  accessToken: string,
  scope: 'push' | 'pull' | 'full' = 'full',
  options: { platformAccountId?: string; platformCampaignId?: string } = {},
) {
  let pushed = 0;
  let failed = 0;
  let pulled = 0;

  if (scope === 'push' || scope === 'full') {
    const pushResult = await pushPendingCampaigns(
      db,
      env,
      connectionId,
      accessToken,
      options.platformAccountId,
    );
    pushed = pushResult.pushed;
    failed = pushResult.failed;
  }

  if (scope === 'pull' || scope === 'full') {
    const pullResult = await pullSyncedCampaigns(
      db,
      accessToken,
      connectionId,
      options.platformAccountId,
      options.platformCampaignId,
    );
    pulled = pullResult.pulled;
  }

  return { pushed, failed, pulled };
}
