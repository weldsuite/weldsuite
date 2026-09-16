/**
 * Phase 4: consume entity-workflows* (hub SUB_WELDCONNECT) and run WeldConnect
 * entity_event matching via `matchAndDispatchWorkflowTriggers`.
 */

import type { EntityEventMessage } from '@weldsuite/entity-events';
import { matchAndDispatchWorkflowTriggers } from '@weldsuite/entity-events';
import { getTenantDbForWorkspace } from './db';
import type { Env } from './index';

/**
 * Process one hub-fanned entity event into WeldConnect workflow dispatches.
 * Throws on tenant DB resolution failure so the queue message is retried.
 * Per-workflow CREATE failures are swallowed inside the matcher.
 */
export async function handleEntityWorkflowMessage(
  event: EntityEventMessage,
  env: Env,
): Promise<void> {
  const workspaceId = event.metadata.workspaceId;
  if (!workspaceId) {
    console.warn(`[EntityWorkflows] Skipping event ${event.id} — missing workspaceId`);
    return;
  }

  if (!env.EXECUTE_WORKFLOW) {
    console.warn(
      `[EntityWorkflows] Skipping event ${event.id} — EXECUTE_WORKFLOW binding missing`,
    );
    return;
  }

  const db = await getTenantDbForWorkspace(env, workspaceId);
  await matchAndDispatchWorkflowTriggers({
    env,
    db,
    workspaceId,
    userId: event.metadata.userId || 'system',
    entityType: event.entityType,
    entityId: event.entityId,
    action: event.action,
    data: (event.data ?? {}) as Record<string, unknown>,
    changes: event.changes,
    eventId: event.id,
  });
}

export async function handleEntityWorkflowBatch(
  batch: MessageBatch<EntityEventMessage>,
  env: Env,
): Promise<void> {
  console.log(`[EntityWorkflows] Processing batch of ${batch.messages.length} events`);

  let ok = 0;
  let failed = 0;

  for (const message of batch.messages) {
    try {
      await handleEntityWorkflowMessage(message.body, env);
      message.ack();
      ok++;
    } catch (err) {
      console.error(`[EntityWorkflows] Failed to process event ${message.body.id}:`, err);
      message.retry();
      failed++;
    }
  }

  console.log(`[EntityWorkflows] Batch complete: ${ok} ok, ${failed} failed`);
}
