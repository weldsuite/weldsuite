/**
 * Phase 6: consume entity-realtime* (hub SUB_REALTIME) and publish to
 * WorkspaceHub DO — same contract as RealtimePublisher → /publish/workspace.
 *
 * Idempotency: at-least-once. Hub retries re-deliver the same evt_ id; duplicate
 * WebSocket events are acceptable for soft realtime (clients already tolerate
 * reconnects / missed frames). Exact-once via DO eventId suppress is deferred.
 */

import type { EntityEventMessage } from '@weldsuite/entity-events/types';
import type { Env } from './lib/protocol';

/**
 * Publish one entity event into WorkspaceHub, stitching `_access.userIds`
 * when the hub message carries `accessUserIds`.
 */
export async function publishEntityEventToWorkspaceHub(
  env: Env,
  event: EntityEventMessage,
): Promise<void> {
  const workspaceId = event.metadata.workspaceId;
  if (!workspaceId) {
    console.warn(`[EntityRealtime] Skipping event ${event.id} — missing workspaceId`);
    return;
  }

  const data =
    event.accessUserIds && event.accessUserIds.length > 0
      ? { ...(event.data as object), _access: { userIds: event.accessUserIds } }
      : event.data;

  const id = env.WORKSPACE_HUB.idFromName(workspaceId);
  const stub = env.WORKSPACE_HUB.get(id);
  const res = await stub.fetch('https://internal/publish', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      topic: event.entityType,
      event: event.action,
      data,
      userId: event.metadata.userId || 'system',
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(
      `[EntityRealtime] WorkspaceHub publish failed ${res.status} for ${event.eventType}: ${body}`,
    );
  }
}

export async function handleEntityRealtimeMessage(
  event: EntityEventMessage,
  env: Env,
): Promise<void> {
  await publishEntityEventToWorkspaceHub(env, event);
}

export async function handleEntityRealtimeBatch(
  batch: MessageBatch<EntityEventMessage>,
  env: Env,
): Promise<void> {
  console.log(`[EntityRealtime] Processing batch of ${batch.messages.length} events`);

  let ok = 0;
  let failed = 0;

  for (const message of batch.messages) {
    try {
      await handleEntityRealtimeMessage(message.body, env);
      message.ack();
      ok++;
    } catch (err) {
      console.error(`[EntityRealtime] Failed to process event ${message.body.id}:`, err);
      message.retry();
      failed++;
    }
  }

  console.log(`[EntityRealtime] Batch complete: ${ok} ok, ${failed} failed`);
}
