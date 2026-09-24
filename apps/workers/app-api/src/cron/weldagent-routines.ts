/**
 * Hourly sweep for due WeldAgent cron routines. Due workspaces come from the
 * D1 routine index (lib/weldagent-routine-index.ts), not a tenant fan-out.
 */

import { isNull } from 'drizzle-orm';
import type { Env } from '../types';
import { getMasterDb, getTenantDbForWorkspace, masterSchema } from '../db';
import {
  listWorkspacesWithDueRoutines,
  reindexWorkspaceRoutines,
  routineIndexSync,
} from '../lib/weldagent-routine-index';
import {
  listDueCronRoutines,
  createRoutineRun,
  completeRoutineRun,
  markRoutineScheduled,
} from '../services/weldagent/parity';
import { enqueueWeldAgentJob, type WeldAgentJob } from '../services/weldagent/jobs';
import type { AgentDb } from '../services/weldagent/agents';

/**
 * Start due cron routines for one tenant. Each run goes to the durable
 * WeldAgent job workflow, so one slow agent can't hold up the sweep.
 */
export async function runWeldAgentRoutineSweepForTenant(params: {
  env: Env;
  workspaceId: string;
  db: AgentDb;
  actorUserId?: string;
  schedule?: (job: WeldAgentJob) => Promise<void>;
}): Promise<{ started: number }> {
  const schedule =
    params.schedule ?? ((job: WeldAgentJob) => enqueueWeldAgentJob(params.env, undefined, job, params.db));
  const due = await listDueCronRoutines(params.db);
  let started = 0;
  for (const routine of due) {
    const runId = await createRoutineRun(params.db, {
      routineId: routine.id,
      agentId: routine.agentId,
      trigger: 'schedule',
    });
    await markRoutineScheduled(params.db, routine);
    started += 1;
    try {
      await schedule({
        kind: 'agent-run',
        workspaceId: params.workspaceId,
        actorUserId: params.actorUserId || routine.createdBy || 'system',
        agentId: routine.agentId,
        triggerType: 'event',
        triggerData: { routineId: routine.id, schedule: true },
        userMessage: `Scheduled routine "${routine.name}" is due.\n\n${routine.instructions}`,
        extraSystem: routine.requireApproval
          ? 'Require approval before consequential outbound actions.'
          : undefined,
        routineRunId: runId,
      });
    } catch (err) {
      await completeRoutineRun(params.db, runId, {
        status: 'failed',
        error: err instanceof Error ? err.message : 'Routine sweep failed',
      });
    }
  }
  return { started };
}

/** KV flag: the one-time D1 index backfill has run. Bump the version to rebuild. */
export const ROUTINE_INDEX_BACKFILL_KEY = 'weldagent:routine-index:backfill:v1';

async function sweepWorkspace(env: Env, workspaceId: string): Promise<number> {
  const db = await getTenantDbForWorkspace(env, workspaceId);
  const result = await runWeldAgentRoutineSweepForTenant({ env, workspaceId, db });
  // The tenant is awake anyway: refresh its index rows (new next_run_at,
  // plus self-healing for any write that was missed).
  await reindexWorkspaceRoutines(routineIndexSync(env, workspaceId), db);
  return result.started;
}

/**
 * One-time backfill: the only pass that opens every tenant DB. Indexes the
 * routines that existed before the D1 index, then never runs again.
 */
async function backfillRoutineIndex(env: Env): Promise<number> {
  console.log('[WeldAgentRoutineSweep] Backfilling D1 routine index (one-time)');
  const masterDb = getMasterDb(env);
  const workspaces = await masterDb
    .select({
      id: masterSchema.workspaces.id,
      clerkOrgId: masterSchema.workspaces.clerkOrgId,
    })
    .from(masterSchema.workspaces)
    .where(isNull(masterSchema.workspaces.scheduledDeletionAt));

  let started = 0;
  for (const ws of workspaces) {
    const workspaceId = ws.clerkOrgId || ws.id;
    try {
      started += await sweepWorkspace(env, workspaceId);
    } catch (err) {
      console.error(`[WeldAgentRoutineSweep] backfill workspace ${workspaceId} failed:`, err);
    }
  }
  await env.WORKSPACE_CACHE.put(ROUTINE_INDEX_BACKFILL_KEY, new Date().toISOString());
  return started;
}

/**
 * Hourly: run due WeldAgent cron routines. Reads due workspaces from the D1
 * routine index and opens only those tenant DBs — idle workspaces' Neon
 * computes stay suspended. Never fans out to every tenant (see AGENTS.md).
 */
export async function runWeldAgentRoutineSweep(env: Env): Promise<{ started: number }> {
  const d1 = env.SCHEDULE_INDEX;
  if (!d1) {
    console.warn('[WeldAgentRoutineSweep] SCHEDULE_INDEX binding missing; skipping sweep');
    return { started: 0 };
  }

  if (!(await env.WORKSPACE_CACHE.get(ROUTINE_INDEX_BACKFILL_KEY))) {
    const started = await backfillRoutineIndex(env);
    console.log(`[WeldAgentRoutineSweep] backfill started ${started} routine runs`);
    return { started };
  }

  let workspaceIds: string[];
  try {
    workspaceIds = await listWorkspacesWithDueRoutines(d1, Date.now());
  } catch (err) {
    // Deliberately no fallback to a tenant fan-out: skip this hour instead.
    console.error('[WeldAgentRoutineSweep] D1 routine index unavailable; skipping:', err);
    return { started: 0 };
  }

  let started = 0;
  for (const workspaceId of workspaceIds) {
    try {
      started += await sweepWorkspace(env, workspaceId);
    } catch (err) {
      console.error(`[WeldAgentRoutineSweep] workspace ${workspaceId} failed:`, err);
    }
  }
  console.log(
    `[WeldAgentRoutineSweep] ${workspaceIds.length} workspace(s) due, started ${started} routine runs`,
  );
  return { started };
}
