/**
 * The bodies of the move Workflow's steps. The Workflow (`workflows/move-
 * database.ts`) owns the order, the names, the sleeps and the retry settings;
 * everything a step actually does is here, as plain functions of `(deps,
 * moveId)`, so it can be tested without a Workflow runtime.
 *
 * Rules every step follows:
 *  - it starts with `advance`, which is the cancel check, the `current_step`
 *    marker and the read of the move row in one query;
 *  - it returns small JSON (counts, flags), never the catalog (~480 KB, over the
 *    Workflow's 1 MiB step-result budget once nested) and never a URL: whatever
 *    it needs it reads again from the move row, the workspace row or the source;
 *  - it is safe to run twice, because Cloudflare retries a failed step.
 *
 * Subrequests (every query or transaction on neon-http is one): the copy step
 * budgets itself to {@link COPY_STEP_SUBREQUEST_BUDGET}, the other steps stay
 * under ~30 except the migration step (<= 600 statements) and `finish-target`
 * (one per foreign key, <= {@link FINISH_FOREIGN_KEYS_PER_STEP}).
 */

import { directUrlOf } from '@weldsuite/neon-provisioning';
import { describeJournalGap, isAtJournalLevel, matchTenantJournal } from '@weldsuite/db/lib/tenant-journal';
import type { MoveTargetRequest } from '@weldsuite/neon-provisioning';
import type { DatabaseMoveProgress, DatabaseMoveVerification } from '@weldsuite/db/schema/master';
import {
  assertCopySupported,
  census,
  compareChecksums,
  copyTable,
  endOwnSession,
  finishTarget,
  journalsMatch,
  lockDatabase,
  pageSizeFor,
  planCopy,
  prepareTargetForCopy,
  probeReadOnly,
  readCatalog,
  readJournalSummary,
  readMaterializedViews,
  readSequences,
  readTables,
  sourceUnchanged,
  tableChecksums,
  terminateOtherSessions,
  GuardError,
  JournalMismatchError,
  type ChecksumMap,
  type JournalSummary,
  type TenantSql,
} from '../../lib/database-move';
import { recordMoveCompleted } from './audit';
import type { MoveDeps } from './deps';
import { MoveCancelledError, MoveFlowError } from './errors';
import { describeFailure } from './failure';
import {
  advance,
  loadWorkspace,
  requireMove,
  setSourceDatabaseUrl,
  switchWorkspace,
  updateMove,
  workspaceIsAtSource,
  writeProgress,
  type MoveRow,
  type WorkspaceRow,
} from './state';

// ── Tuning ───────────────────────────────────────────────────────────────

/** Statements per migration step (each is a neon-http subrequest; same budget the provisioning Workflow uses). */
export const MIGRATION_STATEMENTS_PER_STEP = 600;
/** Subrequests one copy step may spend before it returns and the Workflow starts the next one (limit: 1000). */
export const COPY_STEP_SUBREQUEST_BUDGET = 600;
/** Pages copied between two saves of the progress (a save is also the cancel check). */
export const PAGES_PER_PROGRESS_SAVE = 20;
/** Foreign keys re-added and validated per finishing step. */
export const FINISH_FOREIGN_KEYS_PER_STEP = 25;
/** A checksum step covers at most this many tables, and about this many (estimated) rows. */
export const CHECKSUM_GROUP_MAX_TABLES = 100;
export const CHECKSUM_GROUP_MAX_ROWS = 250_000;
/** Empty tables are only counted; this many per step. */
export const CHECKSUM_GROUP_EMPTY_TABLES = 300;

/** Pause between the soft lock and the lock: requests that started before it finish or fail. */
export const DRAIN_SECONDS = 90;
/** Pause between the first and the second session termination: pooled clients reconnect in that time. */
export const LOCK_SETTLE_SECONDS = 3;

function emptyProgress(): DatabaseMoveProgress {
  return { tables: [], copiedRows: 0, totalRows: null };
}

