/**
 * Calendar Replan Sweep — daily Cloudflare Cron Handler
 *
 * Asks calendar-sync to reschedule auto-scheduled events whose startTime has
 * slipped into the past while their source task is still incomplete. Keeps
 * the calendar honest when planned work didn't happen on the planned day.
 *
 * Due workspaces come from the D1 replan index (lib/calendar-replan-index.ts),
 * not a tenant fan-out: only tenants with a stale event are opened (see
 * AGENTS.md).
 *
 * Wired into the daily cron ("0 4 * * *") in apps/workers/app-api/src/index.ts —
 * declared in-repo in wrangler.toml `[triggers]`.
 */

import { and, eq, inArray } from 'drizzle-orm';
import type { Env } from '../types';
import { getMasterDb, getTenantDbForWorkspace, masterSchema } from '../db';
import { replanStaleAutoScheduledEvents } from '@weldsuite/db/lib/calendar-sync';
import {
  calendarReplanIndexSync,
  computeCalendarReplanDueAt,
  listWorkspacesWithDueCalendarReplan,
  reindexWorkspaceCalendarReplan,
  writeCalendarReplanIndex,
} from '../lib/calendar-replan-index';

const PER_WORKSPACE_BATCH_LIMIT = 200;

/** KV flag: the one-time D1 index backfill has run. Bump the version to rebuild. */
export const CALENDAR_REPLAN_INDEX_BACKFILL_KEY = 'calendar:replan-index:backfill:v1';

/**
 * One-time backfill: the only pass that opens every tenant DB. Indexes the
 * events that existed before the D1 index. A tenant that can't be read is
 * marked due now, so the daily sweep keeps retrying it instead of losing it.
 * The flag is set only when every index write landed.
 */
async function backfillCalendarReplanIndex(env: Env, d1: D1Database): Promise<void> {
  console.log('[CalendarReplan] Backfilling D1 replan index (one-time)');
  const workspaces = await getMasterDb(env)
    .select({ clerkOrgId: masterSchema.workspaces.clerkOrgId })
    .from(masterSchema.workspaces)
    .where(eq(masterSchema.workspaces.isActive, true));

  let writeFailures = 0;
  for (const ws of workspaces) {
    if (!ws.clerkOrgId) continue;
    let dueAt: Date | null;
    try {
      const db = await getTenantDbForWorkspace(env, ws.clerkOrgId);
      dueAt = await computeCalendarReplanDueAt(db);
    } catch (err) {
      console.error(`[CalendarReplan] backfill workspace ${ws.clerkOrgId} failed:`, err);
      dueAt = new Date();
    }
    try {
      await writeCalendarReplanIndex(d1, ws.clerkOrgId, dueAt);
    } catch (err) {
      writeFailures += 1;
      console.error(`[CalendarReplan] backfill index write ${ws.clerkOrgId} failed:`, err);
    }
  }

  if (writeFailures === 0) {
    await env.WORKSPACE_CACHE.put(CALENDAR_REPLAN_INDEX_BACKFILL_KEY, new Date().toISOString());
  }
}

export async function runCalendarReplanSweep(env: Env): Promise<{
  workspacesScanned: number;
  totalScanned: number;
  totalRescheduled: number;
  totalFailed: number;
}> {
  const empty = { workspacesScanned: 0, totalScanned: 0, totalRescheduled: 0, totalFailed: 0 };
  console.log('[CalendarReplan] Starting daily sweep');

  const d1 = env.SCHEDULE_INDEX;
  if (!d1) {
    console.warn('[CalendarReplan] SCHEDULE_INDEX binding missing; skipping sweep');
    return empty;
  }

  if (!(await env.WORKSPACE_CACHE.get(CALENDAR_REPLAN_INDEX_BACKFILL_KEY))) {
    await backfillCalendarReplanIndex(env, d1);
  }

  let dueWorkspaceIds: string[];
  try {
    dueWorkspaceIds = await listWorkspacesWithDueCalendarReplan(d1, Date.now());
  } catch (err) {
    // Deliberately no fallback to a tenant fan-out: skip this run instead.
    console.error('[CalendarReplan] D1 replan index unavailable; skipping:', err);
    return empty;
  }
  if (dueWorkspaceIds.length === 0) {
    console.log('[CalendarReplan] Done. No workspace has a stale event');
    return empty;
  }

  // Suspended workspaces keep their index row but are never opened.
  const workspaces = await getMasterDb(env)
    .select({ id: masterSchema.workspaces.id, clerkOrgId: masterSchema.workspaces.clerkOrgId })
    .from(masterSchema.workspaces)
    .where(
      and(
        eq(masterSchema.workspaces.isActive, true),
        inArray(masterSchema.workspaces.clerkOrgId, dueWorkspaceIds),
      ),
    );

  let totalScanned = 0;
  let totalRescheduled = 0;
  let totalFailed = 0;

  for (const ws of workspaces) {
    if (!ws.clerkOrgId) continue;

    try {
      const db = await getTenantDbForWorkspace(env, ws.clerkOrgId);
      const result = await replanStaleAutoScheduledEvents(db, { batchLimit: PER_WORKSPACE_BATCH_LIMIT });

      totalScanned += result.scanned;
      totalRescheduled += result.rescheduled;
      totalFailed += result.failed;

      if (result.scanned > 0) {
        console.log(`[CalendarReplan] ws=${ws.id} scanned=${result.scanned} rescheduled=${result.rescheduled} failed=${result.failed}`);
      }

      // The tenant is awake anyway: refresh its index row (replanned events
      // moved forward; anything left over keeps the workspace due).
      await reindexWorkspaceCalendarReplan(calendarReplanIndexSync(env, ws.clerkOrgId), db);
    } catch (err) {
      console.error(`[CalendarReplan] Workspace ${ws.id} failed:`, err);
      totalFailed++;
    }
  }

  console.log(`[CalendarReplan] Done. due=${dueWorkspaceIds.length} workspaces=${workspaces.length} scanned=${totalScanned} rescheduled=${totalRescheduled} failed=${totalFailed}`);

  return {
    workspacesScanned: workspaces.length,
    totalScanned,
    totalRescheduled,
    totalFailed,
  };
}
