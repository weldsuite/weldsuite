import { sql } from 'drizzle-orm';
import { index, jsonb, pgTable, text, timestamp, uniqueIndex, varchar } from 'drizzle-orm/pg-core';

// ============================================================================
// WORKSPACE DATABASE MOVES (master DB)
// ============================================================================
//
// One row per attempt to move a workspace's tenant database between a shared
// shard and a dedicated Neon project, or between shards (TASK-1150, ADR
// DATA-016). The move runs as a workspace-worker Workflow whose instance id is
// the row id; this row is its durable state and the admin console's progress
// view. `workspace_id` is deliberately not a foreign key: the history must
// outlive a workspace teardown, like `admin_audit_events`.
//
// Lifecycle:
//   queued → preparing (target created and migrated)
//          → soft_locked (APIs answer 503 "moving", in-flight work drains)
//          → locked (source role password rotated, database read-only by default,
//                    sessions ended)
//          → copying → verifying (row counts + checksums, source re-checked)
//          → switching (workspaces row swapped in one compare-and-set update)
//          → completed
//   Any step can end in failed; cancel_requested_at moves an active row to
//   cancelling, then cancelled once the source is unlocked again.
//
// After completion the OLD database stays read-only until
// `old_database_retained_until`, then the daily sweep drops it.

export const DATABASE_MOVE_STATUSES = [
  'queued',
  'preparing',
  'soft_locked',
  'locked',
  'copying',
  'verifying',
  'switching',
  'completed',
  'failed',
  'cancelling',
  'cancelled',
] as const;
export type DatabaseMoveStatus = (typeof DATABASE_MOVE_STATUSES)[number];

/** Statuses during which the workspace is (or is about to be) unavailable for writes. */
export const ACTIVE_DATABASE_MOVE_STATUSES = [
  'queued',
  'preparing',
  'soft_locked',
  'locked',
  'copying',
  'verifying',
  'switching',
  'cancelling',
] as const satisfies readonly DatabaseMoveStatus[];

/** Statuses during which writes must be refused (the API soft lock and later). */
export const WRITE_BLOCKING_DATABASE_MOVE_STATUSES = [
  'soft_locked',
  'locked',
  'copying',
  'verifying',
  'switching',
  'cancelling',
] as const satisfies readonly DatabaseMoveStatus[];

export type DatabaseMoveKind = 'shard_to_dedicated' | 'dedicated_to_shard' | 'shard_to_shard';

/** Per-table copy progress, persisted so a retried Workflow step resumes where it stopped. */
export interface DatabaseMoveTableProgress {
  table: string;
  /** Rows copied so far. */
  rows: number;
  /** Last primary key copied (JSON-encoded key values), null before the first page. */
  cursor: string | null;
  done: boolean;
  /** Rows per page chosen when the copy was planned (kept so a retried step pages the same way). */
  pageSize?: number;
  /** Row estimate the plan was ordered by. */
  estimatedRows?: number | null;
}

/** A foreign key dropped from the target for the copy and re-added afterwards (mirrors the engine's `ForeignKeyInfo`). */
export interface DatabaseMoveSavedForeignKey {
  table: string;
  name: string;
  definition: string;
  validated: boolean;
}

/** A user trigger disabled on the target for the copy (mirrors the engine's `TriggerInfo`). */
export interface DatabaseMoveSavedTrigger {
  table: string;
  name: string;
  /** `pg_trigger.tgenabled` on the source: O origin, D disabled, R replica, A always. */
  enabled: 'O' | 'D' | 'R' | 'A';
}

/** What preparing the target changed, handed to the finishing step (mirrors the engine's `SavedTargetState`). */
export interface DatabaseMoveSavedState {
  foreignKeys: DatabaseMoveSavedForeignKey[];
  triggers: DatabaseMoveSavedTrigger[];
}

/** Row count and order-independent checksum per table (mirrors the engine's `ChecksumMap`). */
export type DatabaseMoveChecksums = Record<string, { count: number; hash: string | null }>;

export interface DatabaseMoveProgress {
  tables: DatabaseMoveTableProgress[];
  copiedRows: number;
  /** Row estimate taken before the copy, for the progress bar; replaced by the exact count once the source is checksummed. */
  totalRows: number | null;

  // Workflow state a retried or replayed step needs. Plain JSON: no connection
  // strings, no row contents.
  /** When the lock procedure began on the source (before the password rotation), so a failed move knows to unlock it. */
  lockStartedAt?: string;
  /** `prepareTargetForCopy` ran (target truncated, foreign keys dropped): it must never run again once copying started. */
  prepared?: boolean;
  /** What preparing the target changed, for the finishing step. */
  saved?: DatabaseMoveSavedState;
  /** Tables that were empty on the source when the copy was planned (verified too, never copied). */
  emptyTables?: string[];
  /** Source checksums taken right after the lock, before the copy. */
  sourceChecksums?: DatabaseMoveChecksums;
  /** Set once the target was dropped or returned after a failed or cancelled move, so a repeat run skips it. */
  targetReleasedAt?: string;
}

