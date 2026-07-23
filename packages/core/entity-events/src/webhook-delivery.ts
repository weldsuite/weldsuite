/**
 * Outbound webhook delivery — signs and POSTs entity events to
 * customer-configured `external_webhooks` endpoints, logging every attempt to
 * `webhook_deliveries`.
 *
 * Called from three places:
 *  - `fanOutEntityEvent` (publisher.ts) — fire-and-forget delivery on every
 *    entity mutation, matched against each webhook's subscribed `events[]`.
 *  - `apps/workers/app-api`'s `external-webhooks` route — `POST /:id/test` sends a
 *    single synthetic event through the same code path.
 *  - `apps/workers/integration-webhook-worker`'s cron — `retryFailedWebhookDeliveries`
 *    sweeps deliveries whose `nextRetryAt` is due.
 *
 * Retry policy: one immediate retry within the same invocation on network
 * error or 5xx (Workers can't `waitUntil`-sleep for meaningful backoff).
 * Failed deliveries are recorded with `nextRetryAt` so the cron sweep can
 * pick them up later, up to `maxRetries` attempts total with exponential
 * backoff. After 20 consecutive failures a webhook is auto-disabled.
 */

import { and, eq, isNull, lte, sql } from 'drizzle-orm';
import { externalWebhooks, webhookDeliveries } from '@weldsuite/db/schema';
import type { TenantDb } from './internal-types';

const DELIVERY_TIMEOUT_MS = 10_000;
const AUTO_DISABLE_THRESHOLD = 20;
const MAX_RETRY_ATTEMPTS = 5;
const RETRY_BASE_DELAY_MS = 60_000; // 1 minute, doubled per subsequent attempt
const RESPONSE_BODY_CAPTURE_LIMIT = 2000;
const ERROR_MESSAGE_CAPTURE_LIMIT = 500;

export type WebhookRow = typeof externalWebhooks.$inferSelect;
type DeliveryRow = typeof webhookDeliveries.$inferSelect;

function generateDeliveryId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `whd_${hex}`;
}

/** HMAC-SHA256 hex digest of the raw request body, using the webhook's secret. */
export async function signWebhookPayload(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  return Array.from(new Uint8Array(signature), (b) => b.toString(16).padStart(2, '0')).join('');
}

interface DeliveryAttemptResult {
  ok: boolean;
  status: number | null;
  body: string | null;
  durationMs: number;
  error: string | null;
}

