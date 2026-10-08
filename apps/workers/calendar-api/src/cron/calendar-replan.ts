/**
 * Calendar Replan Sweep — daily Cloudflare Cron Handler ("0 4 * * *").
 *
 * Asks calendar-sync to reschedule auto-scheduled events whose startTime has
 * slipped into the past while their source task is still incomplete. Keeps
 * the calendar honest when planned work didn't happen on the planned day.
 *
 * It used to open every active workspace's tenant DB each night to find the
 * few with stale events. Timing now lives in the SCHEDULE_INDEX D1
 * `workspace_due_index` (kind `calendar_replan`), per AGENTS.md:
 *
 * - Task writes that place an auto-scheduled event (flow-api tasks, the
 *   connect-api create-task action, unpin here) mark the workspace due at its
 *   next event's start.
 * - Each run opens only due workspaces, re-plans them and stores the start of
 *   their next auto-scheduled event (`nextAutoScheduledReplanAt`), or drops
 *   the row when there is none.
 * - A one-time seed (KV flag below) marks every active workspace due once.
 */

import { eq, isNotNull, and } from 'drizzle-orm';
import type { Env } from '../types';
import { getMasterDb, getTenantDbForWorkspace, masterSchema } from '@weldsuite/worker-kit/db';
import { runDueIndexSweep } from '@weldsuite/worker-kit/due-index';
import { nextAutoScheduledReplanAt, replanStaleAutoScheduledEvents } from '@weldsuite/db/lib/calendar-sync';

const PER_WORKSPACE_BATCH_LIMIT = 200;

/** KV flag: active workspaces were seeded into the due index. Bump to reseed. */
export const CALENDAR_REPLAN_SEED_KEY = 'calendar:replan-index:seed:v1';

/** Workspaces per run; the rest stay due for the next night. */
const WORKSPACES_PER_RUN = 1000;

async function listActiveWorkspaceOrgIds(env: Env): Promise<string[]> {
  const rows = await getMasterDb(env)
    .select({ clerkOrgId: masterSchema.workspaces.clerkOrgId })
    .from(masterSchema.workspaces)
    .where(and(eq(masterSchema.workspaces.isActive, true), isNotNull(masterSchema.workspaces.clerkOrgId)));
  return rows.map((r) => r.clerkOrgId).filter((id): id is string => !!id);
}

export async function runCalendarReplanSweep(env: Env): Promise<{
  workspacesScanned: number;
  totalScanned: number;
  totalRescheduled: number;
  totalFailed: number;
}> {
  console.log('[CalendarReplan] Starting daily sweep');

  let totalScanned = 0;
  let totalRescheduled = 0;
  let totalFailed = 0;

  const result = await runDueIndexSweep({
    d1: env.SCHEDULE_INDEX,
    kv: env.WORKSPACE_CACHE,
    kind: 'calendar_replan',
    label: '[CalendarReplan]',
    seed: { key: CALENDAR_REPLAN_SEED_KEY, listWorkspaces: () => listActiveWorkspaceOrgIds(env) },
    limit: WORKSPACES_PER_RUN,
    process: async (orgId) => {
      const db = await getTenantDbForWorkspace(env, orgId);
      const replan = await replanStaleAutoScheduledEvents(db, { batchLimit: PER_WORKSPACE_BATCH_LIMIT });
      totalScanned += replan.scanned;
      totalRescheduled += replan.rescheduled;
      totalFailed += replan.failed;
      if (replan.scanned > 0) {
        console.log(
          `[CalendarReplan] ws=${orgId} scanned=${replan.scanned} rescheduled=${replan.rescheduled} failed=${replan.failed}`,
        );
      }
      return nextAutoScheduledReplanAt(db);
    },
  });

  totalFailed += result.failed;
  console.log(
    `[CalendarReplan] Done. due=${result.due} workspaces=${result.processed} scanned=${totalScanned} rescheduled=${totalRescheduled} failed=${totalFailed}`,
  );

  return {
    workspacesScanned: result.processed,
    totalScanned,
    totalRescheduled,
    totalFailed,
  };
}
