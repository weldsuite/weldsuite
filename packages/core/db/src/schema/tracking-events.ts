import {
  pgTable,
  varchar,
  timestamp,
  boolean,
  jsonb,
  text,
  index,
} from 'drizzle-orm/pg-core';

// Event source types
export type TrackingEventSource = 'carrier' | 'manual' | 'system';

export const trackingEvents = pgTable('tracking_events', {
  // BaseEntity fields
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),

  // Parcel Reference
  parcelId: varchar('parcel_id', { length: 30 }).notNull(),
  trackingNumber: varchar('tracking_number', { length: 100 }),

  // Event Details
  status: varchar('status', { length: 50 }).notNull(),
  statusCode: varchar('status_code', { length: 50 }),
  description: text('description'),

  // Location
  location: varchar('location', { length: 255 }),
  city: varchar('city', { length: 100 }),
  state: varchar('state', { length: 100 }),
  country: varchar('country', { length: 100 }),
  postalCode: varchar('postal_code', { length: 20 }),

  // Time
  eventDate: timestamp('event_date').notNull(),
  localTime: varchar('local_time', { length: 20 }),
  timezone: varchar('timezone', { length: 50 }),

  // Additional Info
  signatory: varchar('signatory', { length: 255 }),
  exception: boolean('exception').default(false),
  exceptionReason: text('exception_reason'),

  // Source
  source: varchar('source', { length: 20 }).notNull().default('carrier'),
  rawData: jsonb('raw_data').$type<Record<string, unknown>>(),
}, (table) => [
  index('tracking_events_parcel_id_idx').on(table.parcelId),
  index('tracking_events_tracking_number_idx').on(table.trackingNumber),
  index('tracking_events_event_date_idx').on(table.eventDate),
]);

export type TrackingEvent = typeof trackingEvents.$inferSelect;
export type NewTrackingEvent = typeof trackingEvents.$inferInsert;
