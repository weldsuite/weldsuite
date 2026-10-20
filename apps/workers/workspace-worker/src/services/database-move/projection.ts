/**
 * What the admin API shows of a `workspace_database_moves` row.
 *
 * The row holds things that must never leave the worker: the encrypted target
 * URL, and a `progress` blob with the saved foreign keys and triggers, the
 * source checksums (50-100 KB) and, per table, the copy cursor (the last
 * primary key copied: for some tables an email address). The projection is an
 * allow-list, so a column added to the table later is not exposed until it is
 * added here; the columns are selected explicitly for the same reason, so the
 * URL is not even read.
 */

import { desc, eq, sql } from 'drizzle-orm';
import {
  workspaceDatabaseMoves,
  type DatabaseMoveKind,
  type DatabaseMoveProgress,
  type DatabaseMoveStatus,
  type DatabaseMoveVerification,
} from '@weldsuite/db/schema/master';
import type { MasterDatabase } from '../../db';

const m = workspaceDatabaseMoves;

/** Where a database lives or is going: coordinates only, no role, no URL. */
export interface MovePlacementView {
  neonProjectId: string | null;
  databaseName: string | null;
  sharedProjectId: string | null;
  region: string | null;
}

export interface MoveTableProgressView {
  table: string;
  rows: number;
  done: boolean;
  estimatedRows: number | null;
}

export interface MoveProgressView {
  copiedRows: number;
  totalRows: number | null;
  /** Only in the single-move view. */
  tables?: MoveTableProgressView[];
}

export interface MoveVerificationView {
  ok: boolean;
  verifiedAt: string;
  tableCount: number;
  /** Tables whose copy differs from the source (names only). */
  mismatchedTables: string[];
  sourceUnchanged: boolean | null;
  sourceChangedTables: string[];
  warnings: string[];
}

export interface DatabaseMoveView {
  id: string;
  workspaceId: string;
  kind: DatabaseMoveKind;
  status: DatabaseMoveStatus;
  currentStep: string | null;
  requestedTarget: string;
  source: MovePlacementView;
  target: MovePlacementView | null;
  progress: MoveProgressView | null;
  /** Only in the single-move view. */
  verification?: MoveVerificationView | null;
  startedBy: string;
  reason: string | null;
  error: string | null;
  cancelRequestedAt: string | null;
  startedAt: string | null;
  softLockedAt: string | null;
  lockedAt: string | null;
  switchedAt: string | null;
  completedAt: string | null;
  oldDatabaseRetainedUntil: string | null;
  oldDatabaseDroppedAt: string | null;
  oldDatabaseDropError: string | null;
  createdAt: string;
  updatedAt: string;
}

/** The columns the API reads: everything it shows, never `target_database_url`. */
const baseColumns = {
  id: m.id,
  workspaceId: m.workspaceId,
  kind: m.kind,
  status: m.status,
  currentStep: m.currentStep,
  requestedTarget: m.requestedTarget,
  sourceNeonProjectId: m.sourceNeonProjectId,
  sourceDatabaseName: m.sourceDatabaseName,
  sourceSharedProjectId: m.sourceSharedProjectId,
  sourceRegion: m.sourceRegion,
  targetNeonProjectId: m.targetNeonProjectId,
  targetDatabaseName: m.targetDatabaseName,
  targetSharedProjectId: m.targetSharedProjectId,
  targetRegion: m.targetRegion,
  startedBy: m.startedBy,
  reason: m.reason,
  error: m.error,
  cancelRequestedAt: m.cancelRequestedAt,
  startedAt: m.startedAt,
  softLockedAt: m.softLockedAt,
  lockedAt: m.lockedAt,
  switchedAt: m.switchedAt,
  completedAt: m.completedAt,
  oldDatabaseRetainedUntil: m.oldDatabaseRetainedUntil,
  oldDatabaseDroppedAt: m.oldDatabaseDroppedAt,
  oldDatabaseDropError: m.oldDatabaseDropError,
  createdAt: m.createdAt,
  updatedAt: m.updatedAt,
};

/** One move with its progress and verification (both read whole, then projected). */
const detailColumns = {
  ...baseColumns,
  progress: m.progress,
  verification: m.verification,
};

/** A move in a list: the two progress counters are pulled out of the jsonb in SQL, the blob is never read. */
const summaryColumns = {
  ...baseColumns,
  copiedRows: sql<string | null>`${m.progress}->>'copiedRows'`,
  totalRows: sql<string | null>`${m.progress}->>'totalRows'`,
};

