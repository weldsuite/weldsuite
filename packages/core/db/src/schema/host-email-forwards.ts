import {
  pgTable,
  varchar,
  timestamp,
  boolean,
  pgEnum,
  jsonb,
  index,
} from 'drizzle-orm/pg-core';
import { hostDomains } from './host-domains';

// Email forward status enum
export const hostEmailForwardStatusEnum = pgEnum('host_email_forward_status', [
  'active',
  'pending',
  'disabled',
  'error',
]);

// Email Forwards table
export const hostEmailForwards = pgTable('email_forwards', {
  id: varchar('id', { length: 30 }).primaryKey(),
  domainId: varchar('domain_id', { length: 30 }).notNull().references(() => hostDomains.id),

  // Source email (the forwarding address)
  source: varchar('source', { length: 255 }).notNull(), // e.g., "info" or "info@example.com"

  // Destination email(s)
  destination: varchar('destination', { length: 500 }).notNull(), // Target email address
  additionalDestinations: jsonb('additional_destinations').$type<string[]>(), // Multiple destinations

  // Settings
  enabled: boolean('enabled').notNull().default(true),
  catchAll: boolean('catch_all').default(false), // Forward all unmatched addresses
  wildcard: boolean('wildcard').default(false), // Support wildcard patterns

  // Status
  status: hostEmailForwardStatusEnum('status').notNull().default('active'),
  lastForwardedAt: timestamp('last_forwarded_at'),
  forwardCount: jsonb('forward_count').$type<number>().default(0),

  // Error tracking
  lastError: varchar('last_error', { length: 1000 }),
  lastErrorAt: timestamp('last_error_at'),
  errorCount: jsonb('error_count').$type<number>().default(0),

  // Metadata
  metadata: jsonb('metadata').$type<Record<string, unknown>>(),

  // Timestamps
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  deletedAt: timestamp('deleted_at'),
}, (table) => [
  index('email_forwards_domain_id_idx').on(table.domainId),
  index('email_forwards_source_idx').on(table.source),
  index('email_forwards_enabled_idx').on(table.enabled),
]);

export type HostEmailForward = typeof hostEmailForwards.$inferSelect;
export type NewHostEmailForward = typeof hostEmailForwards.$inferInsert;
