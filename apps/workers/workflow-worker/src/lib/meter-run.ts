/**
 * Counts a WeldConnect run against the plan's monthly workflow-run allowance
 * (`@weldsuite/credits/meters`): inside it the run is free, past it the
 * wallet pays an overage block, and a plan that stops at its allowance (or an
 * empty wallet) refuses the run. Fails open when metering is unavailable.
 */

import { resolveInternalWorkspaceId } from '@weldsuite/credits';
import { meterDeniedMessage, meterUsage } from '@weldsuite/credits/meters';
import { getMasterDb } from '../db';
import type { WorkflowEnv } from '../engine/types';

/** Why the run may not go ahead, or `null` when it may. */
export async function meterRun(env: WorkflowEnv, workspaceRef: string, executionId: string, userId: string): Promise<string | null> {
  if (!env.DATABASE_URL_MASTER) return null;
  try {
    const masterDb = getMasterDb(env);
    const workspaceId = await resolveInternalWorkspaceId(masterDb, workspaceRef);
    if (!workspaceId) return null;
    const result = await meterUsage(masterDb, {
      workspaceId,
      meter: 'workflow_runs',
      referenceId: executionId,
      referenceType: 'workflow_execution',
      userId,
    });
    return result.allowed ? null : meterDeniedMessage(result);
  } catch (err) {
    console.warn('[meter-run] metering unavailable, running:', err instanceof Error ? err.message : err);
    return null;
  }
}
