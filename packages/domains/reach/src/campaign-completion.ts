/**
 * Completing campaigns: an active campaign with nothing queued or active left
 * is `completed`. Shared by the send engine, the reply handler and every write
 * that can take the last enrollment away (deleting a prospect, suppressing an
 * address, removing an enrollment).
 */

import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { Database } from '@weldsuite/worker-kit/db';
import { reachCampaigns, reachEnrollments, type ReachCampaign as ReachCampaignRow } from '@weldsuite/db/schema';
import type { ReachEventSink } from './events';

/**
 * Complete an active campaign that has nothing queued or active left. Returns
 * the campaign when it was completed now (so the caller can publish the
 * `completed` event), null otherwise.
 */
export async function completeCampaignIfDone(db: Database, campaignId: string): Promise<ReachCampaignRow | null> {
  const [pending] = await db
    .select({ id: reachEnrollments.id })
    .from(reachEnrollments)
    .where(and(eq(reachEnrollments.campaignId, campaignId), inArray(reachEnrollments.status, ['queued', 'active'])))
    .limit(1);
  if (pending) return null;
  const now = new Date();
  const [row] = await db
    .update(reachCampaigns)
    .set({ status: 'completed', completedAt: now, updatedAt: now })
    .where(and(eq(reachCampaigns.id, campaignId), eq(reachCampaigns.status, 'active'), isNull(reachCampaigns.deletedAt)))
    .returning();
  return row ?? null;
}

/** `completeCampaignIfDone` over several campaigns; returns the ones completed now. */
export async function completeFinishedCampaigns(db: Database, campaignIds: readonly string[]): Promise<ReachCampaignRow[]> {
  const done: ReachCampaignRow[] = [];
  for (const id of new Set(campaignIds)) {
    const row = await completeCampaignIfDone(db, id);
    if (row) done.push(row);
  }
  return done;
}

/** Complete the campaigns that have nothing left to send and publish `reach_campaign:completed` for each. */
export async function completeAndPublishCampaigns(db: Database, emit: ReachEventSink, campaignIds: readonly string[]): Promise<void> {
  const done = await completeFinishedCampaigns(db, campaignIds);
  for (const campaign of done) {
    await emit({ entityType: 'reach_campaign', action: 'completed', entityId: campaign.id, data: campaign });
  }
}
