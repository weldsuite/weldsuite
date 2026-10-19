/**
 * Live Neon state of the tenant databases' homes, for the admin console: the
 * compute endpoint of every shard (and of the dedicated projects an admin
 * asks about) with its autoscaling and suspend settings and whether it is
 * running, plus the on-disk size of every database in a shard.
 *
 * Read-only. The endpoint listing is one Neon API call per project and never
 * touches a database. The size listing runs a query on the shard, which WAKES
 * its compute if it is suspended, so it is its own explicit call and is never
 * folded into the endpoint listing.
 *
 * Nothing here returns a connection string, a role password or an admin
 * credential: shard rows are read column by column (never
 * `admin_password_encrypted`), and a Neon error is reduced to its HTTP status.
 */

import { and, eq, inArray, isNull } from 'drizzle-orm';
import { neonSharedProjects, workspaces, type NeonSharedProject } from '@weldsuite/db/schema/master';
import type { NeonClient, NeonEndpoint, ShardDatabaseSize } from '@weldsuite/neon-provisioning';
import type { MasterDatabase } from '../db';
import { mapWithConcurrency } from '../lib/concurrency';
import { describeFailure } from './database-move/failure';

/** Neon lookups in flight at once. */
export const LIVE_LOOKUP_CONCURRENCY = 5;
/** Dedicated projects one request may ask about. */
export const MAX_LIVE_PROJECT_IDS = 50;

const PROJECT_ID_PATTERN = /^[A-Za-z0-9_-]{1,100}$/;

export type EndpointLister = Pick<NeonClient, 'listEndpoints'>;

export interface EndpointView {
  id: string;
  type: NeonEndpoint['type'];
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
  /** Safe text when the lookup failed; the other projects still carry their state. */
  error: string | null;
}

export interface ShardLiveState extends ProjectLiveState {
  shardId: string;
  name: string;
  region: string;
  status: NeonSharedProject['status'];
  databaseCount: number;
  maxDatabases: number;
}

export interface LiveDatabases {
  shards: ShardLiveState[];
  /** The dedicated projects named in `projectIds`, in that order. */
  dedicated: ProjectLiveState[];
  fetchedAt: string;
}

function endpointView(endpoint: NeonEndpoint): EndpointView {
  return {
    id: endpoint.id,
    type: endpoint.type,
    currentState: endpoint.current_state,
    minCu: endpoint.autoscaling_limit_min_cu ?? null,
    maxCu: endpoint.autoscaling_limit_max_cu ?? null,
    suspendTimeoutSeconds: endpoint.suspend_timeout_seconds ?? null,
    lastActive: endpoint.last_active ?? null,
  };
}

async function lookupProject(neon: EndpointLister, neonProjectId: string): Promise<ProjectLiveState> {
  try {
    const { endpoints } = await neon.listEndpoints(neonProjectId);
    return { neonProjectId, endpoints: endpoints.map(endpointView), error: null };
  } catch (err) {
    // describeFailure reduces a Neon error to its status and strips URLs from anything else.
    return { neonProjectId, endpoints: [], error: describeFailure(err) };
  }
}

/** `?projectIds=a,b` → distinct, well-formed ids; null when one is malformed or there are too many. */
export function parseProjectIds(raw: string | undefined): string[] | null {
  if (!raw) return [];
  const ids = [...new Set(raw.split(',').map((id) => id.trim()).filter(Boolean))];
  if (ids.length > MAX_LIVE_PROJECT_IDS) return null;
  return ids.every((id) => PROJECT_ID_PATTERN.test(id)) ? ids : null;
}

/**
 * The compute of every shard, and of the given dedicated projects. A project
 * id that is not a workspace's dedicated project is reported as unknown
 * instead of being looked up, so this stays a view of OUR databases and not a
 * window onto the whole Neon organisation.
 */
