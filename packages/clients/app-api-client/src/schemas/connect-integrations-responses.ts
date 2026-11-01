/**
 * Response shapes of connect-api's integration routes (outbound external
 * webhooks, CRM/MCP integration connections, store and accounting
 * connectors), matching what the routes answer: rows as Drizzle reads them
 * (ISO timestamps). Used by the conformance harness to check both backends'
 * answers (`packages/core/worker-kit/src/testing/conformance-schemas-connect.ts`).
 */

import { z } from 'zod';

const timestamp = z.string();
const nullableTimestamp = z.string().nullable();

// ── /api/external-webhooks ──────────────────────────────────────────────────

/** An `external_webhooks` row without its secret (`toPublic`). */
export const externalWebhookSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    description: z.string().nullable(),
    url: z.string(),
    events: z.array(z.string()),
    headers: z.record(z.string()).nullable(),
    status: z.string(),
    consecutiveFailures: z.number().nullable(),
    lastFailedAt: nullableTimestamp,
    lastFailureReason: z.string().nullable(),
    lastDeliveredAt: nullableTimestamp,
    totalDeliveries: z.number().nullable(),
    totalFailures: z.number().nullable(),
    createdBy: z.string(),
    createdAt: timestamp,
    updatedAt: timestamp,
    deletedAt: nullableTimestamp,
  })
  .strict();

/** Create and rotate answer the secret, once. */
export const externalWebhookWithSecretSchema = externalWebhookSchema.extend({ secret: z.string() }).strict();

/** One entry of the event picker. */
export const externalWebhookEventSchema = z
  .object({
    event: z.string(),
    entity: z.string(),
    action: z.string(),
    label: z.string().optional(),
  })
  .strict();

/** A `webhook_deliveries` row. */
export const webhookDeliverySchema = z
  .object({
    id: z.string(),
    webhookId: z.string(),
    eventType: z.string(),
    eventId: z.string(),
    payload: z.record(z.unknown()),
    status: z.string(),
    responseStatus: z.number().nullable(),
    responseBody: z.string().nullable(),
    responseTimeMs: z.number().nullable(),
    attemptNumber: z.number(),
    nextRetryAt: nullableTimestamp,
    maxRetries: z.number().nullable(),
    errorMessage: z.string().nullable(),
    createdAt: timestamp,
    deliveredAt: nullableTimestamp,
  })
  .strict();

/** `POST /:id/test`. */
export const webhookTestResultSchema = z
  .object({
    delivered: z.boolean(),
    responseStatus: z.number().nullable(),
    responseBody: z.string().nullable(),
    errorMessage: z.string().nullable(),
  })
  .strict();
