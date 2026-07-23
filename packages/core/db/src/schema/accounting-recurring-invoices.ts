import {
  pgTable,
  varchar,
  timestamp,
  boolean,
  integer,
  jsonb,
  index,
} from 'drizzle-orm/pg-core';

export const recurringInvoices = pgTable('recurring_invoices', {
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  deletedAt: timestamp('deleted_at'),

  entityId: varchar('entity_id', { length: 30 }).notNull(),
  name: varchar('name', { length: 255 }),
  contactId: varchar('contact_id', { length: 30 }).notNull(),
  frequency: varchar('frequency', { length: 15 }).notNull(),
  dayOfMonth: integer('day_of_month'),
  nextIssueDate: timestamp('next_issue_date').notNull(),
  endDate: timestamp('end_date'),
  status: varchar('status', { length: 10 }).default('active').notNull(),

  templateData: jsonb('template_data').$type<{
    items?: Array<{
      description: string;
      quantity: number;
      unitPrice: number;
      unit?: string;
      taxRateId?: string;
      accountId?: string;
    }>;
    notes?: string;
    internalNotes?: string;
    paymentTermsDays?: number;
    revenueAccountId?: string;
    reference?: string;
  }>(),

  autoSend: boolean('auto_send').default(false),
  autoFinalize: boolean('auto_finalize').default(true),
  generatedCount: integer('generated_count').default(0),
  lastGeneratedAt: timestamp('last_generated_at'),
  lastGeneratedInvoiceId: varchar('last_generated_invoice_id', { length: 30 }),
  createdBy: varchar('created_by', { length: 255 }),
}, (table) => [
  index('acct_recurring_invoices_entity_idx').on(table.entityId),
  index('acct_recurring_invoices_status_idx').on(table.status),
  index('acct_recurring_invoices_next_issue_idx').on(table.nextIssueDate),
  index('acct_recurring_invoices_contact_idx').on(table.contactId),
]);

export type RecurringInvoice = typeof recurringInvoices.$inferSelect;
export type NewRecurringInvoice = typeof recurringInvoices.$inferInsert;