// ── Connections ──────────────────────────────────────────────────────────

/** Refuse to act on a workspace that is gone, being deleted, or no longer on the move's source database. */
function assertMovable(workspace: WorkspaceRow | undefined, move: MoveRow): WorkspaceRow & { databaseUrl: string } {
  if (!workspace) throw new MoveFlowError('WORKSPACE_NOT_FOUND', 'The workspace no longer exists');
  if (workspace.deletedAt || workspace.scheduledDeletionAt) {
    throw new MoveFlowError('WORKSPACE_NOT_MOVABLE', 'The workspace is deleted or scheduled for deletion');
  }
  if (!workspaceIsAtSource(workspace, move)) {
    throw new MoveFlowError('WORKSPACE_CHANGED', 'The workspace no longer points at the database the move started from');
  }
  if (!workspace.databaseUrl) throw new MoveFlowError('WORKSPACE_NOT_MOVABLE', 'The workspace has no stored database URL');
  return { ...workspace, databaseUrl: workspace.databaseUrl };
}

async function connectSourceOf(deps: MoveDeps, workspace: { id: string; databaseUrl: string }): Promise<TenantSql> {
  return deps.connect(directUrlOf(await deps.decryptUrl(workspace.databaseUrl, workspace.id)));
}

/** Workspace + a direct connection to the source (the URL the workspace row holds now, the rotated one after the lock). */
async function sourceContext(deps: MoveDeps, move: MoveRow) {
  const workspace = assertMovable(await loadWorkspace(deps.masterDb, move.workspaceId), move);
  return { workspace, source: await connectSourceOf(deps, workspace) };
}

async function connectTarget(deps: MoveDeps, move: MoveRow): Promise<TenantSql> {
  if (!move.targetDatabaseUrl) throw new MoveFlowError('TARGET_LOST', 'The move has no target database recorded');
  return deps.connect(directUrlOf(await deps.decryptUrl(move.targetDatabaseUrl, move.workspaceId)));
}

// ── Preparing (before any downtime) ──────────────────────────────────────

export type StepOk = { ok: true };

export async function beginMove(deps: MoveDeps, moveId: string): Promise<StepOk> {
  const move = await advance(deps.masterDb, moveId, { step: 'begin', status: 'preparing' }, deps.now());
  if (!move.startedAt) await updateMove(deps.masterDb, moveId, { startedAt: deps.now() }, deps.now());
  return { ok: true };
}

function describeJournal(journal: Pick<JournalSummary, 'count' | 'maxCreatedAt'> | null): string {
  if (!journal) return 'none';
  return `${journal.count} entries, newest ${journal.maxCreatedAt ?? 'none'}`;
}

/**
 * Everything that can be checked before the first request is refused: the
 * workspace is still where the move thinks, the source is at the bundled
 * migration level (so the target, migrated to the same, matches it), the
 * schema is one the copy supports, every non-empty table can be paged, and the
 * encryption key works (the lock must be able to store the rotated URL).
 */
export async function checkSource(deps: MoveDeps, moveId: string): Promise<{ tables: number; nonEmptyTables: number }> {
  const move = await advance(deps.masterDb, moveId, { step: 'check-source' }, deps.now());
  const { source } = await sourceContext(deps, move);

  // A lock that rotates the password but cannot store the new URL strands the workspace.
  await deps.encryptUrl('postgresql://check:check@check.invalid/check', move.workspaceId);

  // Judged migration by migration, not by count and newest row: drizzle's migrator skips a migration merged with
  // an older timestamp, and two runners record rows differently, so counts can agree while the schema does not.
  const journal = await readJournalSummary(source);
  const match = journal ? matchTenantJournal(journal.migrations, deps.bundledJournal.entries) : null;
  if (!match || !isAtJournalLevel(match)) {
    const gap = match ? describeJournalGap(match) : 'no migrations journal';
    throw new MoveFlowError(
      'SOURCE_NOT_CURRENT',
      `The source database is not at the bundled migration level: ${gap} (source: ${describeJournal(journal)}; ` +
        `bundled: ${describeJournal(deps.bundledJournal)}). Apply the tenant migrations to it first.`,
    );
  }
  assertCopySupported({ sequences: await readSequences(source) });

  const tables = await readTables(source);
  const nonEmpty = await census(source, tables);
  planCopy({ tables }, nonEmpty); // throws for a non-empty table without a primary key
  return { tables: tables.length, nonEmptyTables: nonEmpty.length };
}

