import 'server-only';

import { and, asc, desc, eq, inArray, isNotNull, isNull, ne, notInArray, or, sql, type SQL } from 'drizzle-orm';
import { getMasterDb, masterSchema, type MasterDatabase } from './db';
import {
  classifyPlacement,
  detectShardDrift,
  hasShardLinkDrift,
  shardFill,
  type DatabasePlacement,
  type ShardDrift,
  type ShardFill,
} from './databases';

const { neonSharedProjects: shards, databasePool: pool, workspaces, plans } = masterSchema;

/**
 * Read side of the Databases screens (task 1150, phase 1).
 *
 * Everything here reads the MASTER database only: `neon_shared_projects`,
 * `database_pool` and `workspaces`. No tenant database is opened (ADR DATA-008:
 * looking at placement must not wake tenant computes) and the Neon API is not
 * called, so what the screens show is what the master database believes.
 *
 * Secrets stay out by construction: every query lists its columns. Never add
 * `workspaces.database_url`, `neon_shared_projects.admin_password_encrypted` or
 * `database_pool.database_url` to a selection.
 *
 * Placement rule (see ./databases.ts): a workspace is on a shard when its Neon
 * project id is a shard's project id, dedicated when it has any other project
 * id, and has no database without one. Deleted workspaces are left out of every
 * count, except that one still holding its shard's project id (teardown not
 * finished) is counted as `pendingTeardown`, since it still occupies a database.
 */

const iso = (value: Date | null | undefined): string | null => (value ? value.toISOString() : null);

/** Rows listed per table. The counts next to each table always cover everything. */
const DEDICATED_LIST_LIMIT = 200;
const POOL_LIST_LIMIT = 200;
const SHARD_WORKSPACE_LIMIT = 1000;
const SHARD_POOL_LIMIT = 500;

/** The Neon project ids of every shard, as a subquery for `in (...)` filters. */
function shardProjectIdsQuery(db: MasterDatabase) {
  return db.select({ id: shards.neonProjectId }).from(shards);
}

// ---------------------------------------------------------------------------
// Shards
// ---------------------------------------------------------------------------

export type ShardStatus = 'active' | 'full' | 'disabled';

export interface ShardSummary {
  id: string;
  neonProjectId: string;
  neonProjectName: string;
  region: string;
  mainBranchId: string | null;
  connectionHost: string | null;
  connectionPort: number | null;
  adminRole: string | null;
  status: ShardStatus;
  databaseCount: number;
  maxDatabases: number;
  fill: ShardFill;
  /** Workspaces on the shard that are not deleted. */
  liveWorkspaces: number;
  /** Deleted workspaces whose database is not torn down yet. */
  pendingTeardown: number;
  /** Shared pool slots on the shard that are not assigned yet (available or error). */
  warmSlots: number;
  drift: ShardDrift;
  createdAt: string;
  updatedAt: string;
}

const shardColumns = {
  id: shards.id,
  neonProjectId: shards.neonProjectId,
  neonProjectName: shards.neonProjectName,
  region: shards.region,
  mainBranchId: shards.mainBranchId,
  connectionHost: shards.connectionHost,
  connectionPort: shards.connectionPort,
  adminRole: shards.adminRole,
  databaseCount: shards.databaseCount,
  maxDatabases: shards.maxDatabases,
  status: shards.status,
  createdAt: shards.createdAt,
  updatedAt: shards.updatedAt,
};

function selectShardRows(db: MasterDatabase, where?: SQL) {
  return db.select(shardColumns).from(shards).where(where).orderBy(asc(shards.createdAt), asc(shards.id));
}

type ShardRow = Awaited<ReturnType<typeof selectShardRows>>[number];

interface ShardCounts {
  live: number;
  pending: number;
  warm: number;
}