type BaseRow = {
  [K in keyof typeof baseColumns]: (typeof baseColumns)[K]['_']['data'];
};
type DetailRow = BaseRow & { progress: DatabaseMoveProgress | null; verification: DatabaseMoveVerification | null };
type SummaryRow = BaseRow & { copiedRows: string | null; totalRows: string | null };

const iso = (value: Date | null): string | null => (value ? value.toISOString() : null);

function numberOrNull(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function baseView(row: BaseRow): Omit<DatabaseMoveView, 'progress'> {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    kind: row.kind,
    status: row.status,
    currentStep: row.currentStep,
    requestedTarget: row.requestedTarget,
    source: {
      neonProjectId: row.sourceNeonProjectId,
      databaseName: row.sourceDatabaseName,
      sharedProjectId: row.sourceSharedProjectId,
      region: row.sourceRegion,
    },
    target: row.targetNeonProjectId
      ? {
          neonProjectId: row.targetNeonProjectId,
          databaseName: row.targetDatabaseName,
          sharedProjectId: row.targetSharedProjectId,
          region: row.targetRegion,
        }
      : null,
    startedBy: row.startedBy,
    reason: row.reason,
    error: row.error,
    cancelRequestedAt: iso(row.cancelRequestedAt),
    startedAt: iso(row.startedAt),
    softLockedAt: iso(row.softLockedAt),
    lockedAt: iso(row.lockedAt),
    switchedAt: iso(row.switchedAt),
    completedAt: iso(row.completedAt),
    oldDatabaseRetainedUntil: iso(row.oldDatabaseRetainedUntil),
    oldDatabaseDroppedAt: iso(row.oldDatabaseDroppedAt),
    oldDatabaseDropError: row.oldDatabaseDropError,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Copy progress as the console draws it: the counters and, per table, rows and whether it is done. No cursors. */
export function projectProgress(progress: DatabaseMoveProgress | null, withTables: boolean): MoveProgressView | null {
  if (!progress) return null;
  return {
    copiedRows: progress.copiedRows,
    totalRows: progress.totalRows,
    ...(withTables
      ? {
          tables: progress.tables.map((t) => ({
            table: t.table,
            rows: t.rows,
            done: t.done,
            estimatedRows: t.estimatedRows ?? null,
          })),
        }
      : {}),
  };
}

/** Verification as a verdict plus table names: no hashes, no per-table rows. */
export function projectVerification(verification: DatabaseMoveVerification | null): MoveVerificationView | null {
  if (!verification) return null;
  return {
    ok: verification.ok,
    verifiedAt: verification.verifiedAt,
    tableCount: verification.tables.length,
    mismatchedTables: verification.tables.filter((t) => !t.ok).map((t) => t.table),
    sourceUnchanged: verification.sourceUnchanged ?? null,
    sourceChangedTables: verification.sourceChangedTables ?? [],
    warnings: verification.warnings ?? [],
  };
}

function detailView(row: DetailRow): DatabaseMoveView {
  return {
    ...baseView(row),
    progress: projectProgress(row.progress, true),
    verification: projectVerification(row.verification),
  };
}

function summaryView(row: SummaryRow): DatabaseMoveView {
  const copied = numberOrNull(row.copiedRows);
  return {
    ...baseView(row),
    progress: copied === null ? null : { copiedRows: copied, totalRows: numberOrNull(row.totalRows) },
  };
}

/** One move for polling, or undefined when there is none with that id. */
export async function loadMoveView(db: MasterDatabase, moveId: string): Promise<DatabaseMoveView | undefined> {
  const [row] = await db.select(detailColumns).from(m).where(eq(m.id, moveId)).limit(1);
  return row ? detailView(row as DetailRow) : undefined;
}

export const RECENT_MOVES_LIMIT = 20;

/** The workspace's most recent moves, newest first, without the per-table progress. */
export async function listMoveViews(
  db: MasterDatabase,
  workspaceId: string,
  limit: number = RECENT_MOVES_LIMIT,
): Promise<DatabaseMoveView[]> {
  const rows = await db
    .select(summaryColumns)
    .from(m)
    .where(eq(m.workspaceId, workspaceId))
    .orderBy(desc(m.createdAt))
    .limit(limit);
  return rows.map((row) => summaryView(row as SummaryRow));
}