/** Where the move wants its database to land, as `prepareMoveTarget` takes it. */
export function targetRequestOf(move: Pick<MoveRow, 'requestedTarget' | 'sourceSharedProjectId'>): MoveTargetRequest {
  if (move.requestedTarget === 'dedicated') return { kind: 'dedicated' };
  if (move.requestedTarget === 'shard:auto') {
    return move.sourceSharedProjectId
      ? { kind: 'shard', excludeShardId: move.sourceSharedProjectId }
      : { kind: 'shard' };
  }
  return { kind: 'shard', shardId: move.requestedTarget };
}

/**
 * Create (or claim) the target database and record it on the move row in the
 * same step, with its URL encrypted. A retried step finds the target on the row
 * and reuses it: the names are random, so preparing a second one would leak the
 * first. If recording it fails the target is released before the error leaves.
 */
export async function prepareTarget(
  deps: MoveDeps,
  moveId: string,
): Promise<{ reused: boolean; kind: 'dedicated' | 'shard'; claimedFromPool: boolean }> {
  const move = await advance(deps.masterDb, moveId, { step: 'prepare-target' }, deps.now());
  if (move.targetNeonProjectId && move.targetDatabaseUrl) {
    return {
      reused: true,
      kind: move.kind === 'shard_to_dedicated' ? 'dedicated' : 'shard',
      claimedFromPool: move.targetPoolId !== null,
    };
  }

  const workspace = await loadWorkspace(deps.masterDb, move.workspaceId);
  const region = workspace?.neonRegion || move.sourceRegion || deps.defaultRegion;
  const target = await deps.provisioning.prepareMoveTarget(deps.masterDb, {
    workspaceId: move.workspaceId,
    target: targetRequestOf(move),
    region,
  });

  try {
    await updateMove(
      deps.masterDb,
      moveId,
      {
        targetNeonProjectId: target.neonProjectId,
        targetNeonBranchId: target.neonBranchId,
        targetDatabaseName: target.databaseName,
        targetRoleName: target.roleName,
        targetSharedProjectId: target.sharedProjectId,
        targetRegion: target.region,
        targetPoolId: target.poolId,
        targetDatabaseUrl: await deps.encryptUrl(target.pooledUrl, move.workspaceId),
      },
      deps.now(),
    );
  } catch (error) {
    // Nothing points at the target yet and the row does not know it: give it back before it is lost.
    await deps.provisioning
      .releaseMoveTarget(deps.masterDb, {
        kind: target.kind,
        neonProjectId: target.neonProjectId,
        neonBranchId: target.neonBranchId,
        databaseName: target.databaseName,
        roleName: target.roleName,
        sharedProjectId: target.sharedProjectId,
        poolId: target.poolId,
      })
      .catch(() => undefined);
    throw error;
  }
  return { reused: false, kind: target.kind, claimedFromPool: target.poolId !== null };
}

/** Apply (a budget of) the bundled migrations to the target; a warm pool slot is already there and answers `remaining: 0`. */
export async function migrateTarget(
  deps: MoveDeps,
  moveId: string,
  step: string,
): Promise<{ applied: number; remaining: number }> {
  const move = await advance(deps.masterDb, moveId, { step }, deps.now());
  if (!move.targetDatabaseUrl) throw new MoveFlowError('TARGET_LOST', 'The move has no target database recorded');
  const url = directUrlOf(await deps.decryptUrl(move.targetDatabaseUrl, move.workspaceId));
  const result = await deps.migrate(url, MIGRATION_STATEMENTS_PER_STEP);
  return { applied: result.applied, remaining: result.remaining };
}

