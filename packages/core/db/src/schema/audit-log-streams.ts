import {
  pgTable,
  varchar,
  timestamp,
  integer,
  text,
  jsonb,
  index,
} from 'drizzle-orm/pg-core';

/**
 * Where a workspace's audit log is pushed:
 *   - `splunk_hec`: a Splunk HTTP Event Collector (`Authorization: Splunk <token>`).
 *   - `http`: any HTTPS collector that takes JSON (Datadog, Elastic, Sumo Logic, …).
 */
export const AUDIT_LOG_STREAM_TYPES = ['splunk_hec', 'http'] as const;
export type AuditLogStreamType = (typeof AUDIT_LOG_STREAM_TYPES)[number];

/**
 *   - `active`: delivering.
 *   - `paused`: switched off by a member.
 *   - `disabled`: switched off by the platform after too many failed deliveries.
 */
export const AUDIT_LOG_STREAM_STATUSES = ['active', 'paused', 'disabled'] as const;
export type AuditLogStreamStatus = (typeof AUDIT_LOG_STREAM_STATUSES)[number];

export const AUDIT_LOG_STREAM_FORMATS = ['json', 'ndjson'] as const;
export type AuditLogStreamFormat = (typeof AUDIT_LOG_STREAM_FORMATS)[number];

export interface AuditLogStreamSettings {
  /** Splunk: index, source, sourcetype and host of the events. */
  index?: string;
  source?: string;
  sourcetype?: string;
  host?: string;
  /** `http`: the header the token is sent in. Default `Authorization`. */
  authHeader?: string;
  /** `http`: one JSON document `{ "events": [...] }` (default) or one JSON object per line. */
  format?: AuditLogStreamFormat;
}

/**
 * An audit log stream: a destination the workspace's audit events are pushed
 * to (a SIEM).
 *
 * Delivery reads `audit_logs` forward from the cursor, so the stream is in
 * order and at-least-once: a failed batch is sent again, and a destination
 * that was down catches up. The cursor is `(cursorCreatedAt, cursorId)`, the
 * last row delivered; a new stream starts at the moment it was created.
 */
export const auditLogStreams = pgTable(
  'audit_log_streams',
  {
    id: varchar('id', { length: 30 }).primaryKey(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),

    name: varchar('name', { length: 255 }).notNull(),
    type: varchar('type', { length: 20 }).$type<AuditLogStreamType>().notNull(),
    url: text('url').notNull(),
    /**
     * The collector's token (field-encrypted, never returned by the API):
     * the HEC token for Splunk, the value of the auth header for `http`.
     */
    tokenEncrypted: text('token_encrypted'),
    settings: jsonb('settings').$type<AuditLogStreamSettings>(),

    status: varchar('status', { length: 20 }).$type<AuditLogStreamStatus>().notNull().default('active'),

    /** The last audit_logs row delivered. */
    cursorCreatedAt: timestamp('cursor_created_at'),
    cursorId: varchar('cursor_id', { length: 30 }),

    lastDeliveredAt: timestamp('last_delivered_at'),
    lastAttemptAt: timestamp('last_attempt_at'),
    lastError: text('last_error'),
    consecutiveFailures: integer('consecutive_failures').notNull().default(0),
    deliveredCount: integer('delivered_count').notNull().default(0),

    createdById: varchar('created_by_id', { length: 255 }),
  },
  (table) => [index('audit_log_streams_status_idx').on(table.status)],
);

export type AuditLogStream = typeof auditLogStreams.$inferSelect;
export type NewAuditLogStream = typeof auditLogStreams.$inferInsert;
