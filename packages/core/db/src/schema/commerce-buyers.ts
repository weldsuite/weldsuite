import { sql } from 'drizzle-orm';
import {
  pgTable,
  varchar,
  text,
  timestamp,
  numeric,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

// B2B buyers and approvals (rebuild, phase 6; ADR COM-012).
// Shoppers are CRM people (`people.in_crm = false` for web shoppers); a B2B buyer
// is a person linked to a company (`person_companies`) with a commerce role here.
// Shopper sign-in codes and sessions live in the workspace cache (the portal kit),
// not in tables.

export type CommerceBuyerRole = 'buyer' | 'approver' | 'admin';
export type CommerceBuyerStatus = 'invited' | 'active' | 'disabled';
export type OrderApprovalDecision = 'pending' | 'approved' | 'rejected';

export const commerceBuyers = pgTable('commerce_buyers', {
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  deletedAt: timestamp('deleted_at'),

  personId: varchar('person_id', { length: 30 }).notNull(),
  companyId: varchar('company_id', { length: 30 }).notNull(),
  // 'buyer' | 'approver' | 'admin' (admins may invite more buyers)
  role: varchar('role', { length: 20 }).$type<CommerceBuyerRole>().notNull().default('buyer'),
  // Largest order the buyer may place without approval; null means no limit.
  spendLimit: numeric('spend_limit', { precision: 18, scale: 2 }),
  spendLimitCurrency: varchar('spend_limit_currency', { length: 3 }),
  // 'invited' | 'active' | 'disabled'
  status: varchar('status', { length: 20 }).$type<CommerceBuyerStatus>().notNull().default('invited'),

  // Staff user id or buyer id of whoever invited.
  invitedBy: varchar('invited_by', { length: 255 }),
  invitedAt: timestamp('invited_at'),
  acceptedAt: timestamp('accepted_at'),
}, (table) => [
  // A person is a buyer of a company once.
  uniqueIndex('commerce_buyers_person_company_uidx')
    .on(table.personId, table.companyId)
    .where(sql`${table.deletedAt} IS NULL`),
  index('commerce_buyers_company_idx').on(table.companyId, table.status),
  index('commerce_buyers_person_idx').on(table.personId),
]);

export type CommerceBuyer = typeof commerceBuyers.$inferSelect;
export type NewCommerceBuyer = typeof commerceBuyers.$inferInsert;

// Per-company ordering settings. Today only the approval threshold: an order
// above it waits for an approver. No row, or a null threshold, means none.
export const commerceCompanySettings = pgTable('commerce_company_settings', {
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),

  companyId: varchar('company_id', { length: 30 }).notNull(),
  approvalThreshold: numeric('approval_threshold', { precision: 18, scale: 2 }),
  approvalThresholdCurrency: varchar('approval_threshold_currency', { length: 3 }),
}, (table) => [
  uniqueIndex('commerce_company_settings_company_uidx').on(table.companyId),
]);

export type CommerceCompanySettings = typeof commerceCompanySettings.$inferSelect;
export type NewCommerceCompanySettings = typeof commerceCompanySettings.$inferInsert;

// One approval request per order above a limit; any approver of the company decides.
// `orders.approval_status` mirrors the outcome.
export const orderApprovals = pgTable('order_approvals', {
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),

  orderId: varchar('order_id', { length: 30 }).notNull(),
  // Why approval is needed: 'buyer_limit' | 'company_threshold'
  reason: varchar('reason', { length: 30 }).notNull().default('buyer_limit'),
  requestedByPersonId: varchar('requested_by_person_id', { length: 30 }),
  // Set when an approver decides.
  approverPersonId: varchar('approver_person_id', { length: 30 }),
  // 'pending' | 'approved' | 'rejected'
  decision: varchar('decision', { length: 20 }).$type<OrderApprovalDecision>().notNull().default('pending'),
  comment: text('comment'),
  decidedAt: timestamp('decided_at'),
}, (table) => [
  index('order_approvals_order_idx').on(table.orderId),
  index('order_approvals_approver_idx').on(table.approverPersonId),
  index('order_approvals_decision_idx').on(table.decision),
  // One open request per order.
  uniqueIndex('order_approvals_order_pending_uidx')
    .on(table.orderId)
    .where(sql`${table.decision} = 'pending'`),
]);

export type OrderApproval = typeof orderApprovals.$inferSelect;
export type NewOrderApproval = typeof orderApprovals.$inferInsert;