/** Last check before downtime: the migrated target and the source carry the same journal. */
export async function checkTargetLevel(deps: MoveDeps, moveId: string): Promise<{ journalEntries: number }> {
  const move = await advance(deps.masterDb, moveId, { step: 'target-ready' }, deps.now());
  const { source } = await sourceContext(deps, move);
  const target = await connectTarget(deps, move);
  const sourceJournal = await readJournalSummary(source);
  const targetJournal = await readJournalSummary(target);
  if (!journalsMatch(sourceJournal, targetJournal, deps.bundledJournal.entries)) {
    throw new JournalMismatchError(sourceJournal, targetJournal);
  }
  return { journalEntries: sourceJournal?.count ?? 0 };
}

// ── Locking the source ───────────────────────────────────────────────────

/**
 * Soft lock: from the moment the row says `soft_locked`, the first-party APIs
 * answer 503 WORKSPACE_MOVING for writes (worker-kit reads the row on a cache
 * miss). The purge makes cached entries re-read it.
 */
export async function softLock(deps: MoveDeps, moveId: string): Promise<StepOk> {
  const move = await advance(deps.masterDb, moveId, { step: 'soft-lock' }, deps.now());
  // Look at the workspace before refusing anyone a write: one that is going away is not soft-locked.
  const workspace = assertMovable(await loadWorkspace(deps.masterDb, move.workspaceId), move);
  await advance(
    deps.masterDb,
    moveId,
    { step: 'soft-lock', status: 'soft_locked', set: { softLockedAt: deps.now() } },
    deps.now(),
  );
  await deps.purgeCaches({ workspaceId: move.workspaceId, clerkOrgId: workspace.clerkOrgId });
  return { ok: true };
}

/**
 * Lock, part 1. Order matters:
 *  1. note on the row that the lock began (a failure from here on must unlock);
 *  2. rotate the SOURCE role's password;
 *  3. in the same step write the new pooled URL (encrypted) to the workspace
 *     row with a compare-and-set on the source, and purge the caches: requests
 *     holding the old URL now fail within about a second, and a read resolved
 *     after the purge works against the (soon read-only) source;
 *  4. make the database read-only for new sessions and end the open ones,
 *     this connection's own last: it was opened before the read-only default,
 *     and the neon-http proxy would hand it to the next request on the URL.
 * A retry rotates again and rewrites the URL, which is harmless.
 */
export async function lockSourcePartOne(deps: MoveDeps, moveId: string): Promise<{ found: number; terminated: number }> {
  const move = await advance(deps.masterDb, moveId, { step: 'lock-source' }, deps.now());
  const workspace = assertMovable(await loadWorkspace(deps.masterDb, move.workspaceId), move);

  const progress = move.progress ?? emptyProgress();
  if (!progress.lockStartedAt) {
    const { cancelRequested } = await writeProgress(
      deps.masterDb,
      moveId,
      { ...progress, lockStartedAt: deps.now().toISOString() },
      deps.now(),
    );
    // A cancel that arrived while this step started stops here, before the password is touched. The marker is
    // saved, so the undo checks the source; unlocking a database nothing locked is a no-op.
    if (cancelRequested) throw new MoveCancelledError();
  }

  const urls = await deps.provisioning.rotateRolePassword({
    neonProjectId: move.sourceNeonProjectId,
    neonBranchId: move.sourceNeonBranchId,
    databaseName: move.sourceDatabaseName,
    roleName: move.sourceRoleName,
    sharedProjectId: move.sourceSharedProjectId,
  });
  const encrypted = await deps.encryptUrl(urls.pooledUrl, move.workspaceId);
  if (!(await setSourceDatabaseUrl(deps.masterDb, move, encrypted, deps.now()))) {
    throw new MoveFlowError('WORKSPACE_CHANGED', 'The workspace no longer points at the database the move started from');
  }
  await deps.purgeCaches({ workspaceId: move.workspaceId, clerkOrgId: workspace.clerkOrgId });

  const source = deps.connect(urls.directUrl);
  await lockDatabase(source, move.sourceDatabaseName);
  const { found, terminated } = await terminateOtherSessions(source);
  await endOwnSession(source);
  return { found, terminated };
}

