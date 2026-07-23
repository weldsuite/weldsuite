/**
 * Workflow Webhook Receiver — service helpers.
 *
 * Ported from apps/api-worker/src/routes/webhooks/workflow-receiver.ts
 * (legacy worker phase-out, W3). Behavior is preserved 1:1:
 * - webhookId → workspaceId resolution via WORKSPACE_CACHE KV (5 min TTL),
 *   falling back to a scan of all non-deleted workspaces' tenant DBs
 * - HMAC SHA-256 signature verification (hex, with optional `sha256=` prefix)
 * - per-call stats bookkeeping on the workflow_webhooks row
 */

import { eq, and, isNull } from 'drizzle-orm';
// (master workspaces table has no deletedAt column in @weldsuite/db — the
// active-workspace filter uses isActive; see note in the migration report)
import {
  getMasterDb,
  getTenantDbForWorkspace,
  schema,
  masterSchema,
  type Database,
} from '../db';
import type { Env } from '../types';

const WEBHOOK_CACHE_TTL_SECONDS = 300;

/**
 * Resolve which workspace (Clerk org id) owns a webhook id.
 * KV-cached; on cache miss scans workspaces to find the tenant DB
 * containing the webhook (exactly as the api-worker receiver did).
 */
export async function resolveWebhookWorkspace(
  env: Env,
  webhookId: string,
): Promise<string | null> {
  const cacheKey = `webhook:${webhookId}`;
  const cached = await env.WORKSPACE_CACHE.get(cacheKey);
  if (cached) return cached;

  const masterDb = getMasterDb(env);
  const workspaces = await masterDb
    .select({ clerkOrgId: masterSchema.workspaces.clerkOrgId })
    .from(masterSchema.workspaces)
    .where(eq(masterSchema.workspaces.isActive, true));

  for (const ws of workspaces) {
    if (!ws.clerkOrgId) continue;
    try {
      const db = await getTenantDbForWorkspace(env, ws.clerkOrgId);
      const [wh] = await db
        .select({ id: schema.workflowWebhooks.id })
        .from(schema.workflowWebhooks)
        .where(
          and(
            eq(schema.workflowWebhooks.id, webhookId),
            isNull(schema.workflowWebhooks.deletedAt),
          ),
        )
        .limit(1);

      if (wh) {
        await env.WORKSPACE_CACHE.put(cacheKey, ws.clerkOrgId, {
          expirationTtl: WEBHOOK_CACHE_TTL_SECONDS,
        });
        return ws.clerkOrgId;
      }
    } catch {
      continue;
    }
  }

  return null;
}

/**
 * Compute the lowercase hex HMAC-SHA256 of a payload with the webhook secret.
 * Matches the api-worker implementation byte-for-byte.
 */
export async function computeWebhookHmacHex(
  secret: string,
  payload: string,
): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(payload));
  return Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Bump the per-webhook call statistics after a receive attempt.
 * Best-effort — never throws.
 */
export async function updateWebhookStats(
  db: Database,
  webhookId: string,
  success: boolean,
  sourceIp?: string,
): Promise<void> {
  try {
    const [webhook] = await db
      .select()
      .from(schema.workflowWebhooks)
      .where(eq(schema.workflowWebhooks.id, webhookId))
      .limit(1);

    if (webhook) {
      await db
        .update(schema.workflowWebhooks)
        .set({
          totalCalls: (webhook.totalCalls || 0) + 1,
          successfulCalls: success
            ? (webhook.successfulCalls || 0) + 1
            : webhook.successfulCalls,
          failedCalls: !success
            ? (webhook.failedCalls || 0) + 1
            : webhook.failedCalls,
          lastCalledAt: new Date(),
          lastCallStatus: success ? 'success' : 'failed',
          lastCallIp: sourceIp,
          updatedAt: new Date(),
        })
        .where(eq(schema.workflowWebhooks.id, webhookId));
    }
  } catch (err) {
    console.error('[WebhookReceiver] Failed to update stats:', err);
  }
}
