// Where workspace databases live, and how full a shard is (task 1150, phase 1).
//
// Pure and framework-free, so client and server code can both use it and it
// can be unit-tested without a database. The master-DB queries are in
// ./databases-data.ts, the screens in app/databases and the Database tab of the
// workspace detail.
//
// How the numbers fit together (packages/core/neon-provisioning/src/provisioning.ts):
//   - A shared shard is a Neon project holding many workspace databases.
//     `neon_shared_projects.database_count` is bumped when a database is
//     RESERVED on it (claimSharedProject) and dropped when it is released or its
//     workspace is torn down.
//   - A reservation is made for a workspace that provisions on the shard, and
//     for every warm pool slot created there. A warm slot that gets claimed
//     keeps its `database_pool` row (status `assigned`) and becomes the
//     workspace's database, so an assigned slot and its workspace are ONE
//     database and must not be counted twice.

export type DatabasePlacement = 'shared' | 'dedicated' | 'none';

function contains(ids: ReadonlySet<string> | readonly string[], id: string): boolean {
  return 'has' in ids ? ids.has(id) : ids.includes(id);
}

/**
 * Where a workspace's database lives:
 *   - `shared`: its Neon project id is one of the shards' project ids,
 *   - `dedicated`: it has a Neon project id that matches no shard,
 *   - `none`: it has no Neon project id (not provisioned, or provisioning failed).
 *
 * Decided by the project id alone. `workspaces.shared_project_id` plays no part
 * in the decision: it is only checked against it (see {@link hasShardLinkDrift}).
 */
export function classifyPlacement(
  workspace: Readonly<{ neonProjectId: string | null | undefined }>,
  shardProjectIds: ReadonlySet<string> | readonly string[],
): DatabasePlacement {
  const projectId = workspace.neonProjectId;
  if (!projectId) return 'none';
  return contains(shardProjectIds, projectId) ? 'shared' : 'dedicated';
}

/**
 * `workspaces.shared_project_id` is the shard id that provisioning stores for a
 * database inside a shared shard (null for a dedicated project, cleared on
 * teardown). It should agree with the Neon project id, so a healthy row has it
 * either empty or equal to the id of the shard its Neon project id belongs to.
 * Anything else disagrees with the placement:
 *   - set, but the project is not a shard (or there is no project at all), or
 *   - set to a different shard than the one the project belongs to.
 *
 * @param sharedProjectId the workspace's `shared_project_id` (its shard link)
 * @param matchedShardId  id of the shard whose Neon project id the workspace
 *                        has, or null when it matches none
 */
export function hasShardLinkDrift(
  sharedProjectId: string | null | undefined,
  matchedShardId: string | null | undefined,
): boolean {
  if (!sharedProjectId) return false;
  return sharedProjectId !== (matchedShardId ?? null);
}

// ---------------------------------------------------------------------------
// Shard fill
// ---------------------------------------------------------------------------

/** From this fill on a shard gets the `warning` level. */
export const FILL_WARNING_PERCENT = 70;
/** From this fill on a shard gets the `full` level. */
export const FILL_FULL_PERCENT = 90;

export type FillLevel = 'ok' | 'warning' | 'full';

export interface ShardFill {
  /** `databaseCount` as a share of `maxDatabases`, one decimal. Can exceed 100 when a shard is over capacity. */
  percent: number;
  /** `ok` below 70%, `warning` from 70% up to 90%, `full` from 90%. */
  level: FillLevel;
}

export function shardFill(databaseCount: number, maxDatabases: number): ShardFill {
  const used = Math.max(0, databaseCount);
  let percent = 0;
  if (maxDatabases > 0) percent = Math.round((used / maxDatabases) * 1000) / 10;
  else if (used > 0) percent = 100;

  let level: FillLevel = 'ok';
  if (percent >= FILL_FULL_PERCENT) level = 'full';
  else if (percent >= FILL_WARNING_PERCENT) level = 'warning';
  return { percent, level };
}

// ---------------------------------------------------------------------------
// Shard counter drift
// ---------------------------------------------------------------------------

/**
 * A reservation is made (and `updated_at` bumped) some time before the
 * workspace or pool row that uses it exists: a workspace claims capacity, then
 * creates its role and database; a warm slot claims capacity, then clones and
 * migrates before its pool row is inserted. For this long after a shard last
 * changed, a mismatch is probably a database still being provisioned.
 */
export const DRIFT_RECENT_WINDOW_MS = 15 * 60_000;

export interface ShardCountInputs {
  /** `neon_shared_projects.database_count`. */
  databaseCount: number;
  /** Workspaces on the shard that are not deleted. */
  liveWorkspaces: number;
  /**
   * Deleted workspaces whose database is not torn down yet (they still carry the
   * shard's Neon project id). They still hold a database on the shard.
   */
  pendingTeardown: number;
  /**
   * Shared pool slots on the shard that are not assigned yet (available or
   * error). Assigned slots are left out on purpose: the workspace they went to
   * is already in `liveWorkspaces` or `pendingTeardown`.
   */
  unassignedPoolSlots: number;
  /** `neon_shared_projects.updated_at`. */
  updatedAt: string | Date;
}

/**
 * `in_sync`: the counter matches what can be accounted for.
 * `recent`: it does not, but the shard changed within {@link DRIFT_RECENT_WINDOW_MS}.
 * `drift`: it does not, and nothing in flight explains it.
 */
export type ShardDriftState = 'in_sync' | 'recent' | 'drift';

export interface ShardDrift {
  /** The shard's own `database_count`. */
  actual: number;
  /** Live workspaces + workspaces awaiting teardown + unassigned pool slots. */
  expected: number;
  /** `actual - expected`: positive when the counter is higher than what is accounted for. */
  delta: number;
  state: ShardDriftState;
}

export function expectedDatabaseCount(
  inputs: Pick<ShardCountInputs, 'liveWorkspaces' | 'pendingTeardown' | 'unassignedPoolSlots'>,
): number {
  return inputs.liveWorkspaces + inputs.pendingTeardown + inputs.unassignedPoolSlots;
}

export function detectShardDrift(inputs: ShardCountInputs, now: number = Date.now()): ShardDrift {
  const expected = expectedDatabaseCount(inputs);
  const delta = inputs.databaseCount - expected;
  if (delta === 0) return { actual: inputs.databaseCount, expected, delta, state: 'in_sync' };

  const changedAt = new Date(inputs.updatedAt).getTime();
  const recent = !Number.isNaN(changedAt) && now - changedAt < DRIFT_RECENT_WINDOW_MS;
  return { actual: inputs.databaseCount, expected, delta, state: recent ? 'recent' : 'drift' };
}
