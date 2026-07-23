import {
  pgTable,
  varchar,
  timestamp,
  integer,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

/**
 * Per-workspace counter backing the human-friendly task number (TASK-<number>).
 *
 * Each tenant DB holds exactly one row (scope = 'task'). Allocation increments
 * `next_value` atomically via an upsert with RETURNING, so concurrent task
 * creates each get a distinct number with no select-then-update race — the same
 * technique used by `entity_number_sequences` for accounting documents.
 */
export const taskNumberSequences = pgTable('task_number_sequences', {
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),

  // Scope for the counter. Single workspace-wide sequence for now ('task'),
  // kept as a column so a future per-project/per-prefix scheme can add rows.
  scope: varchar('scope', { length: 30 }).notNull().default('task'),
  prefix: varchar('prefix', { length: 20 }).notNull().default('TASK-'),
  nextValue: integer('next_value').notNull().default(1),
}, (table) => [
  uniqueIndex('task_number_sequences_scope_unique').on(table.scope),
]);

export type TaskNumberSequence = typeof taskNumberSequences.$inferSelect;
export type NewTaskNumberSequence = typeof taskNumberSequences.$inferInsert;
