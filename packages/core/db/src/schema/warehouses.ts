import {
  pgTable,
  varchar,
  timestamp,
  integer,
  boolean,
  jsonb,
  text,
  index,
} from 'drizzle-orm/pg-core';

// Warehouses - Storage facilities for inventory
export const warehouses = pgTable('warehouses', {
  // BaseEntity fields
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  deletedAt: timestamp('deleted_at'),

  // Basic Info
  name: varchar('name', { length: 255 }).notNull(),
  code: varchar('code', { length: 50 }),
  description: text('description'),

  // Address
  addressLine1: varchar('address_line_1', { length: 255 }),
  addressLine2: varchar('address_line_2', { length: 255 }),
  city: varchar('city', { length: 100 }),
  state: varchar('state', { length: 100 }),
  postalCode: varchar('postal_code', { length: 20 }),
  country: varchar('country', { length: 100 }),

  // Contact
  contactName: varchar('contact_name', { length: 255 }),
  contactEmail: varchar('contact_email', { length: 255 }),
  contactPhone: varchar('contact_phone', { length: 50 }),

  // Settings
  isDefault: boolean('is_default').default(false),
  isActive: boolean('is_active').default(true),
  priority: integer('priority').default(0),

  // Capacity
  totalLocations: integer('total_locations').default(0),
  totalProducts: integer('total_products').default(0),

  // Operating Hours
  operatingHours: jsonb('operating_hours').$type<Record<string, { open: string; close: string; closed?: boolean }>>(),
  timezone: varchar('timezone', { length: 50 }),

  // Metadata
  metadata: jsonb('metadata').$type<Record<string, unknown>>(),
  tags: jsonb('tags').$type<string[]>(),
}, (table) => [
  index('warehouses_code_idx').on(table.code),
  index('warehouses_is_active_idx').on(table.isActive),
]);

export type Warehouse = typeof warehouses.$inferSelect;
export type NewWarehouse = typeof warehouses.$inferInsert;
