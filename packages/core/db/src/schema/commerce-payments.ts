import { sql } from 'drizzle-orm';
import {
  pgTable,
  varchar,
  text,
  timestamp,
  boolean,
  jsonb,
  numeric,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

// WeldCommerce payments (rebuild, phase 5; ADR COM-013).
// A payment provider port with Mollie first, on each workspace's own Mollie
// account through Mollie Connect. WeldSuite never holds the funds.

export type CommercePaymentProvider = 'mollie' | (string & {});
export type CommercePaymentStatus =
  | 'open'
  | 'pending'
  | 'authorized'
  | 'paid'
  | 'failed'
  | 'canceled'
  | 'expired';
export type CommerceRefundStatus = 'pending' | 'queued' | 'processing' | 'refunded' | 'failed' | 'canceled';
export type CommerceConnectionStatus = 'connected' | 'needs_reauth' | 'disconnected';

// The workspace's connection to a payment provider. At most one live row per
// provider. `id` is the connection id in the webhook URL
// `/webhooks/commerce/mollie/:connectionId`; the master `commerce_connection_registry`
// row with the same id maps it to the workspace, because the webhook has no auth.
export const commercePaymentConnections = pgTable('commerce_payment_connections', {
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  deletedAt: timestamp('deleted_at'),

  provider: varchar('provider', { length: 30 }).$type<CommercePaymentProvider>().notNull().default('mollie'),
  // 'oauth' (Mollie Connect) | 'api_key' (manual fallback, COM-013)
  authMethod: varchar('auth_method', { length: 10 }).notNull().default('oauth'),
  // 'connected' | 'needs_reauth' | 'disconnected'
  status: varchar('status', { length: 20 }).$type<CommerceConnectionStatus>().notNull().default('connected'),

  // Ciphertext (`weldsuite_db::crypto::encrypt_field`); never leaves the server, see
  // SENSITIVE_COLUMNS in `lib/sensitive-columns.ts`.
  accessTokenEncrypted: text('access_token_encrypted'),
  refreshTokenEncrypted: text('refresh_token_encrypted'),
  apiKeyEncrypted: text('api_key_encrypted'),
  tokenExpiresAt: timestamp('token_expires_at'),
  scope: text('scope'),

  // Mollie website profile and organisation.
  profileId: varchar('profile_id', { length: 50 }),
  profileName: varchar('profile_name', { length: 255 }),
  organizationId: varchar('organization_id', { length: 50 }),
  organizationName: varchar('organization_name', { length: 255 }),
  testmode: boolean('testmode').notNull().default(false),

  connectedBy: varchar('connected_by', { length: 255 }),
  connectedAt: timestamp('connected_at'),
  disconnectedAt: timestamp('disconnected_at'),
  lastError: text('last_error'),
}, (table) => [
  uniqueIndex('commerce_payment_connections_provider_uidx')
    .on(table.provider)
    .where(sql`${table.deletedAt} IS NULL`),
]);

export type CommercePaymentConnection = typeof commercePaymentConnections.$inferSelect;
export type NewCommercePaymentConnection = typeof commercePaymentConnections.$inferInsert;

// One row per payment attempt: an order can have a failed attempt and a retry.
export const commercePayments = pgTable('commerce_payments', {
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),

  orderId: varchar('order_id', { length: 30 }).notNull(),
  connectionId: varchar('connection_id', { length: 30 }),
  provider: varchar('provider', { length: 30 }).$type<CommercePaymentProvider>().notNull().default('mollie'),
  // Mollie `tr_...`
  providerPaymentId: varchar('provider_payment_id', { length: 100 }),
  // 'open' | 'pending' | 'authorized' | 'paid' | 'failed' | 'canceled' | 'expired'
  status: varchar('status', { length: 20 }).$type<CommercePaymentStatus>().notNull().default('open'),
  amount: numeric('amount', { precision: 18, scale: 2 }).notNull(),
  currency: varchar('currency', { length: 3 }).notNull(),
  // 'ideal' | 'creditcard' | 'bancontact' | ...; set once the shopper chose.
  method: varchar('method', { length: 50 }),
  checkoutUrl: text('checkout_url'),
  redirectUrl: text('redirect_url'),
  testmode: boolean('testmode').notNull().default(false),
  // Sum of the refunds that went through.
  amountRefunded: numeric('amount_refunded', { precision: 18, scale: 2 }).notNull().default('0'),
  failureReason: text('failure_reason'),
  // The last payment as the provider returned it (read-back), for support.
  providerData: jsonb('provider_data').$type<Record<string, unknown>>(),
  // Makes creating the payment at the provider safe to retry.
  idempotencyKey: varchar('idempotency_key', { length: 100 }),

  expiresAt: timestamp('expires_at'),
  paidAt: timestamp('paid_at'),
  failedAt: timestamp('failed_at'),
  canceledAt: timestamp('canceled_at'),
  expiredAt: timestamp('expired_at'),
}, (table) => [
  index('commerce_payments_order_idx').on(table.orderId),
  index('commerce_payments_status_idx').on(table.status),
  uniqueIndex('commerce_payments_provider_payment_uidx')
    .on(table.provider, table.providerPaymentId)
    .where(sql`${table.providerPaymentId} IS NOT NULL`),
  uniqueIndex('commerce_payments_idempotency_key_uidx')
    .on(table.idempotencyKey)
    .where(sql`${table.idempotencyKey} IS NOT NULL`),
]);

export type CommercePayment = typeof commercePayments.$inferSelect;
export type NewCommercePayment = typeof commercePayments.$inferInsert;

export const commerceRefunds = pgTable('commerce_refunds', {
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),

  orderId: varchar('order_id', { length: 30 }).notNull(),
  paymentId: varchar('payment_id', { length: 30 }).notNull(),
  provider: varchar('provider', { length: 30 }).$type<CommercePaymentProvider>().notNull().default('mollie'),
  // Mollie `re_...`
  providerRefundId: varchar('provider_refund_id', { length: 100 }),
  // 'pending' | 'queued' | 'processing' | 'refunded' | 'failed' | 'canceled'
  status: varchar('status', { length: 20 }).$type<CommerceRefundStatus>().notNull().default('pending'),
  amount: numeric('amount', { precision: 18, scale: 2 }).notNull(),
  currency: varchar('currency', { length: 3 }).notNull(),
  reason: text('reason'),
  // The WeldBooks credit note this refund became.
  creditNoteId: varchar('credit_note_id', { length: 30 }),
  createdBy: varchar('created_by', { length: 255 }),
  idempotencyKey: varchar('idempotency_key', { length: 100 }),
  refundedAt: timestamp('refunded_at'),
  failedAt: timestamp('failed_at'),
}, (table) => [
  index('commerce_refunds_order_idx').on(table.orderId),
  index('commerce_refunds_payment_idx').on(table.paymentId),
  uniqueIndex('commerce_refunds_provider_refund_uidx')
    .on(table.provider, table.providerRefundId)
    .where(sql`${table.providerRefundId} IS NOT NULL`),
  uniqueIndex('commerce_refunds_idempotency_key_uidx')
    .on(table.idempotencyKey)
    .where(sql`${table.idempotencyKey} IS NOT NULL`),
]);

export type CommerceRefund = typeof commerceRefunds.$inferSelect;
export type NewCommerceRefund = typeof commerceRefunds.$inferInsert;
