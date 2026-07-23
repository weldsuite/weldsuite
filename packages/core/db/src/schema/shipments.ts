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

// Shipment status types
export type ShipmentStatus =
  | 'draft'
  | 'pending'
  | 'processing'
  | 'shipped'
  | 'in_transit'
  | 'delivered'
  | 'cancelled';

export type ShipmentType = 'outbound' | 'inbound' | 'return' | 'transfer';

export interface Money {
  amount: number;
  currency: string;
}

export interface TimeWindow {
  startTime: string; // HH:mm
  endTime: string;   // HH:mm
}

export const shipments = pgTable('shipments', {
  // BaseEntity fields
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  deletedAt: timestamp('deleted_at'),

  // Identification
  shipmentNumber: varchar('shipment_number', { length: 50 }).notNull(),

  // Status & Type
  status: varchar('status', { length: 30 }).notNull().default('draft'),
  type: varchar('type', { length: 20 }).notNull().default('outbound'),

  // Parcels
  parcelIds: jsonb('parcel_ids').$type<string[]>(),
  totalParcels: integer('total_parcels').default(0),

  // Carrier & Service
  carrierId: varchar('carrier_id', { length: 30 }),
  carrierName: varchar('carrier_name', { length: 255 }),
  serviceType: varchar('service_type', { length: 50 }),

  // Totals
  totalWeight: numeric('total_weight', { precision: 10, scale: 3 }),
  totalCost: jsonb('total_cost').$type<Money>(),

  // Dates
  shippedAt: timestamp('shipped_at'),
  deliveredAt: timestamp('delivered_at'),

  // Pickup
  pickupId: varchar('pickup_id', { length: 30 }),
  pickupDate: timestamp('pickup_date'),
  pickupTimeWindow: jsonb('pickup_time_window').$type<TimeWindow>(),

  // Documents
  manifestUrl: varchar('manifest_url', { length: 500 }),
  bolUrl: varchar('bol_url', { length: 500 }), // Bill of Lading

  // Notes
  specialInstructions: text('special_instructions'),
  internalNotes: text('internal_notes'),
}, (table) => [
  index('shipments_shipment_number_idx').on(table.shipmentNumber),
  index('shipments_status_idx').on(table.status),
  index('shipments_carrier_id_idx').on(table.carrierId),
  index('shipments_created_at_idx').on(table.createdAt),
]);

export type Shipment = typeof shipments.$inferSelect;
export type NewShipment = typeof shipments.$inferInsert;
