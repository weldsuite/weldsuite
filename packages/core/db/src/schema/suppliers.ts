import {
  pgTable,
  varchar,
  timestamp,
  integer,
  boolean,
  jsonb,
  text,
  numeric,
  index,
} from 'drizzle-orm/pg-core';

// Suppliers - Vendors for purchasing inventory
export const suppliers = pgTable('suppliers', {
  // BaseEntity fields
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  deletedAt: timestamp('deleted_at'),

  // Basic Info
  name: varchar('name', { length: 255 }).notNull(),
  code: varchar('code', { length: 50 }),
  description: text('description'),

  // Contact
  contactName: varchar('contact_name', { length: 255 }),
  email: varchar('email', { length: 255 }),
  phone: varchar('phone', { length: 50 }),
  website: varchar('website', { length: 255 }),

  // Address
  addressLine1: varchar('address_line_1', { length: 255 }),
  addressLine2: varchar('address_line_2', { length: 255 }),
  city: varchar('city', { length: 100 }),
  state: varchar('state', { length: 100 }),
  postalCode: varchar('postal_code', { length: 20 }),
  country: varchar('country', { length: 100 }),

  // Payment Terms
  paymentTerms: varchar('payment_terms', { length: 100 }), // NET30, NET60, etc.
  currency: varchar('currency', { length: 3 }).default('USD'),
  creditLimit: numeric('credit_limit', { precision: 18, scale: 2 }),

  // Tax
  taxId: varchar('tax_id', { length: 50 }),

  // Lead Time
  defaultLeadTimeDays: integer('default_lead_time_days'),
  minimumOrderValue: numeric('minimum_order_value', { precision: 18, scale: 2 }),

  // Status
  isActive: boolean('is_active').default(true),
  status: varchar('status', { length: 30 }).default('active'), // active, inactive, blocked

  // Rating
  rating: integer('rating'), // 1-5
  notes: text('notes'),

  // Metadata
  metadata: jsonb('metadata').$type<Record<string, unknown>>(),
  tags: jsonb('tags').$type<string[]>(),
}, (table) => [
  index('suppliers_code_idx').on(table.code),
  index('suppliers_name_idx').on(table.name),
  index('suppliers_is_active_idx').on(table.isActive),
]);

export type Supplier = typeof suppliers.$inferSelect;
export type NewSupplier = typeof suppliers.$inferInsert;
