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

export interface ReturnReasonTranslation {
  locale: string;
  label: string;
  description?: string;
}

// Return Reason Groups
export const returnReasonGroups = pgTable('return_reason_groups', {
  // BaseEntity fields
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  deletedAt: timestamp('deleted_at'),

  // Group Details
  name: varchar('name', { length: 255 }).notNull(),
  description: text('description'),
  displayOrder: integer('display_order').default(0),

  // Status
  isActive: boolean('is_active').default(true),

  // UI
  color: varchar('color', { length: 20 }),
  icon: varchar('icon', { length: 50 }),
}, (table) => [
  index('return_reason_groups_is_active_idx').on(table.isActive),
]);

export type ReturnReasonGroup = typeof returnReasonGroups.$inferSelect;
export type NewReturnReasonGroup = typeof returnReasonGroups.$inferInsert;

// Return Reasons
export const returnReasons = pgTable('return_reasons', {
  // BaseEntity fields
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  deletedAt: timestamp('deleted_at'),

  // Identification
  code: varchar('code', { length: 50 }).notNull(),
  label: varchar('label', { length: 255 }).notNull(),
  description: text('description'),

  // Grouping
  groupId: varchar('group_id', { length: 30 }),
  displayOrder: integer('display_order').default(0),

  // Status
  isActive: boolean('is_active').default(true),

  // Requirements
  requiresPhotos: boolean('requires_photos').default(false),
  requiresDetails: boolean('requires_details').default(false),

  // Auto-processing
  autoApprove: boolean('auto_approve').default(false),

  // Eligibility
  refundEligible: boolean('refund_eligible').default(true),
  exchangeEligible: boolean('exchange_eligible').default(true),
  restockingFee: numeric('restocking_fee', { precision: 5, scale: 2 }),

  // Usage
  usageCount: integer('usage_count').default(0),

  // Translations
  translations: jsonb('translations').$type<ReturnReasonTranslation[]>(),
}, (table) => [
  index('return_reasons_code_idx').on(table.code),
  index('return_reasons_group_id_idx').on(table.groupId),
  index('return_reasons_is_active_idx').on(table.isActive),
]);

export type ReturnReason = typeof returnReasons.$inferSelect;
export type NewReturnReason = typeof returnReasons.$inferInsert;
