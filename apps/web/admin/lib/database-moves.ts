// Database moves as the console sees them (task 1150, phase 3): the shapes the
// workspace worker's admin API answers with, and the pure rules the screens
// follow. Client-safe: no `server-only`, no database imports, so the move
// dialog and the live move panel can use it too.
//
// The worker owns the moves (apps/workers/workspace-worker, routes/admin-databases.ts
// and services/database-move/projection.ts); these types mirror its projection,
// which never carries a database URL, a role or the saved copy state.

import { shardFill, type DatabasePlacement, type ShardFill } from './databases';

// ---------------------------------------------------------------------------
// Statuses
// ---------------------------------------------------------------------------

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

export type DatabaseMoveKind = 'shard_to_dedicated' | 'dedicated_to_shard' | 'shard_to_shard';

/** A move that has not ended: the workspace has, or is about to have, a paused database. */
export const ACTIVE_MOVE_STATUSES: readonly DatabaseMoveStatus[] = [
  'queued',
  'preparing',
  'soft_locked',
  'locked',
  'copying',
  'verifying',
  'switching',
  'cancelling',
];

/** What a cancel can still stop: everything before the switch (the worker's CANCELLABLE_MOVE_STATUSES). */
export const CANCELLABLE_MOVE_STATUSES: readonly DatabaseMoveStatus[] = [
  'queued',
  'preparing',
  'soft_locked',
  'locked',
  'copying',
  'verifying',
];

/** The happy path, in order, for the step list on a running move. */
export const MOVE_STEPS = [
  'queued',
  'preparing',
  'soft_locked',
  'locked',
  'copying',
  'verifying',
  'switching',
  'completed',
] as const satisfies readonly DatabaseMoveStatus[];

/**
 * A move that has not changed for this long while still running is taken to
 * have lost its Workflow, so the console offers a forced recovery. Copying a
 * large table writes progress every batch, so a live move never sits this long.
 */
export const STALE_MOVE_MS = 15 * 60_000;

/** How often the panel asks for a running move's state. */
export const MOVE_POLL_INTERVAL_MS = 5_000;

export function isMoveStatus(value: unknown): value is DatabaseMoveStatus {
  return typeof value === 'string' && (DATABASE_MOVE_STATUSES as readonly string[]).includes(value);
}

export function isActiveMove(status: DatabaseMoveStatus): boolean {
  return ACTIVE_MOVE_STATUSES.includes(status);
}

/** Where `status` is on {@link MOVE_STEPS}, or -1 for a move that left the happy path (failed, cancelled). */
export function moveStepIndex(status: DatabaseMoveStatus): number {
  return (MOVE_STEPS as readonly DatabaseMoveStatus[]).indexOf(status);
}

// ---------------------------------------------------------------------------
// Views (mirroring the worker's projection)
// ---------------------------------------------------------------------------

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

/** Enough of a move view to render it: a worker that answers something else is shown as an error, not trusted. */
export function isDatabaseMoveView(value: unknown): value is DatabaseMoveView {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === 'string' &&
    typeof v.workspaceId === 'string' &&
    isMoveStatus(v.status) &&
    typeof v.kind === 'string' &&
    typeof v.createdAt === 'string' &&
    typeof v.updatedAt === 'string' &&
    typeof v.source === 'object' &&
    v.source !== null
  );
}

export function isDatabaseMoveList(value: unknown): value is DatabaseMoveView[] {
  return Array.isArray(value) && value.every(isDatabaseMoveView);
}

// ---------------------------------------------------------------------------
// Live Neon state (GET /databases/live) and shard sizes
// ---------------------------------------------------------------------------

export interface EndpointView {
  id: string;
  type: string;
  /** `active`, `idle`, `init`, ... as Neon reports it. */
  currentState: string;
  minCu: number | null;
  maxCu: number | null;
  suspendTimeoutSeconds: number | null;
  lastActive: string | null;
}

export interface ProjectLiveState {
  neonProjectId: string;
  endpoints: EndpointView[];
  error: string | null;
}

export interface ShardLiveState extends ProjectLiveState {
  shardId: string;
  name: string;
  region: string;
  status: string;
  databaseCount: number;
  maxDatabases: number;
}

export interface LiveDatabases {
  shards: ShardLiveState[];
  dedicated: ProjectLiveState[];
  fetchedAt: string;
}

/** The most a single `/databases/live` call may name (the worker's MAX_LIVE_PROJECT_IDS). */
export const MAX_LIVE_PROJECT_IDS = 50;

export function isLiveDatabases(value: unknown): value is LiveDatabases {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return Array.isArray(v.shards) && Array.isArray(v.dedicated) && typeof v.fetchedAt === 'string';
}

export interface ShardSizeView {
  databaseName: string;
  sizeBytes: number;
  workspaceId: string | null;
}

export interface ShardSizes {
  shardId: string;
  neonProjectId: string;
  databases: ShardSizeView[];
  totalBytes: number;
}

export function isShardSizes(value: unknown): value is ShardSizes {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.shardId === 'string' && Array.isArray(v.databases) && typeof v.totalBytes === 'number';
}

/** What a screen gets for a worker-backed panel; never throws. */
export type WorkerState<T> = { kind: 'ok'; data: T } | { kind: 'not_configured' } | { kind: 'error'; message: string };

/**
 * The compute of a project in one word: `active` when any endpoint runs,
 * `suspended` when all are idle, `unknown` when Neon did not say.
 */
