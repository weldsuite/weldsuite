import {
  pgTable,
  varchar,
  timestamp,
  boolean,
  integer,
  numeric,
  jsonb,
  text,
  index,
} from 'drizzle-orm/pg-core';

export interface Money {
  amount: number;
  currency: string;
}

export type WalletTransactionType =
  | 'credit'
  | 'debit'
  | 'refund'
  | 'adjustment'
  | 'shipping_charge'
  | 'label_purchase'
  | 'pickup_charge'
  | 'insurance_charge';

// Wallets
export const wallets = pgTable('wallets', {
  // BaseEntity fields
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  deletedAt: timestamp('deleted_at'),

  // Owner
  userId: varchar('user_id', { length: 255 }),
  userName: varchar('user_name', { length: 255 }),

  // Balance
  balance: numeric('balance', { precision: 18, scale: 2 }).notNull().default('0'),
  currency: varchar('currency', { length: 3 }).default('EUR'),

  // Limits
  creditLimit: numeric('credit_limit', { precision: 18, scale: 2 }),
  lowBalanceThreshold: numeric('low_balance_threshold', { precision: 18, scale: 2 }),

  // Status
  isActive: boolean('is_active').default(true),
  isFrozen: boolean('is_frozen').default(false),

  // Statistics
  totalCredits: numeric('total_credits', { precision: 18, scale: 2 }).default('0'),
  totalDebits: numeric('total_debits', { precision: 18, scale: 2 }).default('0'),
  transactionCount: integer('transaction_count').default(0),
  lastTransactionAt: timestamp('last_transaction_at'),
}, (table) => [
  index('wallets_user_id_idx').on(table.userId),
  index('wallets_is_active_idx').on(table.isActive),
]);

export type Wallet = typeof wallets.$inferSelect;
export type NewWallet = typeof wallets.$inferInsert;

// Wallet Transactions
export const walletTransactions = pgTable('wallet_transactions', {
  // BaseEntity fields
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),

  // Wallet Reference
  walletId: varchar('wallet_id', { length: 30 }).notNull(),
  userId: varchar('user_id', { length: 255 }),

  // Transaction Type
  type: varchar('type', { length: 30 }).notNull(),

  // Amount
  amount: numeric('amount', { precision: 18, scale: 2 }).notNull(),
  currency: varchar('currency', { length: 3 }).default('EUR'),

  // Balance Tracking
  balanceBefore: numeric('balance_before', { precision: 18, scale: 2 }),
  balanceAfter: numeric('balance_after', { precision: 18, scale: 2 }),

  // Reference
  referenceType: varchar('reference_type', { length: 50 }), // 'parcel', 'pickup', 'order', etc.
  referenceId: varchar('reference_id', { length: 30 }),

  // Description
  description: text('description'),
  notes: text('notes'),

  // Metadata
  metadata: jsonb('metadata').$type<Record<string, unknown>>(),

  // Processing
  processedBy: varchar('processed_by', { length: 255 }),
  processedAt: timestamp('processed_at'),
}, (table) => [
  index('wallet_transactions_wallet_id_idx').on(table.walletId),
  index('wallet_transactions_user_id_idx').on(table.userId),
  index('wallet_transactions_type_idx').on(table.type),
  index('wallet_transactions_created_at_idx').on(table.createdAt),
]);

export type WalletTransaction = typeof walletTransactions.$inferSelect;
export type NewWalletTransaction = typeof walletTransactions.$inferInsert;