/** Single HTTP attempt — signs, POSTs, and normalizes the outcome. Never throws. */
async function attemptDelivery(
  webhook: Pick<WebhookRow, 'url' | 'secret' | 'headers'>,
  body: string,
  eventType: string,
): Promise<DeliveryAttemptResult> {
  const started = Date.now();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT_MS);
  try {
    const signature = await signWebhookPayload(webhook.secret, body);
    const res = await fetch(webhook.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-WeldSuite-Signature': signature,
        'X-WeldSuite-Event': eventType,
        ...(webhook.headers ?? {}),
      },
      body,
      signal: controller.signal,
    });
    const durationMs = Date.now() - started;
    const responseBody = await res.text().catch(() => '');
    return {
      ok: res.ok,
      status: res.status,
      body: responseBody.slice(0, RESPONSE_BODY_CAPTURE_LIMIT),
      durationMs,
      error: res.ok ? null : `HTTP ${res.status}`,
    };
  } catch (err) {
    return {
      ok: false,
      status: null,
      body: null,
      durationMs: Date.now() - started,
      error: err instanceof Error ? err.message : 'Network error',
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

/** Update `external_webhooks` success/failure counters after a delivery attempt. */
async function applyDeliveryOutcome(
  db: TenantDb,
  webhook: Pick<WebhookRow, 'id' | 'consecutiveFailures' | 'status'>,
  success: boolean,
  errorMessage: string | null,
): Promise<void> {
  const now = new Date();
  if (success) {
    await db
      .update(externalWebhooks)
      .set({
        lastDeliveredAt: now,
        totalDeliveries: sql`${externalWebhooks.totalDeliveries} + 1`,
        consecutiveFailures: 0,
        updatedAt: now,
      })
      .where(eq(externalWebhooks.id, webhook.id));
    return;
  }

  const nextFailures = (webhook.consecutiveFailures ?? 0) + 1;
  const shouldDisable = nextFailures >= AUTO_DISABLE_THRESHOLD && webhook.status !== 'disabled';
  await db
    .update(externalWebhooks)
    .set({
      lastFailedAt: now,
      lastFailureReason: errorMessage?.slice(0, ERROR_MESSAGE_CAPTURE_LIMIT) ?? null,
      totalDeliveries: sql`${externalWebhooks.totalDeliveries} + 1`,
      totalFailures: sql`${externalWebhooks.totalFailures} + 1`,
      consecutiveFailures: nextFailures,
      status: shouldDisable ? 'disabled' : webhook.status,
      updatedAt: now,
    })
    .where(eq(externalWebhooks.id, webhook.id));
}

export interface DeliverWebhookEventInput {
  db: TenantDb;
  webhook: WebhookRow;
  /** Idempotency key — the entity event id, or a synthetic one for test sends. */
  eventId: string;
  /** Dotted wire format, e.g. `customer.created`. */
  eventType: string;
  workspaceId: string;
  data: Record<string, unknown>;
}

export interface DeliverWebhookEventResult {
  delivered: boolean;
  responseStatus: number | null;
  responseBody: string | null;
  errorMessage: string | null;
}

/**
 * Deliver a single event to a single webhook, with one immediate retry on
 * network error or 5xx, and record the attempt in `webhook_deliveries`.
 */
export async function deliverWebhookEvent(
  input: DeliverWebhookEventInput,
): Promise<DeliverWebhookEventResult> {
  const { db, webhook, eventId, eventType, workspaceId, data } = input;
  const payload = {
    id: eventId,
    type: eventType,
    workspaceId,
    timestamp: new Date().toISOString(),
    data,
  };
  const body = JSON.stringify(payload);

  let attempt = await attemptDelivery(webhook, body, eventType);
  let attemptNumber = 1;

  // One immediate retry on network error or 5xx — Workers can't sleep for a
  // meaningful backoff inside a single invocation, so this is the only retry
  // that happens synchronously. Further retries are the cron sweep's job.
  if (!attempt.ok && (attempt.status === null || attempt.status >= 500)) {
    attempt = await attemptDelivery(webhook, body, eventType);
    attemptNumber = 2;
  }

  const now = new Date();
  const nextRetryAt = attempt.ok ? null : new Date(now.getTime() + RETRY_BASE_DELAY_MS);

  await db.insert(webhookDeliveries).values({
    id: generateDeliveryId(),
    webhookId: webhook.id,
    eventType,
    eventId,
    payload: payload as Record<string, unknown>,
    status: attempt.ok ? 'delivered' : 'failed',
    responseStatus: attempt.status,
    responseBody: attempt.body,
    responseTimeMs: attempt.durationMs,
    attemptNumber,
    nextRetryAt,
    maxRetries: MAX_RETRY_ATTEMPTS,
    errorMessage: attempt.error,
    createdAt: now,
    deliveredAt: attempt.ok ? now : null,
  });

  await applyDeliveryOutcome(db, webhook, attempt.ok, attempt.error);

  return {
    delivered: attempt.ok,
    responseStatus: attempt.status,
    responseBody: attempt.body,
    errorMessage: attempt.error,
  };
}

export interface DispatchWebhookDeliveriesInput {
  db: TenantDb;
  workspaceId: string;
  entityType: string;
  action: string;
  /** The entity event id — reused as the delivery idempotency key. */
  eventId: string;
  data: Record<string, unknown>;
}

/**
 * Fan-out entry point called from `fanOutEntityEvent`. Looks up active
 * `external_webhooks` subscribed to `<entityType>.<action>` and delivers to
 * each, fire-and-forget (errors are swallowed per-webhook). Cheap no-op when
 * no webhook matches — the JSONB containment query IS the existence check,
 * so there is no separate pre-check to maintain.
 */
export async function dispatchWebhookDeliveries(input: DispatchWebhookDeliveriesInput): Promise<void> {
  const { db, workspaceId, entityType, action, eventId, data } = input;
  const eventType = `${entityType}.${action}`;

  let matches: WebhookRow[];
  try {
    matches = await db
      .select()
      .from(externalWebhooks)
      .where(
        and(
          eq(externalWebhooks.status, 'active'),
          isNull(externalWebhooks.deletedAt),
          sql`${externalWebhooks.events} @> ${JSON.stringify([eventType])}::jsonb`,
        ),
      );
  } catch (err) {
    console.error('[WebhookDelivery] Failed to look up subscriptions:', err);
    return;
  }
  if (matches.length === 0) return;

  await Promise.allSettled(
    matches.map((webhook) =>
      deliverWebhookEvent({ db, webhook, eventId, eventType, workspaceId, data }).catch((err) =>
        console.error(`[WebhookDelivery] Delivery failed for webhook ${webhook.id}:`, err),
      ),
    ),
  );
}

export interface RetryFailedWebhookDeliveriesResult {
  attempted: number;
  succeeded: number;
}

/**
 * Cron sweep — retries failed deliveries whose `nextRetryAt` is due, up to
 * `maxRetries` attempts per delivery with exponential backoff. Intended to be
 * called once per tenant workspace from `apps/workers/integration-webhook-worker`'s
 * scheduled handler (piggy-backed on its existing 10-minute poll cron — see
 * that worker's `retryFailedWebhookDeliveries` wiring in `scheduled()`).
 */
export async function retryFailedWebhookDeliveries(
  db: TenantDb,
): Promise<RetryFailedWebhookDeliveriesResult> {
  const now = new Date();
  const due = await db
    .select({ delivery: webhookDeliveries, webhook: externalWebhooks })
    .from(webhookDeliveries)
    .innerJoin(externalWebhooks, eq(webhookDeliveries.webhookId, externalWebhooks.id))
    .where(
      and(
        eq(webhookDeliveries.status, 'failed'),
        isNull(externalWebhooks.deletedAt),
        eq(externalWebhooks.status, 'active'),
        lte(webhookDeliveries.nextRetryAt, now),
        sql`${webhookDeliveries.attemptNumber} < ${webhookDeliveries.maxRetries}`,
      ),
    )
    .limit(50);

  let succeeded = 0;

  for (const { delivery, webhook } of due as { delivery: DeliveryRow; webhook: WebhookRow }[]) {
    const payload = delivery.payload as { id: string; type: string; workspaceId: string; data: Record<string, unknown> };
    const body = JSON.stringify({ ...payload, timestamp: new Date().toISOString() });
    const attempt = await attemptDelivery(webhook, body, delivery.eventType);

    const nextAttemptNumber = delivery.attemptNumber + 1;
    const maxRetries = delivery.maxRetries ?? MAX_RETRY_ATTEMPTS;
    const exhausted = nextAttemptNumber >= maxRetries;
    const backoffMs = RETRY_BASE_DELAY_MS * 2 ** (nextAttemptNumber - 1);
    const retryNow = new Date();

    await db.insert(webhookDeliveries).values({
      id: generateDeliveryId(),
      webhookId: webhook.id,
      eventType: delivery.eventType,
      eventId: delivery.eventId,
      payload: delivery.payload,
      status: attempt.ok ? 'delivered' : exhausted ? 'failed' : 'retrying',
      responseStatus: attempt.status,
      responseBody: attempt.body,
      responseTimeMs: attempt.durationMs,
      attemptNumber: nextAttemptNumber,
      nextRetryAt: attempt.ok || exhausted ? null : new Date(retryNow.getTime() + backoffMs),
      maxRetries,
      errorMessage: attempt.error,
      createdAt: retryNow,
      deliveredAt: attempt.ok ? retryNow : null,
    });

    // Clear the superseded row's nextRetryAt so the sweep query never re-matches it —
    // the new attempt row above is now the live record for this delivery lineage.
    await db
      .update(webhookDeliveries)
      .set({ nextRetryAt: null })
      .where(eq(webhookDeliveries.id, delivery.id));

    await applyDeliveryOutcome(db, webhook, attempt.ok, attempt.error);
    if (attempt.ok) succeeded++;
  }

  return { attempted: due.length, succeeded };
}
