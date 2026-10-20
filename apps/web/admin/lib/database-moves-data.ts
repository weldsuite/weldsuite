import 'server-only';

import type { AdminIdentity } from './auth';
import {
  computeState,
  liveByProjectId,
  moveTargets,
  type ComputeState,
  type DatabaseMoveView,
  type LiveDatabases,
  type MoveTargets,
  type WorkerState,
} from './database-moves';
import { getShardsOverview, type WorkspaceDatabase } from './databases-data';
import { listWorkspaceDatabaseMoves, loadLiveDatabases } from './workspace-worker';

/** What a workspace's Database tab shows beyond the master DB's placement. */
export interface WorkspaceDatabaseTabData {
  moves: WorkerState<DatabaseMoveView[]>;
  /** The compute the database runs on, or null when the worker could not tell. */
  compute: ComputeState | null;
  /** Where a superadmin may move it; null for everyone else (the button is theirs only). */
  targets: MoveTargets | null;
}

/** The compute state per Neon project id from a live answer, or null when there is none (the tables then drop the column). */
export function computeMap(live: WorkerState<LiveDatabases>): ReadonlyMap<string, ComputeState> | null {
  if (live.kind !== 'ok') return null;
  const map = new Map<string, ComputeState>();
  for (const [projectId, project] of liveByProjectId(live.data)) map.set(projectId, computeState(project));
  return map;
}

/** The compute state of one Neon project from a live answer, or null when there is none. */
export function computeOf(live: WorkerState<LiveDatabases>, neonProjectId: string | null): ComputeState | null {
  if (live.kind !== 'ok' || !neonProjectId) return null;
  return computeState(liveByProjectId(live.data).get(neonProjectId));
}

export async function loadWorkspaceDatabaseTab(
  identity: AdminIdentity,
  workspaceId: string,
  database: WorkspaceDatabase,
): Promise<WorkspaceDatabaseTabData> {
  // Shards are always in the live answer; a dedicated project has to be named.
  const dedicatedIds = database.placement === 'dedicated' && database.neonProjectId ? [database.neonProjectId] : [];
  const [moves, live, shards] = await Promise.all([
    listWorkspaceDatabaseMoves(identity, workspaceId),
    database.neonProjectId ? loadLiveDatabases(identity, dedicatedIds) : null,
    identity.isSuperAdmin ? getShardsOverview() : null,
  ]);
  return {
    moves,
    compute: live ? computeOf(live, database.neonProjectId) : null,
    targets: shards
      ? moveTargets(
          {
            placement: database.placement,
            region: database.region,
            shardId: database.shard?.id ?? null,
          },
          shards,
        )
      : null,
  };
}
