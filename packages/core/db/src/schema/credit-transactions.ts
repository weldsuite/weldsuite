import {
  pgTable,
  varchar,
  timestamp,
  integer,
  numeric,
  text,
  jsonb,
  index,
  pgEnum,
} from 'drizzle-orm/pg-core';

/**
 * Credit transaction types
 */
export const creditTransactionTypeEnum = pgEnum('credit_transaction_type', [
  'monthly_allocation',  // Monthly credits added
  'rollover',            // Rolled over from previous period
  'purchase',            // Purchased additional credits
  'consumption',         // Used for a service
  'refund',              // Refunded (e.g., failed label)
  'expiry',              // Expired credits over rollover cap
  'adjustment',          // Manual admin adjustment
]);

export type CreditTransactionType =
  | 'monthly_allocation'
  | 'rollover'
  | 'purchase'
  | 'consumption'
  | 'refund'
  | 'expiry'
  | 'adjustment';

/**
 * Credit service types - what the credits are used for
 */
export const creditServiceTypeEnum = pgEnum('credit_service_type', [
  'ai_tokens',           // WeldAgent AI usage
  'parcel_label',        // Parcel shipping labels
  'meeting_bot',         // Meeting bot recording/transcription
  'call_transcription',  // Call transcription
  'sms',                 // SMS messages (future)
  'voip_call',           // VoIP calls (future)
  'data_enrichment',     // Data enrichment (Hunter.io, etc.)
]);

export type CreditServiceType =
  | 'ai_tokens'
  | 'parcel_label'
  | 'meeting_bot'
  | 'call_transcription'
  | 'sms'
  | 'voip_call'
  | 'data_enrichment';

/**
 * Credit transaction metadata for different service types
 */
export interface CreditTransactionMetadata {
  // For AI tokens
  model?: string;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;

  // For parcel labels
  carrier?: string;
  serviceType?: string;
  trackingNumber?: string;

  // For meeting bot
  platform?: string;
  durationMinutes?: number;
  meetingUrl?: string;

  // General
  reason?: string;
  adminUserId?: string;
  adminNote?: string;

  // Any additional metadata
  [key: string]: unknown;
}

/**
 * Credit Transactions - tracks all credit movements
 *
 * Every credit addition, consumption, refund, and adjustment is recorded here
 * for full audit trail and analytics.
 */
export const creditTransactions = pgTable('credit_transactions', {
  id: varchar('id', { length: 30 }).primaryKey(),

  // Transaction type
  type: varchar('type', { length: 30 }).notNull(), // Uses creditTransactionTypeEnum values

  // Amount (positive for credits in, negative for credits out)
  amount: integer('amount').notNull(),
  balanceAfter: integer('balance_after').notNull(),

  // Service consumption details
  serviceType: varchar('service_type', { length: 30 }), // Uses creditServiceTypeEnum values
  referenceId: varchar('reference_id', { length: 30 }), // Label ID, session ID, usage log ID, etc.
  referenceType: varchar('reference_type', { length: 50 }), // 'parcel_label', 'meeting_session', 'weldagent_usage'

  // Purchase details (if type = 'purchase')
  stripePaymentIntentId: varchar('stripe_payment_intent_id', { length: 255 }),
  stripeCheckoutSessionId: varchar('stripe_checkout_session_id', { length: 255 }),
  amountPaid: numeric('amount_paid', { precision: 10, scale: 2 }),
  currency: varchar('currency', { length: 3 }),

  // Description and metadata
  description: text('description'),
  metadata: jsonb('metadata').$type<CreditTransactionMetadata>(),

  // Who initiated the transaction
  userId: varchar('user_id', { length: 255 }),

  // Timestamps
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index('credit_transactions_type_idx').on(table.type),
  index('credit_transactions_service_type_idx').on(table.serviceType),
  index('credit_transactions_reference_idx').on(table.referenceType, table.referenceId),
  index('credit_transactions_created_at_idx').on(table.createdAt),
  index('credit_transactions_stripe_payment_idx').on(table.stripePaymentIntentId),
]);

export type CreditTransaction = typeof creditTransactions.$inferSelect;
export type NewCreditTransaction = typeof creditTransactions.$inferInsert;

/**
 * Credit packages available for purchase
 */
export const creditPackages = pgTable('credit_packages', {
  id: varchar('id', { length: 30 }).primaryKey(),

  // Package details
  name: varchar('name', { length: 100 }).notNull(),
  description: text('description'),
  credits: integer('credits').notNull(),

  // Pricing
  price: numeric('price', { precision: 10, scale: 2 }).notNull(),
  currency: varchar('currency', { length: 3 }).notNull().default('EUR'),

  // Stripe integration
  stripePriceId: varchar('stripe_price_id', { length: 255 }),
  stripeProductId: varchar('stripe_product_id', { length: 255 }),

  // Display options
  isPopular: integer('is_popular').default(0), // 1 = highlighted as popular
  sortOrder: integer('sort_order').notNull().default(0),
  isActive: integer('is_active').notNull().default(1),

  // Timestamps
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index('credit_packages_active_idx').on(table.isActive),
  index('credit_packages_sort_idx').on(table.sortOrder),
]);

export type CreditPackage = typeof creditPackages.$inferSelect;
export type NewCreditPackage = typeof creditPackages.$inferInsert;
