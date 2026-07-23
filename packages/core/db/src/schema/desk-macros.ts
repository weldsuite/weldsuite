import {
  pgTable,
  varchar,
  timestamp,
  boolean,
  jsonb,
  text,
  index,
} from 'drizzle-orm/pg-core';

/**
 * WeldDesk v2 — macros: saved replies + bundled actions.
 *
 * Replaces helpdesk_canned_responses. A macro can insert a reply/note into
 * the composer AND apply follow-up actions (tag, assign, close, snooze,
 * set attribute, apply SLA) in one go. Bulk-applicable from the table view.
 */

export type DeskMacroAction =
  | { type: 'add_tag'; tag: string }
  | { type: 'remove_tag'; tag: string }
  | { type: 'assign'; assigneeType: 'admin' | 'team'; assigneeId: string }
  | { type: 'close' }
  | { type: 'snooze'; durationMinutes: number }
  | { type: 'mark_priority'; priority: boolean }
  | { type: 'set_attribute'; attributeId: string; value: unknown }
  | { type: 'apply_sla'; slaId: string };

export const deskMacros = pgTable(
  'desk_macros',
  {
    id: varchar('id', { length: 30 }).primaryKey(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),

    name: varchar('name', { length: 255 }).notNull(),
    /** Rich-text reply body; null for action-only macros. */
    body: text('body'),
    /** Whether body inserts as a customer reply or an internal note. */
    insertAs: varchar('insert_as', { length: 10 }).$type<'reply' | 'note'>().notNull().default('reply'),
    actions: jsonb('actions').$type<DeskMacroAction[]>().notNull().default([]),
    /** Restrict visibility to specific team ids; null = whole workspace. */
    teamIds: jsonb('team_ids').$type<string[]>(),
    createdBy: varchar('created_by', { length: 255 }),
    archived: boolean('archived').notNull().default(false),
  },
  (table) => [index('desk_macros_archived_idx').on(table.archived)],
);

export type DeskMacro = typeof deskMacros.$inferSelect;
export type NewDeskMacro = typeof deskMacros.$inferInsert;
