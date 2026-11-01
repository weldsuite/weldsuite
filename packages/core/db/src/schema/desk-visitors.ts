import {
  pgTable,
  varchar,
  timestamp,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

/**
 * A support customer: widget visitor, help-center reader, email sender or
 * caller. Not Clerk. Widget visitors hold a server-signed visitor token that
 * names this row; the browser no longer chooses the id.
 *
 * `verifiedEmail` is an address the person proved: by an email code on the
 * help center, or through an identity token the customer's site signed with
 * the widget's secret (`externalId` is the site's own user id from that
 * token). `email` is only what they typed, and grants nothing.
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

    externalId: varchar('external_id', { length: 255 }),
    verifiedEmail: varchar('verified_email', { length: 255 }),
    verifiedAt: timestamp('verified_at'),
  },
  (table) => [
    uniqueIndex('desk_visitors_widget_external_id_uidx').on(table.widgetId, table.externalId).where(sql`${table.externalId} IS NOT NULL`),
    index('desk_visitors_verified_email_idx').on(table.verifiedEmail),
    index('desk_visitors_email_idx').on(table.email),
    index('desk_visitors_phone_idx').on(table.phone),
    index('desk_visitors_widget_idx').on(table.widgetId),
  ],
);

export type DeskVisitor = typeof deskVisitors.$inferSelect;
export type NewDeskVisitor = typeof deskVisitors.$inferInsert;
