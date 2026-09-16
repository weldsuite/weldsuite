/**
 * Phase 3: consume entity-webhooks* (hub SUB_WEBHOOKS) and run outbound
 * customer webhook matching/delivery via `dispatchWebhookDeliveries`.
 */

import type { EntityEventMessage } from '@weldsuite/entity-events';
import { dispatchWebhookDeliveries } from '@weldsuite/entity-events';
import { getTenantDbForWorkspaceById } from './db';
import type { Env } from './index';

/**
 * Process one hub-fanned entity event into outbound webhook deliveries.
 * Throws on tenant DB resolution failure so the queue message is retried.
 * Per-webhook HTTP failures are swallowed inside `dispatchWebhookDeliveries`
 * (recorded + cron-retried); they must not block the queue ack.
 */
export async function handleEntityWebhookMessage(
  event: EntityEventMessage,
  env: Env,
): Promise<void> {
  const workspaceId = event.metadata.workspaceId;
  if (!workspaceId) {
    console.warn(`[EntityWebhooks] Skipping event ${event.id} — missing workspaceId`);
    return;
  }

  const db = await getTenantDbForWorkspaceById(env, workspaceId);
  await dispatchWebhookDeliveries({
    db,
    workspaceId,
    entityType: event.entityType,
    action: event.action,
    eventId: event.id,
    data: (event.data ?? {}) as Record<string, unknown>,
  });
}

export async function handleEntityWebhookBatch(
  batch: MessageBatch<EntityEventMessage>,
  env: Env,
): Promise<void> {
  console.log(`[EntityWebhooks] Processing batch of ${batch.messages.length} events`);

  let ok = 0;
  let failed = 0;

  for (const message of batch.messages) {
    try {
      await handleEntityWebhookMessage(message.body, env);
      message.ack();
      ok++;
    } catch (err) {
      console.error(`[EntityWebhooks] Failed to process event ${message.body.id}:`, err);
      message.retry();
      failed++;
    }
  }

  console.log(`[EntityWebhooks] Batch complete: ${ok} ok, ${failed} failed`);
}
