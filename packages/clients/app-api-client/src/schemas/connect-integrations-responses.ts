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

// ── /api/integrations ───────────────────────────────────────────────────────

/** An `integration_connections` row, as the object CRUD answers it. */
export const integrationConnectionRowSchema = z
  .object({
    id: z.string(),
    createdAt: timestamp,
    updatedAt: timestamp,
    deletedAt: nullableTimestamp,
    provider: z.string(),
    name: z.string().nullable(),
    status: z.string(),
    direction: z.string(),
    externalAccountId: z.string().nullable(),
    oauthTokens: z.unknown(),
    webhookId: z.string().nullable(),
    webhookSecret: z.string().nullable(),
    settings: z.unknown(),
    syncSettings: z.unknown(),
    fieldMappings: z.unknown(),
    entityConfig: z.unknown(),
    syncCursor: z.unknown(),
    conflictStrategy: z.string(),
    lastSyncAt: nullableTimestamp,
    lastSyncStatus: z.string().nullable(),
    lastError: z.string().nullable(),
    lastErrorAt: nullableTimestamp,
    companiesSynced: z.number(),
    peopleSynced: z.number(),
    tasksSynced: z.number(),
    listsSynced: z.number(),
    leadsSynced: z.number(),
    opportunitiesSynced: z.number(),
    activitiesSynced: z.number(),
    connectedAt: nullableTimestamp,
    connectedBy: z.string().nullable(),
    triggerScheduleId: z.string().nullable(),
  })
  .strict();

/** A connection without its tokens and webhook secret. */
export const integrationConnectionSchema = integrationConnectionRowSchema
  .omit({ oauthTokens: true, webhookSecret: true })
  .strict();

/** A `sync_logs` row. */
export const syncLogSchema = z
  .object({ id: z.string(), connectionId: z.string(), status: z.string(), createdAt: timestamp })
  .passthrough();

export const integrationConnectionDetailSchema = integrationConnectionSchema
  .extend({ recentLogs: z.array(syncLogSchema) })
  .strict();

export const integrationConnectedSchema = z
  .object({
    id: z.string(),
    provider: z.string(),
    name: z.string().optional(),
    status: z.string(),
    connectedAt: timestamp,
  })
  .strict();

export const integrationAuthorizeSchema = z.object({ authorizeUrl: z.string(), state: z.string() }).strict();
export const integrationIdSchema = z.object({ id: z.string() }).strict();
export const integrationUpdatedSchema = z.object({ id: z.string(), updated: z.literal(true) }).strict();
export const integrationMessageSchema = z.object({ message: z.string() }).strict();
export const integrationResolvedSchema = z.object({ resolved: z.literal(true) }).strict();

export const mcpToolsSchema = z
  .object({
    tools: z.array(
      z
        .object({ name: z.string().optional(), description: z.string(), inputSchema: z.record(z.unknown()) })
        .strict(),
    ),
    lastDiscoveredAt: timestamp,
  })
  .strict();

export const integrationTestSchema = z
  .object({
    connected: z.boolean(),
    status: z.number().optional(),
    error: z.string().optional(),
    message: z.string().optional(),
  })
  .strict();

/** An `integration_field_mappings` row. */
export const integrationFieldMappingSchema = z
  .object({
    id: z.string(),
    createdAt: timestamp,
    updatedAt: timestamp,
    connectionId: z.string(),
    entityType: z.string(),
    externalFieldPath: z.string(),
    internalFieldPath: z.string(),
    direction: z.string(),
    transformType: z.string(),
    transformConfig: z.record(z.unknown()).nullable(),
    isRequired: z.boolean(),
    isDefault: z.boolean(),
    position: z.number(),
  })
  .strict();

/** A provider's default mapping (`FieldMappingDefinition`). */
export const integrationDefaultMappingSchema = z
  .object({
    externalFieldPath: z.string(),
    internalFieldPath: z.string(),
    direction: z.string(),
    transformType: z.string(),
    transformConfig: z.record(z.unknown()).optional(),
    isRequired: z.boolean().optional(),
  })
  .strict();

export const integrationMappingsReplacedSchema = z.object({ entityType: z.string(), count: z.number() }).strict();

/** An `integration_sync_conflicts` row. */
export const integrationSyncConflictSchema = z
  .object({
    id: z.string(),
    createdAt: timestamp,
    connectionId: z.string(),
    entityType: z.string(),
    internalEntityId: z.string(),
    externalEntityId: z.string(),
    conflictType: z.string(),
    internalData: z.record(z.unknown()),
    externalData: z.record(z.unknown()),
    conflictFields: z.array(z.string()).nullable(),
    resolution: z.string(),
    resolvedAt: nullableTimestamp,
    resolvedBy: z.string().nullable(),
  })
  .strict();

/** An `integration_entity_mappings` row. */
export const integrationEntityMappingSchema = z
  .object({
    id: z.string(),
    connectionId: z.string(),
    externalEntityType: z.string(),
    externalEntityId: z.string(),
    internalEntityType: z.string(),
    internalEntityId: z.string(),
  })
  .passthrough();

/** WeldAds' sync result, and a skipped Meta event. */
export const adSyncResultSchema = z
  .object({
    syncedCampaigns: z.number(),
    writtenCampaigns: z.number(),
    pushed: z.number(),
    failed: z.number(),
    pulled: z.number(),
  })
  .strict();

export const adEventResultSchema = z.union([
  adSyncResultSchema,
  z.object({ skipped: z.literal(true), reason: z.string() }).strict(),
]);
