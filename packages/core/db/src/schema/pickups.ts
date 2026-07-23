import {
  pgTable,
  varchar,
  timestamp,
  integer,
  numeric,
  jsonb,
  text,
  index,
} from 'drizzle-orm/pg-core';

// Pickup status types
export type PickupStatus =
  | 'scheduled'
  | 'confirmed'
  | 'in_progress'
  | 'completed'
  | 'cancelled'
  | 'failed';

export interface Address {
  line1: string;
  line2?: string;
  city: string;
  state?: string;
  postalCode: string;
  country: string;
}

export interface TimeWindow {
  startTime: string; // HH:mm
  endTime: string;   // HH:mm
}

export interface Money {
  amount: number;
  currency: string;
}

export const pickups = pgTable('pickups', {
  // BaseEntity fields
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  deletedAt: timestamp('deleted_at'),

  // Identification
  pickupNumber: varchar('pickup_number', { length: 50 }).notNull(),

  // Status
  status: varchar('status', { length: 30 }).notNull().default('scheduled'),

  // Carrier
  carrierId: varchar('carrier_id', { length: 30 }).notNull(),
  carrierName: varchar('carrier_name', { length: 255 }),
  confirmationNumber: varchar('confirmation_number', { length: 100 }),

  // Schedule
  pickupDate: timestamp('pickup_date').notNull(),
  timeWindow: jsonb('time_window').$type<TimeWindow>(),

  // Location
  pickupAddress: jsonb('pickup_address').$type<Address>(),
  contactName: varchar('contact_name', { length: 255 }),
  contactPhone: varchar('contact_phone', { length: 50 }),
  specialInstructions: text('special_instructions'),

  // Shipments
  shipmentIds: jsonb('shipment_ids').$type<string[]>(),
  totalParcels: integer('total_parcels').default(0),
  totalWeight: numeric('total_weight', { precision: 10, scale: 3 }),

  // Cost
  pickupCost: jsonb('pickup_cost').$type<Money>(),

  // Confirmation/Cancellation
  confirmedAt: timestamp('confirmed_at'),
  cancelledAt: timestamp('cancelled_at'),
  cancellationReason: text('cancellation_reason'),
}, (table) => [
  index('pickups_pickup_number_idx').on(table.pickupNumber),
  index('pickups_status_idx').on(table.status),
  index('pickups_carrier_id_idx').on(table.carrierId),
  index('pickups_pickup_date_idx').on(table.pickupDate),
]);

export type Pickup = typeof pickups.$inferSelect;
export type NewPickup = typeof pickups.$inferInsert;