/**
 * Lock, part 2 (after a short pause): end the sessions that reconnected and this
 * connection's own, restart a DEDICATED source's compute (ends PgBouncer client
 * sessions that survive a rotation; never done for a shard, whose compute
 * serves other tenants), check that a fresh session really is read-only, and
 * only then say `locked`.
 */
export async function lockSourcePartTwo(deps: MoveDeps, moveId: string): Promise<{ restarted: boolean }> {
  const move = await advance(deps.masterDb, moveId, { step: 'lock-source-verify' }, deps.now());
  const { source } = await sourceContext(deps, move);
  await terminateOtherSessions(source);
  // The proxy may have handed this step a session from before the lock (part 1 retried, or ended early).
  await endOwnSession(source);

  const dedicated = move.sourceSharedProjectId === null;
  if (dedicated) await deps.provisioning.restartDedicatedEndpoint(deps.masterDb, move.sourceNeonProjectId);

  // A fresh connection: after the restart the earlier one is gone.
  const { source: fresh } = await sourceContext(deps, move);
  if ((await probeReadOnly(fresh)) !== 'on') {
    throw new GuardError('The source database accepted a new session in read-write mode after the lock');
  }
  await advance(deps.masterDb, moveId, { step: 'locked', status: 'locked', set: { lockedAt: deps.now() } }, deps.now());
  return { restarted: dedicated };
}

// ── Copying ──────────────────────────────────────────────────────────────

export interface CopyPlanSummary {
  tables: number;
  emptyTables: number;
  /** How many checksum steps each pass (source, target, source again) takes. */
  checksumGroups: number;
  truncatedTables: number;
  droppedForeignKeys: number;
  extraTargetTables: number;
}

/**
 * Split the verification work into steps of bounded cost: tables in plan order
 * (smallest first) until a group holds {@link CHECKSUM_GROUP_MAX_TABLES} tables
 * or about {@link CHECKSUM_GROUP_MAX_ROWS} estimated rows, then the empty tables
 * (only counted) in chunks. A function of the persisted plan, so the source,
 * target and re-check passes all use the same groups.
 */
export function checksumGroupsOf(progress: Pick<DatabaseMoveProgress, 'tables' | 'emptyTables'>): string[][] {
  const groups: string[][] = [];
  let current: string[] = [];
  let rows = 0;
  for (const table of progress.tables) {
    const estimate = table.estimatedRows ?? 0;
    const full = current.length >= CHECKSUM_GROUP_MAX_TABLES || rows + estimate > CHECKSUM_GROUP_MAX_ROWS;
    if (current.length > 0 && full) {
      groups.push(current);
      current = [];
      rows = 0;
    }
    current.push(table.table);
    rows += estimate;
  }
  if (current.length > 0) groups.push(current);
  const empty = progress.emptyTables ?? [];
  for (let start = 0; start < empty.length; start += CHECKSUM_GROUP_EMPTY_TABLES) {
    groups.push(empty.slice(start, start + CHECKSUM_GROUP_EMPTY_TABLES));
  }
  return groups;
}

/**
 * Prepare the target for the bulk copy (truncate, drop foreign keys, disable
 * user triggers), read what is non-empty and plan the copy. Runs once: it
 * truncates, so after `prepared` is saved a repeat is a no-op. Before that it is
 * one transaction on the target, so retrying the step itself is safe.
 */
