import {
  pgTable,
  varchar,
  timestamp,
  boolean,
  integer,
  jsonb,
  index,
} from 'drizzle-orm/pg-core';

/**
 * WeldDesk v2 — custom inbox views.
 *
 * Saved filter + sort combinations shown in the inbox sidebar, optionally
 * grouped into folders. Private (owner only) or shared with the workspace.
 */

export type DeskViewSort =
  | 'newest'
  | 'oldest'
  | 'waiting_longest'
  | 'priority_first'
  | 'next_sla_target';

/** Filter predicate over conversation fields, tags, attributes, channel, ticket type… */
export interface DeskViewFilter {
  /** AND of OR-groups, Intercom style. */
  groups: {
    conditions: {
      field: string;
      operator: 'eq' | 'ne' | 'in' | 'nin' | 'contains' | 'gt' | 'lt' | 'exists' | 'not_exists';
      value?: unknown;
    }[];
  }[];
}

export const deskViews = pgTable(
  'desk_views',
  {
    id: varchar('id', { length: 30 }).primaryKey(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),

    name: varchar('name', { length: 255 }).notNull(),
    icon: varchar('icon', { length: 20 }),
    folder: varchar('folder', { length: 255 }),
    filters: jsonb('filters').$type<DeskViewFilter>().notNull(),
    sort: varchar('sort', { length: 20 }).$type<DeskViewSort>().notNull().default('newest'),
    shared: boolean('shared').notNull().default(false),
    ownerId: varchar('owner_id', { length: 255 }).notNull(),
    order: integer('order').notNull().default(0),
  },
  (table) => [index('desk_views_owner_idx').on(table.ownerId)],
);

export type DeskView = typeof deskViews.$inferSelect;
export type NewDeskView = typeof deskViews.$inferInsert;
