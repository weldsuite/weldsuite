import {
  pgTable,
  varchar,
  timestamp,
  integer,
  numeric,
  text,
  jsonb,
  index,
} from 'drizzle-orm/pg-core';

interface AccountingAddress {
  street?: string;
  houseNumber?: string;
  postalCode?: string;
  city?: string;
  province?: string;
  country?: string;
}

export const accountingContacts = pgTable('accounting_contacts', {
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  deletedAt: timestamp('deleted_at'),

  type: varchar('type', { length: 10 }).notNull(),
  name: varchar('name', { length: 255 }).notNull(),
  companyName: varchar('company_name', { length: 255 }),
  firstName: varchar('first_name', { length: 100 }),
  lastName: varchar('last_name', { length: 100 }),
  email: varchar('email', { length: 255 }),
  phone: varchar('phone', { length: 50 }),
  taxNumber: varchar('tax_number', { length: 50 }),
  kvkNumber: varchar('kvk_number', { length: 20 }),
  iban: varchar('iban', { length: 34 }),
  bic: varchar('bic', { length: 11 }),

  billingAddress: jsonb('billing_address').$type<AccountingAddress>(),
  shippingAddress: jsonb('shipping_address').$type<AccountingAddress>(),

  paymentTermsDays: integer('payment_terms_days').default(30),
  currency: varchar('currency', { length: 3 }).default('EUR'),
  defaultRevenueAccountId: varchar('default_revenue_account_id', { length: 30 }),
  defaultExpenseAccountId: varchar('default_expense_account_id', { length: 30 }),
  crmCustomerId: varchar('crm_customer_id', { length: 30 }),
  crmContactId: varchar('crm_contact_id', { length: 30 }),
  creditLimit: numeric('credit_limit', { precision: 18, scale: 2 }),
  outstandingBalance: numeric('outstanding_balance', { precision: 18, scale: 2 }).default('0'),
  notes: text('notes'),
  tags: jsonb('tags').$type<string[]>(),

  sepaMandate: jsonb('sepa_mandate').$type<{
    mandateId?: string;
    signatureDate?: string;
    type?: 'one-off' | 'recurring';
  }>(),

  metadata: jsonb('metadata').$type<Record<string, unknown>>(),
}, (table) => [
  index('acct_contacts_type_idx').on(table.type),
  index('acct_contacts_name_idx').on(table.name),
  index('acct_contacts_email_idx').on(table.email),
  index('acct_contacts_crm_customer_idx').on(table.crmCustomerId),
  index('acct_contacts_tax_number_idx').on(table.taxNumber),
  index('acct_contacts_iban_idx').on(table.iban),
]);

export type AccountingContact = typeof accountingContacts.$inferSelect;
export type NewAccountingContact = typeof accountingContacts.$inferInsert;
