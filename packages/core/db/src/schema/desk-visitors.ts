import {
  pgTable,
  varchar,
  timestamp,
  index,
} from 'drizzle-orm/pg-core';

/**
 * Anonymous widget visitor. Widget auth is visitor-session (localStorage id),
 * not Clerk. Optional name/email collected once before/during the first message.
 */

export const deskVisitors = pgTable(
  'desk_visitors',
  {
    id: varchar('id', { length: 64 }).primaryKey(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at').notNull().defaultNow(),

    name: varchar('name', { length: 255 }),
    email: varchar('email', { length: 255 }),
    /** E.164 caller id for phone-channel visitors. */
    phone: varchar('phone', { length: 50 }),
    widgetId: varchar('widget_id', { length: 40 }),
  },
  (table) => [
    index('desk_visitors_email_idx').on(table.email),
    index('desk_visitors_phone_idx').on(table.phone),
    index('desk_visitors_widget_idx').on(table.widgetId),
  ],
);

export type DeskVisitor = typeof deskVisitors.$inferSelect;
export type NewDeskVisitor = typeof deskVisitors.$inferInsert;
