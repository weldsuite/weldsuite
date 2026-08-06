/**
 * WeldConnect workflow triggers.
 *
 * Was inline sink 6 in the publisher: a read of the tenant `workflows` table on
 * the write path of every mutation. Here it is one read per matched batch.
 *
 * Latency note — this is the sink the move costs the most. Triggers used to
 * fire in the same invocation as the mutation; now they wait for the batch
 * window (`max_batch_timeout = 1`) plus dispatcher startup, so roughly a second
 * end to end. If some automation turns out to need better than that, this is
 * the consumer to move back inline.
 *
 * Passing `eventId` makes each dispatched run's Workflow instance id
 * deterministic, so a retried batch cannot start the same automation twice.
 */

import { defineConsumer } from '@weldsuite/entity-events/consumers';
import { matchAndDispatchWorkflowTriggers } from '@weldsuite/entity-events';
import type { Env } from '../env';

export const workflowTriggersConsumer = defineConsumer<Env>({
  name: 'workflow-triggers',
  subscribes: '*',
  needsTenantDb: true,

  async handle(events, { env, db, workspaceId }) {
    if (!db) throw new Error('workflow-triggers consumer requires a tenant db');
    if (!env.EXECUTE_WORKFLOW) {
      throw new Error('EXECUTE_WORKFLOW binding is not configured');
    }

    for (const event of events) {
      await matchAndDispatchWorkflowTriggers({
        env,
        db,
        workspaceId,
        userId: event.metadata.userId,
        entityType: event.entityType,
        entityId: event.entityId,
        action: event.action,
        data: event.data as Record<string, unknown>,
        changes: event.changes,
        eventId: event.id,
      });
    }
  },
});
