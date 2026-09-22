/**
 * Phase 3: consume entity-webhooks* (hub SUB_WEBHOOKS) and run outbound
 * customer webhook matching/delivery via `dispatchWebhookDeliveries`.
 */

import type { EntityEventMessage } from '@weldsuite/entity-events';
import { dispatchWebhookDeliveries } from '@weldsuite/entity-events';
import { upsertTenantWorkIndex, TENANT_WORK_INTERVAL_MS } from '@weldsuite/connectors';
import {
  resolveWorkspaceByClerkOrg,
  resolveWorkspaceById,
  type TenantDatabase,
} from './db';
import type { Env } from './index';

interface ResolvedWorkspace {
  /** Internal `workspaces.id` — tenant_work_index + ById lookups. */
  workspaceId: string;
  /** Clerk org id — publishEntityEvent metadata + clerk-keyed DB lookups. */
  clerkOrgId: string;
  db: TenantDatabase;
}

/**
 * Entity-event metadata.workspaceId is usually the Clerk org id (app-api
 * middleware), but some producers / tests pass the internal `ws_…` id.
 */
async function resolveWorkspaceForEvent(
  env: Env,
  workspaceKey: string,
): Promise<ResolvedWorkspace> {
  if (workspaceKey.startsWith('org_')) {
    const { id, db } = await resolveWorkspaceByClerkOrg(env, workspaceKey);
    return { workspaceId: id, clerkOrgId: workspaceKey, db };
  }
  const { clerkOrgId, db } = await resolveWorkspaceById(env, workspaceKey);
  return { workspaceId: workspaceKey, clerkOrgId, db };
}

async function scheduleWebhookRetry(env: Env, workspaceId: string, clerkOrgId: string): Promise<void> {
  const d1 = env.CONNECTOR_SYNC_INDEX;
  if (!d1) return;
  try {
    await upsertTenantWorkIndex(d1, {
      workspaceId,
      clerkOrgId,
      kind: 'webhook_retry',
      // Align with RETRY_BASE_DELAY_MS (1 min) so the first cron can pick it up.
      nextDueAt: Date.now() + Math.min(TENANT_WORK_INTERVAL_MS, 60_000),
    });
  } catch (err) {
    console.warn(`[EntityWebhooks] webhook_retry upsert failed for ${workspaceId}:`, err);
  }
}

/**
 * Process one hub-fanned entity event into outbound webhook deliveries.
 * Throws on tenant DB resolution failure so the queue message is retried.
 * Per-webhook HTTP failures are recorded + D1-scheduled for cron retry; they
 * must not block the queue ack.
 */
export async function handleEntityWebhookMessage(
  event: EntityEventMessage,
  env: Env,
): Promise<void> {
  const workspaceKey = event.metadata.workspaceId;
  if (!workspaceKey) {
    console.warn(`[EntityWebhooks] Skipping event ${event.id} — missing workspaceId`);
    return;
  }

  const { workspaceId, clerkOrgId, db } = await resolveWorkspaceForEvent(env, workspaceKey);
  const result = await dispatchWebhookDeliveries({
    db,
    workspaceId: clerkOrgId,
    entityType: event.entityType,
    action: event.action,
    eventId: event.id,
    data: (event.data ?? {}) as Record<string, unknown>,
  });

  if (result.failed > 0) {
    await scheduleWebhookRetry(env, workspaceId, clerkOrgId);
  }
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
