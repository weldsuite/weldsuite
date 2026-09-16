/**
 * Phase 5: consume entity-agents* (hub SUB_WELDAGENT) and run WeldAgent
 * eventSubscriptions dispatch via the registered runner hook.
 */

import {
  runRegisteredWeldAgentDispatch,
  type EntityEventMessage,
} from '@weldsuite/entity-events';
import type { Env } from '../types';
import { getTenantDbForWorkspace } from '../db';

/**
 * Process one hub-fanned entity event into WeldAgent runs.
 * Throws on tenant DB resolution failure so the queue message is retried.
 * Per-agent failures are swallowed inside dispatch.
 */
export async function handleEntityAgentMessage(
  event: EntityEventMessage,
  env: Env,
): Promise<void> {
  const workspaceId = event.metadata.workspaceId;
  if (!workspaceId) {
    console.warn(`[EntityAgents] Skipping event ${event.id} — missing workspaceId`);
    return;
  }

  const db = await getTenantDbForWorkspace(env, workspaceId);
  await runRegisteredWeldAgentDispatch({
    workspaceId,
    userId: event.metadata.userId || 'system',
    entityType: event.entityType,
    action: event.action,
    entityId: event.entityId,
    data: (event.data ?? {}) as Record<string, unknown>,
    db,
    env,
    eventId: event.id,
  });
}

export async function handleEntityAgentBatch(
  batch: MessageBatch<EntityEventMessage>,
  env: Env,
): Promise<void> {
  console.log(`[EntityAgents] Processing batch of ${batch.messages.length} events`);

  let ok = 0;
  let failed = 0;

  for (const message of batch.messages) {
    try {
      await handleEntityAgentMessage(message.body, env);
      message.ack();
      ok++;
    } catch (err) {
      console.error(`[EntityAgents] Failed to process event ${message.body.id}:`, err);
      message.retry();
      failed++;
    }
  }

  console.log(`[EntityAgents] Batch complete: ${ok} ok, ${failed} failed`);
}