export async function fetchLiveDatabases(
  masterDb: MasterDatabase,
  neon: EndpointLister,
  projectIds: readonly string[],
  now: () => Date = () => new Date(),
): Promise<LiveDatabases> {
  const shardRows = await masterDb
    .select({
      id: neonSharedProjects.id,
      neonProjectId: neonSharedProjects.neonProjectId,
      name: neonSharedProjects.neonProjectName,
      region: neonSharedProjects.region,
      status: neonSharedProjects.status,
      databaseCount: neonSharedProjects.databaseCount,
      maxDatabases: neonSharedProjects.maxDatabases,
    })
    .from(neonSharedProjects)
    .orderBy(neonSharedProjects.createdAt);

  const knownDedicated =
    projectIds.length === 0
      ? new Set<string>()
      : new Set(
          (
            await masterDb
              .select({ neonProjectId: workspaces.neonProjectId })
              .from(workspaces)
              .where(and(inArray(workspaces.neonProjectId, [...projectIds]), isNull(workspaces.sharedProjectId)))
          ).map((row) => row.neonProjectId),
        );

  const [shards, dedicated] = await Promise.all([
    mapWithConcurrency(shardRows, LIVE_LOOKUP_CONCURRENCY, async (shard): Promise<ShardLiveState> => ({
      ...(await lookupProject(neon, shard.neonProjectId)),
      shardId: shard.id,
      name: shard.name,
      region: shard.region,
      status: shard.status,
      databaseCount: shard.databaseCount,
      maxDatabases: shard.maxDatabases,
    })),
    mapWithConcurrency(projectIds, LIVE_LOOKUP_CONCURRENCY, async (neonProjectId): Promise<ProjectLiveState> =>
      knownDedicated.has(neonProjectId)
        ? lookupProject(neon, neonProjectId)
        : { neonProjectId, endpoints: [], error: 'Not a dedicated project of any workspace' },
    ),
  ]);

  return { shards, dedicated, fetchedAt: now().toISOString() };
}

export interface ShardSizeView {
  databaseName: string;
  sizeBytes: number;
  /** The workspace whose database this is, null for a pool slot, the golden template or an orphan. */
  workspaceId: string | null;
}

export interface ShardSizes {
  shardId: string;
  neonProjectId: string;
  databases: ShardSizeView[];
  totalBytes: number;
}

export type ShardSizeReader = (shard: NeonSharedProject) => Promise<ShardDatabaseSize[] | null>;

export type ShardSizesOutcome =
  | { kind: 'ok'; sizes: ShardSizes }
  | { kind: 'shard_not_found' }
  | { kind: 'no_admin_access' };

/**
 * The size of every database in one shard, tagged with the workspace each
 * belongs to. WAKES the shard's compute (one catalog query as its admin role).
 */
export async function fetchShardSizes(
  masterDb: MasterDatabase,
  readSizes: ShardSizeReader,
  shardId: string,
): Promise<ShardSizesOutcome> {
  const [shard] = await masterDb.select().from(neonSharedProjects).where(eq(neonSharedProjects.id, shardId)).limit(1);
  if (!shard) return { kind: 'shard_not_found' };

  const sizes = await readSizes(shard);
  if (!sizes) return { kind: 'no_admin_access' };

  const owners = sizes.length
    ? await masterDb
        .select({ id: workspaces.id, databaseName: workspaces.neonDatabaseName })
        .from(workspaces)
        .where(
          and(
            inArray(workspaces.neonDatabaseName, sizes.map((s) => s.databaseName)),
            eq(workspaces.sharedProjectId, shard.id),
          ),
        )
    : [];
  const workspaceByDatabase = new Map(owners.map((owner) => [owner.databaseName, owner.id]));

  return {
    kind: 'ok',
    sizes: {
      shardId: shard.id,
      neonProjectId: shard.neonProjectId,
      databases: sizes.map((size) => ({
        databaseName: size.databaseName,
        sizeBytes: size.sizeBytes,
        workspaceId: workspaceByDatabase.get(size.databaseName) ?? null,
      })),
      totalBytes: sizes.reduce((sum, size) => sum + size.sizeBytes, 0),
    },
  };
}
