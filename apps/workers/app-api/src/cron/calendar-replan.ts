/**
 * Calendar Replan Sweep — daily Cloudflare Cron Handler
 *
 * Walks every active workspace and asks calendar-sync to reschedule any
 * auto-scheduled events whose startTime has slipped into the past while
 * their source task is still incomplete. Keeps the calendar honest when
 * planned work didn't happen on the planned day.
 *
 * Wired into the daily cron ("0 4 * * *") in apps/workers/app-api/src/index.ts —
 * declared in-repo in wrangler.toml `[triggers]` (api-worker had this cron
 * configured only in the Cloudflare dashboard).
 *
 * Ported from apps/api-worker/src/cron/calendar-replan.ts (W4 legacy-worker
 * phase-out) — only the Env/db import paths changed.
 */

import { eq } from 'drizzle-orm';
import type { Env } from '../types';
import { getMasterDb, getTenantDbForWorkspace, masterSchema } from '../db';
import { replanStaleAutoScheduledEvents } from '@weldsuite/db/lib/calendar-sync';

const PER_WORKSPACE_BATCH_LIMIT = 200;

export async function runCalendarReplanSweep(env: Env): Promise<{
  workspacesScanned: number;
  totalScanned: number;
  totalRescheduled: number;
  totalFailed: number;
}> {
  console.log('[CalendarReplan] Starting daily sweep');

  const masterDb = getMasterDb(env);

  const workspaces = await masterDb
    .select({
      id: masterSchema.workspaces.id,
      clerkOrgId: masterSchema.workspaces.clerkOrgId,
    })
    .from(masterSchema.workspaces)
    .where(eq(masterSchema.workspaces.isActive, true));

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
    } catch (err) {
      console.error(`[CalendarReplan] Workspace ${ws.id} failed:`, err);
      totalFailed++;
    }
  }

  console.log(`[CalendarReplan] Done. workspaces=${workspaces.length} scanned=${totalScanned} rescheduled=${totalRescheduled} failed=${totalFailed}`);

  return {
    workspacesScanned: workspaces.length,
    totalScanned,
    totalRescheduled,
    totalFailed,
  };
}
