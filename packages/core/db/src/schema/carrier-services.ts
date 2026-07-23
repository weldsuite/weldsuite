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

export const carrierServices = pgTable('carrier_services', {
  // BaseEntity fields
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  deletedAt: timestamp('deleted_at'),

  // Carrier Reference
  carrierId: varchar('carrier_id', { length: 30 }).notNull(),

  // Service Identification
  name: varchar('name', { length: 255 }).notNull(),
  code: varchar('code', { length: 50 }).notNull(),
  externalId: varchar('external_id', { length: 100 }),
  description: text('description'),

  // Delivery Info
  deliveryDays: integer('delivery_days'),
  cutoffTime: varchar('cutoff_time', { length: 10 }), // HH:mm format

  // Service Features
  isExpress: boolean('is_express').default(false),
  hasTracking: boolean('has_tracking').default(true),
  hasInsurance: boolean('has_insurance').default(false),
  maxInsuranceValue: numeric('max_insurance_value', { precision: 18, scale: 2 }),

  // Pricing
  basePrice: numeric('base_price', { precision: 18, scale: 2 }),
  currency: varchar('currency', { length: 3 }).default('EUR'),

  // Supported Countries
  supportedCountries: jsonb('supported_countries').$type<string[]>(),

  // Configuration
  configuration: jsonb('configuration').$type<Record<string, unknown>>(),

  // Status
  isActive: boolean('is_active').default(true),
}, (table) => [
  index('carrier_services_carrier_id_idx').on(table.carrierId),
  index('carrier_services_code_idx').on(table.code),
  index('carrier_services_is_active_idx').on(table.isActive),
]);

export type CarrierService = typeof carrierServices.$inferSelect;
export type NewCarrierService = typeof carrierServices.$inferInsert;
