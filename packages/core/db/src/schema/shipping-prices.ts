import {
  pgTable,
  varchar,
  timestamp,
  boolean,
  numeric,
  jsonb,
  text,
  index,
} from 'drizzle-orm/pg-core';

export interface Money {
  amount: number;
  currency: string;
}

export interface WeightRange {
  minWeight: number;
  maxWeight: number;
  price: Money;
}

export const shippingPrices = pgTable('shipping_prices', {
  // BaseEntity fields
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  deletedAt: timestamp('deleted_at'),

  // Identification
  name: varchar('name', { length: 255 }).notNull(),

  // Carrier & Service
  carrierId: varchar('carrier_id', { length: 30 }),
  serviceType: varchar('service_type', { length: 50 }),

  // Zone-based pricing
  fromZone: varchar('from_zone', { length: 50 }),
  toZone: varchar('to_zone', { length: 50 }),

  // Weight-based pricing
  weightRanges: jsonb('weight_ranges').$type<WeightRange[]>(),

  // Flat rate
  flatRate: jsonb('flat_rate').$type<Money>(),

  // Markups & Fees
  percentageMarkup: numeric('percentage_markup', { precision: 5, scale: 2 }),
  handlingFee: jsonb('handling_fee').$type<Money>(),
  fuelSurcharge: numeric('fuel_surcharge', { precision: 5, scale: 2 }),

  // Currency
  currency: varchar('currency', { length: 3 }).default('EUR'),

  // Validity
  effectiveFrom: timestamp('effective_from'),
  effectiveTo: timestamp('effective_to'),

  // Status
  isActive: boolean('is_active').default(true),

  // Notes
  description: text('description'),
}, (table) => [
  index('shipping_prices_carrier_id_idx').on(table.carrierId),
  index('shipping_prices_is_active_idx').on(table.isActive),
]);

export type ShippingPrice = typeof shippingPrices.$inferSelect;
export type NewShippingPrice = typeof shippingPrices.$inferInsert;