export interface DatabaseMoveTableVerification {
  table: string;
  sourceRows: number;
  targetRows: number;
  /** Order-independent checksum; null when skipped for a very large table. */
  sourceHash: string | null;
  targetHash: string | null;
  ok: boolean;
}

export interface DatabaseMoveVerification {
  tables: DatabaseMoveTableVerification[];
  /** True when every table matched, and the source did not change after the lock. */
  ok: boolean;
  verifiedAt: string;
  /** False when the source differed between the reading before the copy and the reading after it. */
  sourceUnchanged?: boolean;
  /** Tables whose count or checksum differed between the two source readings. */
  sourceChangedTables?: string[];
  /** Non-fatal findings (for example, ANALYZE on the target failed). */
  warnings?: string[];
}

const activeStatusesSql = sql.raw(ACTIVE_DATABASE_MOVE_STATUSES.map((s) => `'${s}'`).join(', '));

export const workspaceDatabaseMoves = pgTable(
  'workspace_database_moves',
  {
    id: varchar('id', { length: 30 }).primaryKey(), // dbm_…

    /** Master `workspaces.id` (ws_…). Not a foreign key, see above. */
    workspaceId: varchar('workspace_id', { length: 255 }).notNull(),
    kind: varchar('kind', { length: 30 }).$type<DatabaseMoveKind>().notNull(),
    status: varchar('status', { length: 20 }).$type<DatabaseMoveStatus>().notNull().default('queued'),
    /** Name of the Workflow step running or last run, for the admin progress view. */
    currentStep: varchar('current_step', { length: 60 }),
    /** What the admin asked for: `dedicated`, `shard:auto`, or a shard id (`nsp_…`). */
    requestedTarget: varchar('requested_target', { length: 40 }).notNull(),

    // Where the database was when the move started.
    sourceNeonProjectId: varchar('source_neon_project_id', { length: 100 }).notNull(),
    sourceNeonBranchId: varchar('source_neon_branch_id', { length: 100 }).notNull(),
    sourceDatabaseName: varchar('source_database_name', { length: 100 }).notNull(),
    sourceRoleName: varchar('source_role_name', { length: 100 }).notNull(),
    /** The source shard (`neon_shared_projects.id`), null for a dedicated source. */
    sourceSharedProjectId: varchar('source_shared_project_id', { length: 30 }),
    sourceRegion: varchar('source_region', { length: 50 }),

    // Where it is going. Filled in as soon as the target exists, so a failed or
    // cancelled move can always release it.
    targetNeonProjectId: varchar('target_neon_project_id', { length: 100 }),
    targetNeonBranchId: varchar('target_neon_branch_id', { length: 100 }),
    targetDatabaseName: varchar('target_database_name', { length: 100 }),
    targetRoleName: varchar('target_role_name', { length: 100 }),
    targetSharedProjectId: varchar('target_shared_project_id', { length: 30 }),
    targetRegion: varchar('target_region', { length: 50 }),
    /** The `database_pool` row the target was claimed from, if any. */
    targetPoolId: varchar('target_pool_id', { length: 30 }),
    /** Encrypted (DATABASE_ENCRYPTION_KEY keyring) target URL; cleared when the move ends. */
    targetDatabaseUrl: text('target_database_url'),

    progress: jsonb('progress').$type<DatabaseMoveProgress>(),
    verification: jsonb('verification').$type<DatabaseMoveVerification>(),

    workflowInstanceId: varchar('workflow_instance_id', { length: 100 }),

    startedBy: varchar('started_by', { length: 255 }).notNull(), // admin email
    startedByUserId: varchar('started_by_user_id', { length: 255 }),
    reason: text('reason'),
    cancelRequestedAt: timestamp('cancel_requested_at', { withTimezone: true }),
    error: text('error'),

    startedAt: timestamp('started_at', { withTimezone: true }),
    softLockedAt: timestamp('soft_locked_at', { withTimezone: true }),
    /** When the source role's password was rotated and the database set read-only. */
    lockedAt: timestamp('locked_at', { withTimezone: true }),
    switchedAt: timestamp('switched_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),

    /** The old database stays (read-only) until this time, then the daily sweep drops it. */
    oldDatabaseRetainedUntil: timestamp('old_database_retained_until', { withTimezone: true }),
    oldDatabaseDroppedAt: timestamp('old_database_dropped_at', { withTimezone: true }),
    oldDatabaseDropError: text('old_database_drop_error'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('workspace_database_moves_workspace_idx').on(table.workspaceId, table.createdAt),
    // At most one active move per workspace.
    uniqueIndex('workspace_database_moves_one_active_idx')
      .on(table.workspaceId)
      .where(sql`${table.status} in (${activeStatusesSql})`),
    // The retention sweep's lookup.
    index('workspace_database_moves_retention_idx')
      .on(table.oldDatabaseRetainedUntil)
      .where(sql`${table.oldDatabaseDroppedAt} is null and ${table.oldDatabaseRetainedUntil} is not null`),
  ],
);

export type WorkspaceDatabaseMove = typeof workspaceDatabaseMoves.$inferSelect;
export type NewWorkspaceDatabaseMove = typeof workspaceDatabaseMoves.$inferInsert;
