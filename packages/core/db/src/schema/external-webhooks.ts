import { pgTable, varchar, text, timestamp, jsonb, integer, index } from 'drizzle-orm/pg-core';

/**
 * External webhook subscriptions
 * Allows customers to receive webhook notifications for events in their workspace
 */
export const externalWebhooks = pgTable(
  'external_webhooks',
  {
    id: varchar('id', { length: 30 }).primaryKey(),

    // Webhook configuration
    name: varchar('name', { length: 255 }).notNull(),
    description: text('description'),
    url: text('url').notNull(),

    // Events to subscribe to (array of event types)
    // e.g., ['crm.contact.created', 'crm.customer.updated']
    events: jsonb('events').$type<string[]>().notNull().default([]),

    // Security - secret for HMAC signature verification
    secret: varchar('secret', { length: 255 }).notNull(),

    // Custom headers to include in webhook requests
    headers: jsonb('headers').$type<Record<string, string>>(),

    // Status: active, paused, disabled
    status: varchar('status', { length: 20 }).notNull().default('active'),

    // Failure tracking
    consecutiveFailures: integer('consecutive_failures').default(0),
    lastFailedAt: timestamp('last_failed_at', { withTimezone: true }),
    lastFailureReason: text('last_failure_reason'),

    // Success tracking
    lastDeliveredAt: timestamp('last_delivered_at', { withTimezone: true }),
    totalDeliveries: integer('total_deliveries').default(0),
    totalFailures: integer('total_failures').default(0),

    // Created by (user ID who created the webhook)
    createdBy: varchar('created_by', { length: 255 }).notNull(),

    // Timestamps
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [
    index('external_webhooks_status_idx').on(table.status),
  ]
);

/**
 * Webhook delivery log
 * Tracks each delivery attempt for auditing and retry logic
 */
export const webhookDeliveries = pgTable(
  'webhook_deliveries',
  {
    id: varchar('id', { length: 30 }).primaryKey(),
    webhookId: varchar('webhook_id', { length: 30 }).notNull(),

    // Event info
    eventType: varchar('event_type', { length: 100 }).notNull(),
    eventId: varchar('event_id', { length: 50 }).notNull(), // Idempotency key

    // Payload sent
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),

    // Delivery status: pending, delivered, failed, retrying
    status: varchar('status', { length: 20 }).notNull().default('pending'),

    // Response from endpoint
    responseStatus: integer('response_status'),
    responseBody: text('response_body'),
    responseTimeMs: integer('response_time_ms'),

    // Retry info
    attemptNumber: integer('attempt_number').notNull().default(1),
    nextRetryAt: timestamp('next_retry_at', { withTimezone: true }),
    maxRetries: integer('max_retries').default(5),

    // Error info
    errorMessage: text('error_message'),

    // Timestamps
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
  },
  (table) => [
    index('webhook_deliveries_webhook_idx').on(table.webhookId),
    index('webhook_deliveries_status_idx').on(table.status),
    index('webhook_deliveries_event_idx').on(table.eventId),
    index('webhook_deliveries_retry_idx').on(table.nextRetryAt),
  ]
);

// Type exports
export type ExternalWebhook = typeof externalWebhooks.$inferSelect;
export type NewExternalWebhook = typeof externalWebhooks.$inferInsert;
export type WebhookDelivery = typeof webhookDeliveries.$inferSelect;
export type NewWebhookDelivery = typeof webhookDeliveries.$inferInsert;

// Webhook status types
export type WebhookStatus = 'active' | 'paused' | 'disabled';
export type DeliveryStatus = 'pending' | 'delivered' | 'failed' | 'retrying';