export async function prepareCopy(deps: MoveDeps, moveId: string): Promise<CopyPlanSummary> {
  const move = await advance(deps.masterDb, moveId, { step: 'prepare-copy', status: 'copying' }, deps.now());
  const progress = move.progress ?? emptyProgress();
  if (progress.prepared) {
    return {
      tables: progress.tables.length,
      emptyTables: progress.emptyTables?.length ?? 0,
      checksumGroups: checksumGroupsOf(progress).length,
      truncatedTables: 0,
      droppedForeignKeys: 0,
      extraTargetTables: 0,
    };
  }

  const { source } = await sourceContext(deps, move);
  const target = await connectTarget(deps, move);
  const catalog = await readCatalog(source);
  const prepared = await prepareTargetForCopy(target, catalog, deps.bundledJournal.entries);
  const nonEmpty = await census(source, catalog.tables);
  const plan = planCopy(catalog, nonEmpty);

  const nonEmptySet = new Set(nonEmpty);
  const next: DatabaseMoveProgress = {
    ...progress,
    tables: plan.tables.map((t) => ({
      table: t.name,
      rows: 0,
      cursor: null,
      done: false,
      pageSize: t.pageSize,
      estimatedRows: t.estimatedRows,
    })),
    copiedRows: 0,
    totalRows: plan.tables.length > 0 ? plan.tables.reduce((sum, t) => sum + (t.estimatedRows ?? 0), 0) : 0,
    prepared: true,
    saved: prepared.saved,
    emptyTables: catalog.tables.map((t) => t.name).filter((name) => !nonEmptySet.has(name)),
  };
  await writeProgress(deps.masterDb, moveId, next, deps.now());
  return {
    tables: next.tables.length,
    emptyTables: next.emptyTables?.length ?? 0,
    checksumGroups: checksumGroupsOf(next).length,
    truncatedTables: prepared.truncatedTables,
    droppedForeignKeys: prepared.droppedForeignKeys,
    extraTargetTables: prepared.extraTargetTables.length,
  };
}

export type ChecksumSide = 'source' | 'target';

/** Count and checksum one group of tables on one side. Returns the partial map; the Workflow merges them. */
export async function checksumGroup(
  deps: MoveDeps,
  moveId: string,
  step: string,
  side: ChecksumSide,
  group: number,
): Promise<ChecksumMap> {
  const move = await advance(deps.masterDb, moveId, { step }, deps.now());
  const names = checksumGroupsOf(move.progress ?? emptyProgress())[group];
  if (!names) throw new MoveFlowError('VERIFICATION_FAILED', `Checksum group ${group} does not exist`);
  const sql = side === 'source' ? (await sourceContext(deps, move)).source : await connectTarget(deps, move);
  return tableChecksums(sql, await readTables(sql, names));
}

/** Save the source checksums taken before the copy, and the exact row total they give. */
export async function recordSourceChecksums(
  deps: MoveDeps,
  moveId: string,
  checksums: ChecksumMap,
): Promise<{ tables: number; totalRows: number }> {
  const move = await advance(deps.masterDb, moveId, { step: 'record-source-checksums' }, deps.now());
  const totalRows = Object.values(checksums).reduce((sum, c) => sum + c.count, 0);
  await writeProgress(
    deps.masterDb,
    moveId,
    { ...(move.progress ?? emptyProgress()), sourceChecksums: checksums, totalRows },
    deps.now(),
  );
  return { tables: Object.keys(checksums).length, totalRows };
}

/**
 * Copy for a while, then return so the Workflow can start the next step.
 *
 * Tables are taken in plan order (smallest first), resuming at each table's
 * saved cursor. Pages run in slices of {@link PAGES_PER_PROGRESS_SAVE}; after
 * each slice the progress is saved, and that save also reports a cancel, so a
 * cancel stops the copy within about twenty pages. A page that ran but whose
 * progress was not saved (a crash) is simply read again: the insert is
 * `ON CONFLICT DO NOTHING`, so a replayed page adds nothing.
 */
