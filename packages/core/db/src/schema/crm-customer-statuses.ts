import {
  pgTable,
  varchar,
  timestamp,
  integer,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

export const crmCustomerStatuses = pgTable('crm_customer_statuses', {
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  deletedAt: timestamp('deleted_at'),

  name: varchar('name', { length: 60 }).notNull(),
  slug: varchar('slug', { length: 30 }).notNull(),
  color: varchar('color', { length: 30 }).notNull().default('gray'),
  sortOrder: integer('sort_order').notNull().default(0),
}, (table) => [
  uniqueIndex('crm_customer_statuses_slug_uniq').on(table.slug),
  index('crm_customer_statuses_sort_idx').on(table.sortOrder),
]);

export type CrmCustomerStatus = typeof crmCustomerStatuses.$inferSelect;
export type NewCrmCustomerStatus = typeof crmCustomerStatuses.$inferInsert;
