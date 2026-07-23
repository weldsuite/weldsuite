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

// Box/Package types
export type BoxType = 'box' | 'envelope' | 'tube' | 'pallet' | 'custom';
export type DimensionUnit = 'cm' | 'in';
export type WeightUnit = 'kg' | 'lb' | 'g' | 'oz';

export interface Money {
  amount: number;
  currency: string;
}

export const boxes = pgTable('boxes', {
  // BaseEntity fields
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  deletedAt: timestamp('deleted_at'),

  // Identification
  name: varchar('name', { length: 255 }).notNull(),
  code: varchar('code', { length: 50 }).notNull(),

  // Dimensions
  length: numeric('length', { precision: 10, scale: 2 }).notNull(),
  width: numeric('width', { precision: 10, scale: 2 }).notNull(),
  height: numeric('height', { precision: 10, scale: 2 }).notNull(),
  dimensionUnit: varchar('dimension_unit', { length: 5 }).notNull().default('cm'),

  // Weight
  tareWeight: numeric('tare_weight', { precision: 10, scale: 3 }), // Empty box weight
  maxWeight: numeric('max_weight', { precision: 10, scale: 3 }),
  weightUnit: varchar('weight_unit', { length: 5 }).notNull().default('kg'),

  // Type
  type: varchar('type', { length: 20 }).notNull().default('box'),
  material: varchar('material', { length: 100 }),

  // Status
  isDefault: boolean('is_default').default(false),
  isActive: boolean('is_active').default(true),

  // Cost
  cost: jsonb('cost').$type<Money>(),

  // Metadata
  image: varchar('image', { length: 500 }),
  description: text('description'),
}, (table) => [
  index('boxes_code_idx').on(table.code),
  index('boxes_is_active_idx').on(table.isActive),
]);

export type Box = typeof boxes.$inferSelect;
export type NewBox = typeof boxes.$inferInsert;