function toShardSummary(row: ShardRow, counts: ShardCounts): ShardSummary {
  return {
    id: row.id,
    neonProjectId: row.neonProjectId,
    neonProjectName: row.neonProjectName,
    region: row.region,
    mainBranchId: row.mainBranchId,
    connectionHost: row.connectionHost,
    connectionPort: row.connectionPort,
    adminRole: row.adminRole,
    status: row.status,
    databaseCount: row.databaseCount,
    maxDatabases: row.maxDatabases,
    fill: shardFill(row.databaseCount, row.maxDatabases),
    liveWorkspaces: counts.live,
    pendingTeardown: counts.pending,
    warmSlots: counts.warm,
    drift: detectShardDrift({
      databaseCount: row.databaseCount,
      liveWorkspaces: counts.live,
      pendingTeardown: counts.pending,
      unassignedPoolSlots: counts.warm,
      updatedAt: row.updatedAt,
    }),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Every shard, oldest first, with how full it is and what is on it. Three small
 * queries (the shards, workspaces per shard project, unassigned pool slots per
 * shard), run together and merged here.
 */
export async function getShardsOverview(): Promise<ShardSummary[]> {
  const db = getMasterDb();

  const [shardRows, workspaceCounts, slotCounts] = await Promise.all([
    selectShardRows(db),
    db
      .select({
        neonProjectId: workspaces.neonProjectId,
        live: sql<number>`count(*) filter (where ${workspaces.deletedAt} is null)::int`,
        pending: sql<number>`count(*) filter (where ${workspaces.deletedAt} is not null)::int`,
      })
      .from(workspaces)
      .where(inArray(workspaces.neonProjectId, shardProjectIdsQuery(db)))
      .groupBy(workspaces.neonProjectId),
    db
      .select({
        sharedProjectId: pool.sharedProjectId,
        neonProjectId: pool.neonProjectId,
        n: sql<number>`count(*)::int`,
      })
      .from(pool)
      .where(and(eq(pool.kind, 'shared'), ne(pool.status, 'assigned')))
      .groupBy(pool.sharedProjectId, pool.neonProjectId),
  ]);

  const byProject = new Map<string, { live: number; pending: number }>();
  for (const row of workspaceCounts) {
    if (row.neonProjectId) byProject.set(row.neonProjectId, { live: Number(row.live), pending: Number(row.pending) });
  }

  // A pool slot belongs to the shard named by `shared_project_id`, or, when that
  // is empty, to the shard with the slot's Neon project id.
  const shardIdByProject = new Map(shardRows.map((row) => [row.neonProjectId, row.id] as const));
  const warmByShard = new Map<string, number>();
  for (const row of slotCounts) {
    const shardId = row.sharedProjectId ?? shardIdByProject.get(row.neonProjectId);
    if (shardId) warmByShard.set(shardId, (warmByShard.get(shardId) ?? 0) + Number(row.n));
  }

  return shardRows.map((row) =>
    toShardSummary(row, {
      live: byProject.get(row.neonProjectId)?.live ?? 0,
      pending: byProject.get(row.neonProjectId)?.pending ?? 0,
      warm: warmByShard.get(row.id) ?? 0,
    }),
  );
}

// ---------------------------------------------------------------------------
// Pool slots
// ---------------------------------------------------------------------------

export type PoolStatus = 'available' | 'assigned' | 'error';

/**
 * One `database_pool` row without its connection string. `kind` is `shared` (a
 * database inside a shard) or `dedicated` (a whole Neon project).
 */
export interface PoolSlotRow {
  id: string;
  kind: string;
  status: PoolStatus;
  /** For a shared slot the shard's project id, for a dedicated one the slot's own project. */
  neonProjectId: string;
  /** The shard a shared slot belongs to. */
  shardId: string | null;
  shardName: string | null;
  region: string;
  schemaVersion: string | null;
  assignedWorkspaceId: string | null;
  assignedWorkspaceName: string | null;
  assignedAt: string | null;
  createdAt: string;
}

function selectPoolSlots(db: MasterDatabase, where: SQL | undefined, limit: number) {
  return db
    .select({
      id: pool.id,
      kind: pool.kind,
      status: pool.status,
      neonProjectId: pool.neonProjectId,
      shardId: pool.sharedProjectId,
      shardName: shards.neonProjectName,
      region: pool.region,
      schemaVersion: pool.schemaVersion,
      assignedWorkspaceId: pool.assignedWorkspaceId,
      assignedWorkspaceName: workspaces.name,
      assignedAt: pool.assignedAt,
      createdAt: pool.createdAt,
    })
    .from(pool)
    .leftJoin(shards, eq(pool.sharedProjectId, shards.id))
    .leftJoin(workspaces, eq(pool.assignedWorkspaceId, workspaces.id))
    .where(where)
    .orderBy(desc(pool.createdAt), asc(pool.id))
    .limit(limit);
}

type PoolSlotQueryRow = Awaited<ReturnType<typeof selectPoolSlots>>[number];

function toPoolSlot(row: PoolSlotQueryRow): PoolSlotRow {
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    neonProjectId: row.neonProjectId,
    shardId: row.shardId,
    shardName: row.shardName,
    region: row.region,
    schemaVersion: row.schemaVersion,
    assignedWorkspaceId: row.assignedWorkspaceId,
    assignedWorkspaceName: row.assignedWorkspaceName,
    assignedAt: iso(row.assignedAt),
    createdAt: row.createdAt.toISOString(),
  };
}

export interface PoolGroup {
  kind: string;
  status: PoolStatus;
  count: number;
  /** How many of the slots are at each schema version, most first. */
  schemaVersions: { version: string | null; count: number }[];
}

export interface PoolOverview {
  /** Slots grouped by kind and status. */
  groups: PoolGroup[];
  /** The slots that are not assigned yet (available or error), newest first. */
  slots: PoolSlotRow[];
  /** All slots that are not assigned, which can be more than `slots` lists. */
  unassignedTotal: number;
  /** Slots that went to a workspace. Each stays as a row until the workspace's database is torn down. */
  assignedTotal: number;
}

const KIND_RANK: Record<string, number> = { shared: 0, dedicated: 1 };
const STATUS_RANK: Record<PoolStatus, number> = { available: 0, assigned: 1, error: 2 };

/**
 * The warm pool: counts by kind and status (with schema versions), plus the
 * slots that are still unassigned. Assigned slots are one row per workspace
 * that was ever started from the pool, so they are counted, not listed.
 */
export async function getPoolOverview(): Promise<PoolOverview> {
  const db = getMasterDb();

  const [groupRows, slotRows] = await Promise.all([
    db
      .select({
        kind: pool.kind,
        status: pool.status,
        schemaVersion: pool.schemaVersion,
        n: sql<number>`count(*)::int`,
      })
      .from(pool)
      .groupBy(pool.kind, pool.status, pool.schemaVersion),
    selectPoolSlots(db, ne(pool.status, 'assigned'), POOL_LIST_LIMIT),
  ]);

  const grouped = new Map<string, PoolGroup>();
  for (const row of groupRows) {
    const key = `${row.kind}:${row.status}`;
    const group = grouped.get(key) ?? { kind: row.kind, status: row.status, count: 0, schemaVersions: [] };
    group.count += Number(row.n);
    group.schemaVersions.push({ version: row.schemaVersion, count: Number(row.n) });
    grouped.set(key, group);
  }

  const groups = [...grouped.values()].sort(
    (a, b) =>
      (KIND_RANK[a.kind] ?? 99) - (KIND_RANK[b.kind] ?? 99) ||
      a.kind.localeCompare(b.kind) ||
      STATUS_RANK[a.status] - STATUS_RANK[b.status],
  );
  for (const group of groups) group.schemaVersions.sort((a, b) => b.count - a.count);

  const total = (match: (status: PoolStatus) => boolean) =>
    groups.filter((g) => match(g.status)).reduce((sum, g) => sum + g.count, 0);

  return {
    groups,
    slots: slotRows.map(toPoolSlot),
    unassignedTotal: total((status) => status !== 'assigned'),
    assignedTotal: total((status) => status === 'assigned'),
  };
}

// ---------------------------------------------------------------------------
// One shard
// ---------------------------------------------------------------------------

export interface ShardWorkspaceRow {
  id: string;
  name: string;
  clerkOrgId: string | null;
  planName: string | null;
  /** The Postgres database inside the shard. */
  databaseName: string | null;
  provisioningStatus: string;
  provisionedAt: string | null;
  isActive: boolean;
  scheduledDeletionAt: string | null;
  /** The workspace's `shared_project_id` (shard link) is set and names another shard. */
  shardLinkDrift: boolean;
}

export interface ShardDetail extends ShardSummary {
  /** Live workspaces on the shard, most recently provisioned first. */
  workspaces: ShardWorkspaceRow[];
  /** Every shared pool row of the shard, assigned ones included, newest first. */
  slots: PoolSlotRow[];
  assignedSlots: number;
}

/** One shard with the workspaces and pool slots on it, or null for an unknown id. */
export async function getShard(id: string): Promise<ShardDetail | null> {
  const db = getMasterDb();

  const [row] = await selectShardRows(db, eq(shards.id, id)).limit(1);
  if (!row) return null;

  const [workspaceRows, slotRows] = await Promise.all([
    db
      .select({
        id: workspaces.id,
        name: workspaces.name,
        clerkOrgId: workspaces.clerkOrgId,
        planName: plans.name,
        databaseName: workspaces.neonDatabaseName,
        provisioningStatus: workspaces.provisioningStatus,
        provisionedAt: workspaces.databaseProvisionedAt,
        isActive: workspaces.isActive,
        scheduledDeletionAt: workspaces.scheduledDeletionAt,
        deletedAt: workspaces.deletedAt,
        sharedProjectId: workspaces.sharedProjectId,
      })
      .from(workspaces)
      .leftJoin(plans, eq(workspaces.planId, plans.id))
      .where(eq(workspaces.neonProjectId, row.neonProjectId))
      .orderBy(sql`${workspaces.databaseProvisionedAt} desc nulls last`, desc(workspaces.createdAt))
      .limit(SHARD_WORKSPACE_LIMIT),
    selectPoolSlots(
      db,
      and(eq(pool.kind, 'shared'), or(eq(pool.sharedProjectId, row.id), eq(pool.neonProjectId, row.neonProjectId))),
      SHARD_POOL_LIMIT,
    ),
  ]);

  const live = workspaceRows.filter((w) => !w.deletedAt);
  const slots = slotRows.map(toPoolSlot);

  const summary = toShardSummary(row, {
    live: live.length,
    pending: workspaceRows.length - live.length,
    warm: slots.filter((slot) => slot.status !== 'assigned').length,
  });

  return {
    ...summary,
    workspaces: live.map((w) => ({
      id: w.id,
      name: w.name,
      clerkOrgId: w.clerkOrgId,
      planName: w.planName,
      databaseName: w.databaseName,
      provisioningStatus: w.provisioningStatus,
      provisionedAt: iso(w.provisionedAt),
      isActive: w.isActive,
      scheduledDeletionAt: iso(w.scheduledDeletionAt),
      shardLinkDrift: hasShardLinkDrift(w.sharedProjectId, row.id),
    })),
    slots,
    assignedSlots: slots.filter((slot) => slot.status === 'assigned').length,
  };
}

// ---------------------------------------------------------------------------
// Dedicated projects
// ---------------------------------------------------------------------------

export interface DedicatedProjectRow {
  workspaceId: string;
  name: string;
  slug: string;
  planName: string | null;
  neonProjectId: string;
  region: string | null;
  provisionedAt: string | null;
  provisioningStatus: string;
  /** The workspace's `shared_project_id` (shard link) is set although the project is no shard. */
  shardLinkDrift: boolean;
}

export interface DedicatedProjects {
  rows: DedicatedProjectRow[];
  /** Every workspace on a dedicated project, which can be more than `rows` lists. */
  total: number;
}

/** Workspaces whose Neon project is not a shard: one project per workspace. */
export async function getDedicatedProjects(): Promise<DedicatedProjects> {
  const db = getMasterDb();

  const rows = await db
    .select({
      workspaceId: workspaces.id,
      name: workspaces.name,
      slug: workspaces.slug,
      planName: plans.name,
      neonProjectId: workspaces.neonProjectId,
      region: workspaces.neonRegion,
      provisionedAt: workspaces.databaseProvisionedAt,
      provisioningStatus: workspaces.provisioningStatus,
      sharedProjectId: workspaces.sharedProjectId,
      total: sql<number>`(count(*) over ())::int`,
    })
    .from(workspaces)
    .leftJoin(plans, eq(workspaces.planId, plans.id))
    .where(
      and(
        isNull(workspaces.deletedAt),
        isNotNull(workspaces.neonProjectId),
        notInArray(workspaces.neonProjectId, shardProjectIdsQuery(db)),
      ),
    )
    .orderBy(sql`${workspaces.databaseProvisionedAt} desc nulls last`, desc(workspaces.createdAt))
    .limit(DEDICATED_LIST_LIMIT);

  return {
    rows: rows.flatMap((row) =>
      row.neonProjectId
        ? [
            {
              workspaceId: row.workspaceId,
              name: row.name,
              slug: row.slug,
              planName: row.planName,
              neonProjectId: row.neonProjectId,
              region: row.region,
              provisionedAt: iso(row.provisionedAt),
              provisioningStatus: row.provisioningStatus,
              shardLinkDrift: hasShardLinkDrift(row.sharedProjectId, null),
            },
          ]
        : [],
    ),
    total: Number(rows[0]?.total ?? 0),
  };
}

// ---------------------------------------------------------------------------
// Workspaces without a database
// ---------------------------------------------------------------------------

export interface WorkspacesWithoutDatabase {
  /** Live workspaces with no Neon project: still provisioning, or provisioning failed. */
  total: number;
  failed: number;
}

export async function getWorkspacesWithoutDatabase(): Promise<WorkspacesWithoutDatabase> {
  const db = getMasterDb();
  const [row] = await db
    .select({
      total: sql<number>`count(*)::int`,
      failed: sql<number>`count(*) filter (where ${workspaces.provisioningStatus} = 'failed')::int`,
    })
    .from(workspaces)
    .where(and(isNull(workspaces.deletedAt), isNull(workspaces.neonProjectId)));
  return { total: Number(row?.total ?? 0), failed: Number(row?.failed ?? 0) };
}

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

export interface DatabasesSummary {
  shardCount: number;
  /** Sum of `max_databases` over all shards. */
  capacity: number;
  /** Sum of `database_count` over all shards. */
  used: number;
  dedicatedProjects: number;
  /** Available warm shared slots. */
  warmShared: number;
  /** Available warm dedicated projects. */
  warmDedicated: number;
  withoutDatabase: number;
  withoutDatabaseFailed: number;
}

export function buildDatabasesSummary(parts: {
  shards: ShardSummary[];
  dedicated: DedicatedProjects;
  pool: PoolOverview;
  withoutDatabase: WorkspacesWithoutDatabase;
}): DatabasesSummary {
  const available = (kind: string) =>
    parts.pool.groups.find((g) => g.kind === kind && g.status === 'available')?.count ?? 0;
  return {
    shardCount: parts.shards.length,
    capacity: parts.shards.reduce((sum, s) => sum + s.maxDatabases, 0),
    used: parts.shards.reduce((sum, s) => sum + s.databaseCount, 0),
    dedicatedProjects: parts.dedicated.total,
    warmShared: available('shared'),
    warmDedicated: available('dedicated'),
    withoutDatabase: parts.withoutDatabase.total,
    withoutDatabaseFailed: parts.withoutDatabase.failed,
  };
}

export interface DatabasesOverview {
  summary: DatabasesSummary;
  shards: ShardSummary[];
  dedicated: DedicatedProjects;
  pool: PoolOverview;
}

/** Everything the Databases overview shows, loaded together. */
export async function getDatabasesOverview(): Promise<DatabasesOverview> {
  const [shardList, dedicated, poolOverview, withoutDatabase] = await Promise.all([
    getShardsOverview(),
    getDedicatedProjects(),
    getPoolOverview(),
    getWorkspacesWithoutDatabase(),
  ]);
  return {
    summary: buildDatabasesSummary({ shards: shardList, dedicated, pool: poolOverview, withoutDatabase }),
    shards: shardList,
    dedicated,
    pool: poolOverview,
  };
}

// ---------------------------------------------------------------------------
// One workspace
// ---------------------------------------------------------------------------

export interface WorkspaceDatabase {
  placement: DatabasePlacement;
  neonProjectId: string | null;
  databaseName: string | null;
  roleName: string | null;
  branchId: string | null;
  region: string | null;
  provisioningStatus: string;
  provisionedAt: string | null;
  /** The shard the database is on, for a shared placement. */
  shard: {
    id: string;
    name: string;
    region: string;
    status: ShardStatus;
    databaseCount: number;
    maxDatabases: number;
    fill: ShardFill;
  } | null;
  /**
   * `workspaces.shared_project_id`, whatever it says: the shard id provisioning
   * stores for a shared database (null for dedicated), which should agree with
   * the Neon project id.
   */
  sharedProjectId: string | null;
  /** The shard link is set and does not agree with where the Neon project id says the database is. */
  shardLinkDrift: boolean;
}

/** Where one workspace's database lives, or null when the workspace does not exist. One query. */
export async function getWorkspaceDatabase(workspaceId: string): Promise<WorkspaceDatabase | null> {
  const db = getMasterDb();

  const [row] = await db
    .select({
      neonProjectId: workspaces.neonProjectId,
      databaseName: workspaces.neonDatabaseName,
      roleName: workspaces.neonRoleName,
      branchId: workspaces.neonBranchId,
      region: workspaces.neonRegion,
      provisioningStatus: workspaces.provisioningStatus,
      provisionedAt: workspaces.databaseProvisionedAt,
      sharedProjectId: workspaces.sharedProjectId,
      shardId: shards.id,
      shardName: shards.neonProjectName,
      shardRegion: shards.region,
      shardStatus: shards.status,
      shardDatabaseCount: shards.databaseCount,
      shardMaxDatabases: shards.maxDatabases,
    })
    .from(workspaces)
    .leftJoin(shards, eq(workspaces.neonProjectId, shards.neonProjectId))
    .where(eq(workspaces.id, workspaceId))
    .limit(1);

  if (!row) return null;

  // The join only matches when the workspace's project is a shard's.
  const shardProjectIds = new Set(row.shardId && row.neonProjectId ? [row.neonProjectId] : []);
  const placement = classifyPlacement({ neonProjectId: row.neonProjectId }, shardProjectIds);

  return {
    placement,
    neonProjectId: row.neonProjectId,
    databaseName: row.databaseName,
    roleName: row.roleName,
    branchId: row.branchId,
    region: row.region ?? row.shardRegion,
    provisioningStatus: row.provisioningStatus,
    provisionedAt: iso(row.provisionedAt),
    shard:
      placement === 'shared' && row.shardId
        ? {
            id: row.shardId,
            name: row.shardName ?? row.shardId,
            region: row.shardRegion ?? '',
            status: row.shardStatus ?? 'active',
            databaseCount: row.shardDatabaseCount ?? 0,
            maxDatabases: row.shardMaxDatabases ?? 0,
            fill: shardFill(row.shardDatabaseCount ?? 0, row.shardMaxDatabases ?? 0),
          }
        : null,
    sharedProjectId: row.sharedProjectId,
    shardLinkDrift: hasShardLinkDrift(row.sharedProjectId, row.shardId),
  };
}
