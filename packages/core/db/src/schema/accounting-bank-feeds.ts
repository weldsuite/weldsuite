import {
  pgTable,
  varchar,
  timestamp,
  date,
  integer,
  numeric,
  text,
  jsonb,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

/**
 * A link to a bank through an aggregator (`@weldsuite/bank-feeds`): Plaid,
 * Stripe Financial Connections, Teller, Ponto, Enable Banking. One connection
 * can feed several bank accounts (`bank_accounts.feed_connection_id`).
 */
export const bankConnections = pgTable('bank_connections', {
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  deletedAt: timestamp('deleted_at'),

  entityId: varchar('entity_id', { length: 30 }).notNull(),
  provider: varchar('provider', { length: 30 }).notNull(),
  /** Plaid item id, Stripe FC account-holder session, Ponto organisation, ... */
  providerConnectionId: varchar('provider_connection_id', { length: 255 }).notNull(),
  institutionId: varchar('institution_id', { length: 100 }),
  institutionName: varchar('institution_name', { length: 255 }),
  /** active | reauth_required | expiring | revoked | disconnected | error */
  status: varchar('status', { length: 20 }).notNull().default('active'),
  /** AES-GCM blob of the provider's access token(s). Never returned. */
  credentialsEncrypted: text('credentials_encrypted'),
  /** Opaque provider cursor (Plaid transactions/sync cursor, last polled date, ...). */
  syncCursor: jsonb('sync_cursor').$type<unknown>(),
  lastSyncedAt: timestamp('last_synced_at'),
  lastError: text('last_error'),
  consentExpiresAt: timestamp('consent_expires_at'),
  historyDays: integer('history_days'),
  createdBy: varchar('created_by', { length: 255 }),
  metadata: jsonb('metadata').$type<Record<string, unknown>>(),
}, (table) => [
  index('acct_bank_connections_entity_idx').on(table.entityId),
  uniqueIndex('acct_bank_connections_provider_uidx').on(table.provider, table.providerConnectionId),
]);

/**
 * Pending feed transactions. They show in the feed but never become
 * reconcilable `bank_transactions`; the posted transaction replaces them
 * (Plaid links it through `pending_transaction_id`), and unmatched rows are
 * voided after 14 days.
 */
export const bankFeedPendingTransactions = pgTable('bank_feed_pending_transactions', {
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),

  entityId: varchar('entity_id', { length: 30 }).notNull(),
  bankAccountId: varchar('bank_account_id', { length: 30 }).notNull(),
  connectionId: varchar('connection_id', { length: 30 }).notNull(),
  provider: varchar('provider', { length: 30 }).notNull(),
  providerTransactionId: varchar('provider_transaction_id', { length: 255 }).notNull(),
  date: date('date').notNull(),
  /** Statement convention: money in positive, money out negative. */
  amount: numeric('amount', { precision: 18, scale: 2 }).notNull(),
  currency: varchar('currency', { length: 3 }).notNull(),
  description: text('description'),
  merchantName: varchar('merchant_name', { length: 255 }),
  voidedAt: timestamp('voided_at'),
}, (table) => [
  index('acct_bank_feed_pending_account_idx').on(table.bankAccountId),
  uniqueIndex('acct_bank_feed_pending_provider_uidx').on(table.provider, table.providerTransactionId),
]);

export type BankConnection = typeof bankConnections.$inferSelect;
export type NewBankConnection = typeof bankConnections.$inferInsert;
export type BankFeedPendingTransaction = typeof bankFeedPendingTransactions.$inferSelect;
export type NewBankFeedPendingTransaction = typeof bankFeedPendingTransactions.$inferInsert;