export type ComputeState = 'active' | 'suspended' | 'starting' | 'unknown';

export function computeState(project: Pick<ProjectLiveState, 'endpoints' | 'error'> | undefined): ComputeState {
  if (!project || project.error || project.endpoints.length === 0) return 'unknown';
  const states = project.endpoints.map((endpoint) => endpoint.currentState);
  if (states.includes('active')) return 'active';
  if (states.includes('init')) return 'starting';
  if (states.every((state) => state === 'idle')) return 'suspended';
  return 'unknown';
}

/** The live state per Neon project id, for tables that list projects. */
export function liveByProjectId(live: LiveDatabases): Map<string, ProjectLiveState> {
  const map = new Map<string, ProjectLiveState>();
  for (const shard of live.shards) map.set(shard.neonProjectId, shard);
  for (const project of live.dedicated) map.set(project.neonProjectId, project);
  return map;
}

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const;

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  const digits = unit === 0 || value >= 100 ? 0 : 1;
  return `${value.toFixed(digits)} ${BYTE_UNITS[unit]}`;
}

// ---------------------------------------------------------------------------
// Progress and allowed actions
// ---------------------------------------------------------------------------

/** Copy progress as a whole percentage, or null while the total is unknown. */
export function moveProgressPercent(progress: MoveProgressView | null): number | null {
  if (!progress?.totalRows || progress.totalRows <= 0) return null;
  return Math.min(100, Math.floor((progress.copiedRows / progress.totalRows) * 100));
}

/** True when a running move has not changed for {@link STALE_MOVE_MS}. */
export function isStaleMove(move: Pick<DatabaseMoveView, 'status' | 'updatedAt'>, now: number = Date.now()): boolean {
  if (!isActiveMove(move.status)) return false;
  const updated = Date.parse(move.updatedAt);
  return Number.isFinite(updated) && now - updated >= STALE_MOVE_MS;
}

export function canCancelMove(move: Pick<DatabaseMoveView, 'status' | 'cancelRequestedAt'>): boolean {
  return CANCELLABLE_MOVE_STATUSES.includes(move.status) && !move.cancelRequestedAt;
}

/**
 * What the recovery button may do for a move:
 * - `recover` for a failed or cancelling move: finish undoing it (unlock the
 *   source, give the target back); the worker does nothing that is already done;
 * - `force` for a running move that went stale: its Workflow is presumed dead;
 * - `none` otherwise (completed, cancelled, or still making progress).
 */
export type RecoverMode = 'recover' | 'force' | 'none';

export function recoverMode(
  move: Pick<DatabaseMoveView, 'status' | 'updatedAt'>,
  now: number = Date.now(),
): RecoverMode {
  if (move.status === 'failed' || move.status === 'cancelling') return 'recover';
  if (isStaleMove(move, now)) return 'force';
  return 'none';
}

// ---------------------------------------------------------------------------
// Move targets
// ---------------------------------------------------------------------------

/** `dedicated`, `shard:auto` or a shard id: what the worker's start route accepts. */
export const MOVE_TARGET_PATTERN = /^(dedicated|shard:auto|nsp_[a-z0-9]{1,30})$/;

export const MOVE_REASON_MIN = 3;
export const MOVE_REASON_MAX = 2000;

export function isMoveTarget(value: unknown): value is string {
  return typeof value === 'string' && MOVE_TARGET_PATTERN.test(value);
}

export interface MoveTargetShard {
  id: string;
  name: string;
  databaseCount: number;
  maxDatabases: number;
  fill: ShardFill;
}

export interface MoveTargets {
  /** A shared database can get a project of its own. */
  dedicated: boolean;
  /** Let the worker pick a shard with room in the region. */
  auto: boolean;
  /** Shards it can move to, emptiest first. */
  shards: MoveTargetShard[];
}

/** The shard fields the target list needs; the overview's ShardSummary has them all. */
export interface ShardCandidate {
  id: string;
  neonProjectName: string;
  region: string;
  status: string;
  databaseCount: number;
  maxDatabases: number;
}

/**
 * Where a workspace's database can go. Nothing for a workspace without a
 * database. A shard qualifies when it is active, in the workspace's region,
 * has room and is not the one the database is on: the same rules the worker
 * applies, so the dialog does not offer a target it would refuse.
 */
export function moveTargets(
  database: {
    placement: DatabasePlacement;
    region: string | null;
    shardId: string | null;
  },
  shards: readonly ShardCandidate[],
): MoveTargets {
  if (database.placement === 'none' || !database.region) return { dedicated: false, auto: false, shards: [] };
  const candidates = shards
    .filter(
      (shard) =>
        shard.status === 'active' &&
        shard.region === database.region &&
        shard.id !== database.shardId &&
        shard.databaseCount < shard.maxDatabases,
    )
    .map((shard) => ({
      id: shard.id,
      name: shard.neonProjectName,
      databaseCount: shard.databaseCount,
      maxDatabases: shard.maxDatabases,
      fill: shardFill(shard.databaseCount, shard.maxDatabases),
    }))
    .sort((a, b) => a.fill.percent - b.fill.percent || a.name.localeCompare(b.name));
  return {
    dedicated: database.placement === 'shared',
    auto: candidates.length > 0,
    shards: candidates,
  };
}

export function hasMoveTargets(targets: MoveTargets): boolean {
  return targets.dedicated || targets.auto || targets.shards.length > 0;
}
