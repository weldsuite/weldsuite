/**
 * Hourly sweep for due WeldAgent cron routines across tenant DBs.
 */

import { isNull } from 'drizzle-orm';
import type { Env } from '../types';
import { getMasterDb, getTenantDbForWorkspace, masterSchema } from '../db';
import {
  listDueCronRoutines,
  createRoutineRun,
  completeRoutineRun,
  markRoutineScheduled,
} from '../services/weldagent/parity';
import { executeAgentRun } from '../services/weldagent/run';
import type { AgentDb } from '../services/weldagent/agents';

/**
 * Run due cron routines for one tenant.
 */
export async function runWeldAgentRoutineSweepForTenant(params: {
  env: Env;
  workspaceId: string;
  db: AgentDb;
  actorUserId?: string;
}): Promise<{ started: number }> {
  const due = await listDueCronRoutines(params.db);
  let started = 0;
  for (const routine of due) {
    const runId = await createRoutineRun(params.db, {
      routineId: routine.id,
      agentId: routine.agentId,
      trigger: 'schedule',
    });
    await markRoutineScheduled(params.db, routine.id);
    started += 1;
    try {
      const result = await executeAgentRun({
        db: params.db,
        env: params.env,
        workspaceId: params.workspaceId,
        actorUserId: params.actorUserId || 'system',
        agentId: routine.agentId,
        triggerType: 'event',
        triggerData: { routineId: routine.id, schedule: true },
        userMessage: `Scheduled routine "${routine.name}" is due.\n\n${routine.instructions}`,
        extraSystem: routine.requireApproval
          ? 'Require approval before consequential outbound actions.'
          : undefined,
      });
      await completeRoutineRun(params.db, runId, {
        status: result.success ? 'succeeded' : 'failed',
        summary: result.text,
        error: result.error,
        agentRunId: result.runId,
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

export async function runWeldAgentRoutineSweep(env: Env): Promise<{ started: number }> {
  console.log('[WeldAgentRoutineSweep] Starting hourly sweep');
  const masterDb = getMasterDb(env);
  const workspaces = await masterDb
    .select({
      id: masterSchema.workspaces.id,
      clerkOrgId: masterSchema.workspaces.clerkOrgId,
    })
    .from(masterSchema.workspaces)
    .where(isNull(masterSchema.workspaces.scheduledDeletionAt))
    .limit(500);

  let started = 0;
  for (const ws of workspaces) {
    const workspaceId = ws.clerkOrgId || ws.id;
    try {
      const db = await getTenantDbForWorkspace(env, workspaceId);
      const result = await runWeldAgentRoutineSweepForTenant({ env, workspaceId, db });
      started += result.started;
    } catch (err) {
      console.error(`[WeldAgentRoutineSweep] workspace ${workspaceId} failed:`, err);
    }
  }
  console.log(`[WeldAgentRoutineSweep] started ${started} routine runs`);
  return { started };
}
