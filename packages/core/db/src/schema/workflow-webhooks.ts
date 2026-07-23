import {
  pgTable,
  varchar,
  text,
  timestamp,
  boolean,
  integer,
  jsonb,
  index,
} from 'drizzle-orm/pg-core';
export const workflowWebhooks = pgTable('workflow_webhooks', {
  // BaseEntity fields
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  deletedAt: timestamp('deleted_at'),

  // Workflow Reference
  workflowId: varchar('workflow_id', { length: 30 }).notNull(),
  triggerId: varchar('trigger_id', { length: 30 }), // Reference to workflow_triggers

  // Webhook Info
  name: varchar('name', { length: 255 }).notNull(),
  description: text('description'),

  // URL Configuration
  url: varchar('url', { length: 500 }), // Auto-generated webhook URL path
  externalUrl: text('external_url'), // Full external URL including domain

  // Security
  secret: varchar('secret', { length: 255 }), // For signature validation
  secretHash: varchar('secret_hash', { length: 255 }), // Hashed version for storage
  validateSignature: boolean('validate_signature').default(false),
  signatureHeader: varchar('signature_header', { length: 100 }).default('x-webhook-signature'),

  // Request Configuration
  allowedMethods: jsonb('allowed_methods').$type<string[]>().default(['POST']),
  headers: jsonb('headers').$type<Record<string, string>>(),
  ipWhitelist: jsonb('ip_whitelist').$type<string[]>(),

  // Status
  isEnabled: boolean('is_enabled').notNull().default(true),

  // Tracking
  lastCalledAt: timestamp('last_called_at'),
  lastCallStatus: varchar('last_call_status', { length: 20 }),
  lastCallIp: varchar('last_call_ip', { length: 50 }),

  // Statistics
  totalCalls: integer('total_calls').default(0),
  successfulCalls: integer('successful_calls').default(0),
  failedCalls: integer('failed_calls').default(0),
}, (table) => [
  index('workflow_webhooks_workflow_idx').on(table.workflowId),
  index('workflow_webhooks_url_idx').on(table.url),
  index('workflow_webhooks_is_enabled_idx').on(table.isEnabled),
]);

export type WorkflowWebhook = typeof workflowWebhooks.$inferSelect;
export type NewWorkflowWebhook = typeof workflowWebhooks.$inferInsert;