export async function copyChunk(
  deps: MoveDeps,
  moveId: string,
  step: string,
): Promise<{ done: boolean; copiedRows: number; tablesLeft: number }> {
  const move = await advance(deps.masterDb, moveId, { step }, deps.now());
  const progress = move.progress ?? emptyProgress();
  if (!progress.prepared) throw new MoveFlowError('TARGET_LOST', 'The target was not prepared for the copy');

  const { source } = await sourceContext(deps, move);
  const target = await connectTarget(deps, move);

  let used = 3; // advance, workspace, and the first save below
  let unsaved = false;
  const save = async (): Promise<void> => {
    progress.copiedRows = progress.tables.reduce((sum, t) => sum + t.rows, 0);
    const { cancelRequested } = await writeProgress(deps.masterDb, moveId, progress, deps.now());
    used += 1;
    unsaved = false;
    if (cancelRequested) throw new MoveCancelledError();
  };

  for (const entry of progress.tables) {
    if (entry.done) continue;
    if (used >= COPY_STEP_SUBREQUEST_BUDGET) break;

    const [info] = await readTables(source, [entry.table]);
    used += 1;
    if (!info) {
      throw new MoveFlowError('SOURCE_NOT_CURRENT', `Table "${entry.table}" is no longer in the source database`);
    }

    while (!entry.done) {
      const pages = Math.min(PAGES_PER_PROGRESS_SAVE, Math.floor((COPY_STEP_SUBREQUEST_BUDGET - used - 1) / 2));
      if (pages < 1) break;
      const result = await copyTable(source, target, info, entry.cursor, {
        pageSize: entry.pageSize ?? pageSizeFor(info),
        maxPages: pages,
      });
      used += result.pages * 2;
      entry.cursor = result.cursor;
      entry.done = result.done;
      entry.rows += result.readRows;
      unsaved = true;
      await save();
    }
  }
  if (unsaved) await save();

  const tablesLeft = progress.tables.filter((t) => !t.done).length;
  return { done: tablesLeft === 0, copiedRows: progress.copiedRows, tablesLeft };
}

// ── Verifying ────────────────────────────────────────────────────────────

/** Re-add and validate (a slice of) the foreign keys, re-enable the triggers, refresh the views. */
export async function finishTargetStep(
  deps: MoveDeps,
  moveId: string,
  step: string,
): Promise<{ complete: boolean; remainingForeignKeys: number }> {
  const move = await advance(deps.masterDb, moveId, { step, status: 'verifying' }, deps.now());
  const saved = move.progress?.saved;
  if (!saved) throw new MoveFlowError('TARGET_LOST', 'The target was not prepared for the copy');
  const { source } = await sourceContext(deps, move);
  const target = await connectTarget(deps, move);
  const result = await finishTarget(
    target,
    saved,
    { materializedViews: await readMaterializedViews(source) },
    { maxForeignKeys: FINISH_FOREIGN_KEYS_PER_STEP },
  );
  return { complete: result.complete, remainingForeignKeys: result.remainingForeignKeys };
}

/** Refresh planner statistics on the target. Best effort: a failure is a warning, never a failed move. */
export async function analyzeTarget(
  deps: MoveDeps,
  moveId: string,
): Promise<{ analysed: boolean; warning: string | null }> {
  const move = await advance(deps.masterDb, moveId, { step: 'analyze-target', status: 'verifying' }, deps.now());
  try {
    await (await connectTarget(deps, move)).query('ANALYZE');
    return { analysed: true, warning: null };
  } catch (error) {
    return { analysed: false, warning: `ANALYZE on the target failed (${describeFailure(error)})` };
  }
}

