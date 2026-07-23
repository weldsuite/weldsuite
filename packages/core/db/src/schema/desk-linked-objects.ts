import { pgTable, varchar, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';

/**
 * WeldDesk v2 — linked-objects graph.
 *
 * Links between conversations/tickets (both are desk_conversations rows):
 * back-office tickets link to their originating conversation; tracker
 * tickets link to the many conversations affected by one issue. Undirected
 * in meaning, stored once with sourceId < targetId not enforced — the
 * service layer queries both directions.
 */
export const deskLinkedObjects = pgTable(
  'desk_linked_objects',
  {
    id: varchar('id', { length: 30 }).primaryKey(),
    createdAt: timestamp('created_at').notNull().defaultNow(),

    sourceId: varchar('source_id', { length: 30 }).notNull(),
    targetId: varchar('target_id', { length: 30 }).notNull(),
    createdBy: varchar('created_by', { length: 255 }),
  },
  (table) => [
    uniqueIndex('desk_linked_objects_pair_idx').on(table.sourceId, table.targetId),
    index('desk_linked_objects_target_idx').on(table.targetId),
  ],
);

export type DeskLinkedObject = typeof deskLinkedObjects.$inferSelect;
export type NewDeskLinkedObject = typeof deskLinkedObjects.$inferInsert;
