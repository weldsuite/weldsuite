/**
 * Workflow Webhook Receiver — service helpers.
 *
 * Originally ported from apps/api-worker/src/routes/webhooks/workflow-receiver.ts
 * (legacy worker phase-out, W3); webhookId → workspaceId resolution now goes
 * through the master-DB registry (services/workflow-webhook-registry.ts)
 * instead of a tenant-DB fan-out scan. This module keeps:
 * - HMAC SHA-256 signature verification (hex, with optional `sha256=` prefix),
 *   computed over the RAW request body the sender signed
 * - a constant-time comparison so timing can't leak how much of the
 *   signature matched
 * - per-call stats bookkeeping on the workflow_webhooks row
 */

import { eq, sql } from 'drizzle-orm';
import { schema, type Database } from '@weldsuite/worker-kit/db';

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
 * Constant-time comparison of two strings. Signature checks must never
 * short-circuit on the first mismatched character — that turns an
 * HMAC comparison into a timing oracle. Returns false immediately (safe,
 * since there is nothing secret about the *length*) when lengths differ.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Bump the per-webhook call statistics for a call the webhook ACCEPTED (it
 * passed signature / method / IP checks and its workflow is active). Rejected
 * requests are never recorded: `totalCalls` is accepted calls only, and
 * `failedCalls` counts accepted calls whose run could not be started.
 *
 * Counters are incremented in SQL so concurrent calls don't lose updates.
 * Best-effort — never throws.
 */
export async function updateWebhookStats(
  db: Database,
  webhookId: string,
  success: boolean,
  sourceIp?: string,
): Promise<void> {
  const t = schema.workflowWebhooks;
  try {
    await db
      .update(t)
      .set({
        totalCalls: sql`coalesce(${t.totalCalls}, 0) + 1`,
        successfulCalls: success ? sql`coalesce(${t.successfulCalls}, 0) + 1` : t.successfulCalls,
        failedCalls: success ? t.failedCalls : sql`coalesce(${t.failedCalls}, 0) + 1`,
        lastCalledAt: new Date(),
        lastCallStatus: success ? 'success' : 'failed',
        lastCallIp: sourceIp,
        updatedAt: new Date(),
      })
      .where(eq(t.id, webhookId));
  } catch (err) {
    console.error('[WebhookReceiver] Failed to update stats:', err);
  }
}
