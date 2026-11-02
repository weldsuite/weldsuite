import { pgTable, varchar, timestamp, integer, primaryKey, index } from 'drizzle-orm/pg-core';

/**
 * When a per-workspace sweep should next open a workspace's tenant database,
 * for the Kubernetes editions (EU, self-hosted). Global keeps this in the
 * schedule-index D1 database (`packages/core/worker-kit/src/due-index.ts`,
 * DDL `apps/workers/workflow-worker/migrations/d1/0004_workspace_due_index.sql`);
 * the Rust backend's due-index port uses this table with the same rules:
 *
 * - write paths can only pull `next_due_at` earlier;
 * - the sweep stores the re-derived time guarded by `version`, so a write that
 *   lands while the tenant is processed is never overwritten.
 *
 * The tenant database stays the source of truth; a row only says "look at
 * this workspace at or after `next_due_at`".
 */
export const workspaceDueIndex = pgTable(
  'workspace_due_index',
  {
    /** The sweep: `sign_lifecycle`, `mail_snooze`, … (`DueIndexKind`). */
    kind: varchar('kind', { length: 40 }).notNull(),
    /** The id the sweep's writers use for the workspace (the Clerk org id today). */
    workspaceId: varchar('workspace_id', { length: 255 }).notNull(),
    nextDueAt: timestamp('next_due_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    /** Compare-and-set token, bumped by every write. */
    version: integer('version').notNull().default(1),
  },
  (table) => [
    primaryKey({ columns: [table.kind, table.workspaceId] }),
    index('workspace_due_index_kind_due_idx').on(table.kind, table.nextDueAt),
  ],
);

export type WorkspaceDueIndexRow = typeof workspaceDueIndex.$inferSelect;
