import {
  pgTable,
  varchar,
  text,
  timestamp,
  pgEnum,
  jsonb,
  index,
} from 'drizzle-orm/pg-core';
import { hostDomains } from './host-domains';

// Transfer type enum
export const hostDomainTransferTypeEnum = pgEnum('host_domain_transfer_type', [
  'incoming',
  'outgoing',
]);

// Transfer status enum
export const hostDomainTransferStatusEnum = pgEnum('host_domain_transfer_status', [
  'pending',
  'pending_approval',
  'approved',
  'rejected',
  'cancelled',
  'in_progress',
  'completed',
  'failed',
]);

// Domain Transfers table
export const hostDomainTransfers = pgTable('domain_transfers', {
  id: varchar('id', { length: 30 }).primaryKey(),
  domainId: varchar('domain_id', { length: 30 }).references(() => hostDomains.id), // May be null for incoming transfers initially

  // Domain info
  domainName: varchar('domain_name', { length: 255 }).notNull(),

  // Transfer details
  type: hostDomainTransferTypeEnum('type').notNull(),
  status: hostDomainTransferStatusEnum('status').notNull().default('pending'),

  // Auth code
  authCode: varchar('auth_code', { length: 255 }), // EPP auth code

  // Registrar info
  fromRegistrar: varchar('from_registrar', { length: 255 }),
  toRegistrar: varchar('to_registrar', { length: 255 }),

  // External IDs
  externalTransferId: varchar('external_transfer_id', { length: 255 }), // ID at registrar

  // Timeline
  requestedAt: timestamp('requested_at').notNull().defaultNow(),
  approvedAt: timestamp('approved_at'),
  rejectedAt: timestamp('rejected_at'),
  cancelledAt: timestamp('cancelled_at'),
  completedAt: timestamp('completed_at'),
  expiresAt: timestamp('expires_at'), // Transfer request expiration

  // Additional info
  rejectionReason: text('rejection_reason'),
  cancellationReason: text('cancellation_reason'),
  failureReason: text('failure_reason'),

  // Notifications
  notificationsSent: jsonb('notifications_sent').$type<string[]>(), // Track sent notifications

  // Metadata
  registrarResponse: jsonb('registrar_response').$type<Record<string, unknown>>(), // Raw registrar response
  metadata: jsonb('metadata').$type<Record<string, unknown>>(),

  // Timestamps
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
}, (table) => [
  index('domain_transfers_domain_id_idx').on(table.domainId),
  index('domain_transfers_domain_name_idx').on(table.domainName),
  index('domain_transfers_status_idx').on(table.status),
  index('domain_transfers_type_idx').on(table.type),
  index('domain_transfers_external_transfer_id_idx').on(table.externalTransferId),
]);

export type HostDomainTransfer = typeof hostDomainTransfers.$inferSelect;
export type NewHostDomainTransfer = typeof hostDomainTransfers.$inferInsert;
