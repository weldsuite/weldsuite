import { pgTable, varchar, timestamp, jsonb, uniqueIndex } from 'drizzle-orm/pg-core';
import type { DeskWeeklyHours } from './desk-teams';

/**
 * WeldDesk v2 — workspace default office hours.
 *
 * One row per tenant (scope='default'). Per-team overrides live on
 * desk_teams.officeHours. Office hours drive: Messenger reply-time
 * expectations, SLA office-hour clocks, and workflow scheduling.
 */
export const deskOfficeHours = pgTable(
  'desk_office_hours',
  {
    id: varchar('id', { length: 30 }).primaryKey(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),

    scope: varchar('scope', { length: 10 }).notNull().default('default'),
    timezone: varchar('timezone', { length: 64 }).notNull().default('UTC'),
    hours: jsonb('hours').$type<DeskWeeklyHours>().notNull(),
  },
  (table) => [uniqueIndex('desk_office_hours_scope_idx').on(table.scope)],
);

export type DeskOfficeHours = typeof deskOfficeHours.$inferSelect;
export type NewDeskOfficeHours = typeof deskOfficeHours.$inferInsert;
