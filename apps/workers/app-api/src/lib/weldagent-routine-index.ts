/**
 * D1 index of WeldAgent cron routines (`weldagent_routine_index`).
 *
 * The hourly routine sweep used to open every tenant Neon DB just to find the
 * few routines that were due, waking every idle workspace once an hour. The
 * index keeps `next_run_at` per live routine in the always-on schedule-index D1
 * database (SCHEDULE_INDEX), so the sweep opens only tenants with work due.
 *
 * The tenant DB stays the source of truth. Writes here re-derive an agent's (or
 * a workspace's) rows from the tenant tables, so a missed or failed write is
 * repaired by the next mutation — and the sweep re-indexes every workspace it
 * opens. All writes are best-effort: a D1 hiccup logs and never fails the
 * user's save. Table DDL: workflow-worker/migrations/d1/0002_weldagent_routine_index.sql.
 */

import { and, eq, isNull } from 'drizzle-orm';
import { schema } from '../db';
import type { Env, Variables } from '../types';

type TenantDb = Variables['tenantDb'];

export interface RoutineIndexSync {
  d1?: D1Database;
  workspaceId?: string;
}

export function routineIndexSync(env: Pick<Env, 'SCHEDULE_INDEX'> | undefined, workspaceId: string | undefined): RoutineIndexSync {
  return { d1: env?.SCHEDULE_INDEX, workspaceId };
}

interface LiveRoutineRow {
  id: string;
  agentId: string;
  nextRunAt: Date | null;
}

/** Enabled, undeleted cron routines of active agents (optionally one agent). */
async function loadLiveRoutines(db: TenantDb, agentId?: string): Promise<LiveRoutineRow[]> {
  const { weldagentRoutines: r, weldagentAgents: a } = schema;
  const conditions = [
    eq(r.enabled, true),
    eq(r.scheduleKind, 'cron'),
    isNull(r.deletedAt),
    eq(a.status, 'active'),
    isNull(a.deletedAt),
  ];
  if (agentId) conditions.push(eq(r.agentId, agentId));
  return db
    .select({ id: r.id, agentId: r.agentId, nextRunAt: r.nextRunAt })
    .from(r)
    .innerJoin(a, eq(a.id, r.agentId))
    .where(and(...conditions));
}

function upsertStatement(d1: D1Database, workspaceId: string, row: LiveRoutineRow, now: number) {
  // A live routine with no next_run_at (legacy row) is due now; the sweep
  // will run it and store a proper next time.
  const nextRunAt = row.nextRunAt?.getTime() ?? now;
  return d1
    .prepare(
      `INSERT INTO weldagent_routine_index (routine_id, workspace_id, agent_id, next_run_at, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(routine_id) DO UPDATE SET
         workspace_id = excluded.workspace_id,
         agent_id     = excluded.agent_id,
         next_run_at  = excluded.next_run_at,
         updated_at   = excluded.updated_at`,
    )
    .bind(row.id, workspaceId, row.agentId, nextRunAt, now);
}

/** Re-derive one agent's index rows from the tenant DB. */
export async function reindexAgentRoutines(
  sync: RoutineIndexSync | undefined,
  db: TenantDb,
  agentId: string,
): Promise<void> {
  if (!sync?.d1 || !sync.workspaceId) return;
  try {
    const rows = await loadLiveRoutines(db, agentId);
    const now = Date.now();
    await sync.d1.batch([
      sync.d1
        .prepare('DELETE FROM weldagent_routine_index WHERE workspace_id = ? AND agent_id = ?')
        .bind(sync.workspaceId, agentId),
      ...rows.map((row) => upsertStatement(sync.d1!, sync.workspaceId!, row, now)),
    ]);
  } catch (err) {
    console.warn(`[weldagent/routine-index] reindex agent ${agentId} failed:`, err);
  }
}

/** Re-derive every index row of a workspace from the tenant DB. */
export async function reindexWorkspaceRoutines(
  sync: RoutineIndexSync | undefined,
  db: TenantDb,
): Promise<void> {
  if (!sync?.d1 || !sync.workspaceId) return;
  try {
    const rows = await loadLiveRoutines(db);
    const now = Date.now();
    await sync.d1.batch([
      sync.d1.prepare('DELETE FROM weldagent_routine_index WHERE workspace_id = ?').bind(sync.workspaceId),
      ...rows.map((row) => upsertStatement(sync.d1!, sync.workspaceId!, row, now)),
    ]);
  } catch (err) {
    console.warn(`[weldagent/routine-index] reindex workspace ${sync.workspaceId} failed:`, err);
  }
}

/** Drop every index row of a workspace (e.g. its tenant DB is gone). */
export async function clearWorkspaceRoutineIndex(d1: D1Database, workspaceId: string): Promise<void> {
  try {
    await d1.prepare('DELETE FROM weldagent_routine_index WHERE workspace_id = ?').bind(workspaceId).run();
  } catch (err) {
    console.warn(`[weldagent/routine-index] clear workspace ${workspaceId} failed:`, err);
  }
}

/**
 * Workspaces with at least one routine due at `asOf`. Throws when D1 is
 * unreachable or the table is missing, so the caller can fall back.
 */
export async function listWorkspacesWithDueRoutines(
  d1: D1Database,
  asOf: number,
  limit = 500,
): Promise<string[]> {
  const result = await d1
    .prepare(
      'SELECT DISTINCT workspace_id FROM weldagent_routine_index WHERE next_run_at <= ? LIMIT ?',
    )
    .bind(asOf, limit)
    .all<{ workspace_id: string }>();
  return (result.results ?? []).map((r) => r.workspace_id);
}