export interface VerificationInput {
  sourceBefore: ChecksumMap;
  target: ChecksumMap;
  sourceAfter: ChecksumMap;
  warnings: string[];
}

/** Compare the three readings, save the outcome on the row, and fail the move on any difference. */
export async function verifyMove(
  deps: MoveDeps,
  moveId: string,
  input: VerificationInput,
): Promise<{ ok: true; tables: number }> {
  await advance(deps.masterDb, moveId, { step: 'verify-compare', status: 'verifying' }, deps.now());
  const comparison = compareChecksums(input.sourceBefore, input.target);
  const unchanged = sourceUnchanged(input.sourceBefore, input.sourceAfter);

  const verification: DatabaseMoveVerification = {
    tables: comparison.tables.map((c) => ({
      table: c.table,
      sourceRows: c.source?.count ?? 0,
      targetRows: c.target?.count ?? 0,
      sourceHash: c.source?.hash ?? null,
      targetHash: c.target?.hash ?? null,
      ok: c.ok,
    })),
    ok: comparison.ok && unchanged.unchanged,
    verifiedAt: deps.now().toISOString(),
    sourceUnchanged: unchanged.unchanged,
    sourceChangedTables: unchanged.changedTables,
    ...(input.warnings.length > 0 ? { warnings: input.warnings } : {}),
  };
  await updateMove(deps.masterDb, moveId, { verification }, deps.now());

  if (!verification.ok) {
    const names = (list: readonly string[]) => list.slice(0, 10).join(', ') + (list.length > 10 ? ', ...' : '');
    const parts: string[] = [];
    if (!comparison.ok) parts.push(`the copy differs from the source in ${comparison.mismatched.length} table(s): ${names(comparison.mismatched)}`);
    if (!unchanged.unchanged) {
      parts.push(`the source changed after the lock in ${unchanged.changedTables.length} table(s): ${names(unchanged.changedTables)}`);
    }
    throw new MoveFlowError('VERIFICATION_FAILED', `Verification failed: ${parts.join('; ')}`);
  }
  return { ok: true, tables: verification.tables.length };
}

// ── Switching ────────────────────────────────────────────────────────────

/**
 * The switch. A cancel arriving after this step starts is refused by the cancel
 * route (status `switching`); one that won the race makes `advance` throw and
 * the Workflow compensates. A retry of a step that already committed finds the
 * row `completed` and returns.
 */
export async function switchToTarget(deps: MoveDeps, moveId: string): Promise<{ switched: true }> {
  const existing = await requireMove(deps.masterDb, moveId);
  if (existing.status === 'completed') {
    // A retry after the commit: make sure the trail has the row (a no-op when it already does).
    await recordMoveCompleted(deps.masterDb, existing);
    return { switched: true };
  }

  const move = await advance(deps.masterDb, moveId, { step: 'switch', status: 'switching' }, deps.now());
  assertMovable(await loadWorkspace(deps.masterDb, move.workspaceId), move);

  const now = deps.now();
  const retainedUntil = new Date(now.getTime() + deps.retentionDays * 24 * 60 * 60 * 1000);
  const { switched } = await switchWorkspace(deps.masterDb, move, retainedUntil, now);
  if (!switched) {
    throw new MoveFlowError(
      'WORKSPACE_CHANGED',
      'The workspace changed while the database was being copied; the switch was not applied',
    );
  }
  await recordMoveCompleted(deps.masterDb, await requireMove(deps.masterDb, moveId));
  return { switched: true };
}

/** After the switch: drop every cached copy of the old resolution. Never throws. */
export async function purgeAfterSwitch(deps: MoveDeps, moveId: string): Promise<StepOk> {
  const move = await requireMove(deps.masterDb, moveId);
  const workspace = await loadWorkspace(deps.masterDb, move.workspaceId);
  await deps.purgeCaches({ workspaceId: move.workspaceId, clerkOrgId: workspace?.clerkOrgId ?? null });
  return { ok: true };
}
