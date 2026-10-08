import {
  pgTable,
  varchar,
  timestamp,
  date,
  integer,
  boolean,
  numeric,
  text,
  jsonb,
  index,
} from 'drizzle-orm/pg-core';

/**
 * A batch of vendor payments made together: a check run (printed checks) or
 * an ACH run (one NACHA file). Runs need approval before they can be printed
 * or exported (dual approval by default), and payees whose bank details
 * changed recently are held until someone verifies the change.
 */
export const paymentRuns = pgTable('payment_runs', {
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  deletedAt: timestamp('deleted_at'),

  entityId: varchar('entity_id', { length: 30 }).notNull(),
  bankAccountId: varchar('bank_account_id', { length: 30 }).notNull(),
  /** check | ach */
  method: varchar('method', { length: 10 }).notNull(),
  /** draft | pending_approval | approved | exported | completed | cancelled */
  status: varchar('status', { length: 20 }).notNull().default('draft'),
  paymentDate: date('payment_date').notNull(),
  /** ACH: PPD | CCD | CTX (CCD+ is CCD with an addenda record). */
  secCode: varchar('sec_code', { length: 5 }),
  sameDay: boolean('same_day').notNull().default(false),
  totalAmount: numeric('total_amount', { precision: 18, scale: 2 }).notNull().default('0'),
  paymentCount: integer('payment_count').notNull().default(0),
  requiredApprovals: integer('required_approvals').notNull().default(2),
  approvals: jsonb('approvals').$type<Array<{ userId: string; at: string }>>(),
  /** The run's bills: [{ billId, amount }]. Payments are created on approval. */
  items: jsonb('items').$type<Array<{ billId: string; amount: number; partyId: string }>>(),
  holds: jsonb('holds').$type<Array<{ partyId: string; reason: string }>>(),
  fileName: varchar('file_name', { length: 255 }),
  fileGeneratedAt: timestamp('file_generated_at'),
  createdBy: varchar('created_by', { length: 255 }),
  notes: text('notes'),
}, (table) => [
  index('acct_payment_runs_entity_idx').on(table.entityId),
  index('acct_payment_runs_status_idx').on(table.status),
]);

/**
 * A request for a vendor to fill in their W-9 online. The link carries a
 * random token; only its SHA-256 is stored.
 */
export const w9Requests = pgTable('w9_requests', {
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),

  entityId: varchar('entity_id', { length: 30 }).notNull(),
  partyId: varchar('party_id', { length: 30 }).notNull(),
  email: varchar('email', { length: 255 }),
  tokenHash: varchar('token_hash', { length: 64 }).notNull(),
  /** pending | completed | expired | cancelled */
  status: varchar('status', { length: 15 }).notNull().default('pending'),
  expiresAt: timestamp('expires_at').notNull(),
  completedAt: timestamp('completed_at'),
  requestedBy: varchar('requested_by', { length: 255 }),
}, (table) => [
  index('acct_w9_requests_party_idx').on(table.partyId),
  index('acct_w9_requests_token_idx').on(table.tokenHash),
]);

export type PaymentRun = typeof paymentRuns.$inferSelect;
export type NewPaymentRun = typeof paymentRuns.$inferInsert;
export type W9Request = typeof w9Requests.$inferSelect;
export type NewW9Request = typeof w9Requests.$inferInsert;
