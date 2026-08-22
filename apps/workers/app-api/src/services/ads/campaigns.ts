import { and, eq, isNull } from 'drizzle-orm';
import type { MetaCampaignObjective, MetaCampaignStatus } from '@weldsuite/meta-ads';
import { schema, type Database } from '../../db';
import { generateId } from '../../lib/id';

const { adAccounts, adCampaigns } = schema;

export interface CreateLocalCampaignInput {
  adAccountId: string;
  name: string;
  objective: MetaCampaignObjective;
  status?: MetaCampaignStatus;
  dailyBudget?: number;
  lifetimeBudget?: number;
}

export interface UpdateLocalCampaignInput {
  name?: string;
  objective?: MetaCampaignObjective;
  status?: MetaCampaignStatus;
  dailyBudget?: number;
  lifetimeBudget?: number;
}

async function loadWritableAccount(db: Database, adAccountId: string) {
  const [account] = await db
    .select()
    .from(adAccounts)
    .where(and(eq(adAccounts.id, adAccountId), isNull(adAccounts.deletedAt)))
    .limit(1);
  if (!account) throw new Error('Ad account not found');
  if (!account.isSelected) throw new Error('Ad account is not selected for sync');
  return account;
}

export async function createLocalCampaign(db: Database, input: CreateLocalCampaignInput) {
  const account = await loadWritableAccount(db, input.adAccountId);
  const now = new Date();

  const [row] = await db
    .insert(adCampaigns)
    .values({
      id: generateId('adcp'),
      adAccountId: account.id,
      platformCampaignId: null,
      name: input.name,
      status: input.status ?? 'PAUSED',
      objective: input.objective,
      dailyBudget: input.dailyBudget,
      lifetimeBudget: input.lifetimeBudget,
      currency: account.currency ?? undefined,
      syncStatus: 'pending_push',
      syncError: null,
      createdAt: now,
      updatedAt: now,
    })
    .returning();

  return row;
}

export async function updateLocalCampaign(
  db: Database,
  campaignId: string,
  input: UpdateLocalCampaignInput,
) {
  const [existing] = await db
    .select()
    .from(adCampaigns)
    .where(and(eq(adCampaigns.id, campaignId), isNull(adCampaigns.deletedAt)))
    .limit(1);
  if (!existing) throw new Error('Ad campaign not found');

  await loadWritableAccount(db, existing.adAccountId);

  const now = new Date();
  const values = {
    ...(input.name != null ? { name: input.name } : {}),
    ...(input.objective != null ? { objective: input.objective } : {}),
    ...(input.status != null ? { status: input.status } : {}),
    ...(input.dailyBudget != null ? { dailyBudget: input.dailyBudget } : {}),
    ...(input.lifetimeBudget != null ? { lifetimeBudget: input.lifetimeBudget } : {}),
    syncStatus: 'pending_push' as const,
    syncError: null,
    updatedAt: now,
  };

  const [row] = await db
    .update(adCampaigns)
    .set(values)
    .where(eq(adCampaigns.id, campaignId))
    .returning();

  if (!row) throw new Error('Ad campaign not found');
  return row;
}

export async function setLocalCampaignStatus(
  db: Database,
  campaignId: string,
  status: MetaCampaignStatus,
) {
  return updateLocalCampaign(db, campaignId, { status });
}
