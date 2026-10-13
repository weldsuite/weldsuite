/**
 * Completing campaigns from routes outside the campaigns route (prospects,
 * suppressions): when a change leaves a campaign with nothing queued or active,
 * it is completed and `reach_campaign:completed` is published.
 */

import type { Context } from 'hono';
import { publishEntityEvent } from '@weldsuite/entity-events';
import type { Database } from '@weldsuite/worker-kit';
import type { Env, Variables } from '../../types';
import { completeFinishedCampaigns } from '../../services/campaigns';

type AppContext = Context<{ Bindings: Env; Variables: Variables }>;

/** Complete the campaigns that have nothing left to send and publish `completed` for each. */
export async function completeAndPublish(c: AppContext, db: Database, campaignIds: readonly string[]): Promise<void> {
  const done = await completeFinishedCampaigns(db, campaignIds);
  for (const campaign of done) {
    publishEntityEvent({ c, entityType: 'reach_campaign', action: 'completed', entityId: campaign.id, data: campaign });
  }
}
