import {
  pgTable,
  varchar,
  timestamp,
  integer,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

/**
 * Counters backing the human-friendly numbers of WeldFlow.
 *
 * The workspace-wide task number (TASK-<number>) is the row with scope = 'task'.
 * RAID register items (project control) number per project and kind, one row
 * each, under the scope keys 'rsk:<projectId>', 'asm:<projectId>',
 * 'iss:<projectId>' and 'dep:<projectId>' (display prefixes RSK-, A-, ISS-, DEP-);
 * the other registers do the same ('dec:' DEC-, 'cr:' CR-, 'del:' D, 'ben:' B-,
 * see ./project-control). Project requests (intake) number workspace-wide under
 * the scope 'req' (REQ-).
 * Allocation increments `next_value` atomically via an upsert with RETURNING, so
 * concurrent creates each get a distinct number with no select-then-update race —
 * the same technique used by `entity_number_sequences` for accounting documents.
 */
export const taskNumberSequences = pgTable('task_number_sequences', {
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),

  // Scope for the counter: 'task', or a 3-letter register key plus a colon and a
  // project id ('rsk:<projectId>'). projects.id allows 255 characters, so the
  // column leaves room for any of them.
  scope: varchar('scope', { length: 300 }).notNull().default('task'),
  prefix: varchar('prefix', { length: 20 }).notNull().default('TASK-'),
  nextValue: integer('next_value').notNull().default(1),
}, (table) => [
  uniqueIndex('task_number_sequences_scope_unique').on(table.scope),
]);

export type TaskNumberSequence = typeof taskNumberSequences.$inferSelect;
export type NewTaskNumberSequence = typeof taskNumberSequences.$inferInsert;
