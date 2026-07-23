/**
 * Task Digest Sweep — Cloudflare Cron Handler
 *
 * Runs every hour via Cloudflare Cron Trigger (0 * * * *) — declared in-repo
 * in wrangler.toml `[triggers]` (api-worker had these crons configured only in
 * the Cloudflare dashboard; the app-api re-host makes them declarative).
 *
 * Reads enabled digest schedules from master DB, filters to workspaces
 * whose send_hour matches the current hour in their timezone, then
 * dispatches a SendDigestWorkflow per eligible member.
 *
 * Ported from apps/api-worker/src/cron/digest-sweep.ts (W4 legacy-worker
 * phase-out) — only the Env/db import paths and the optional SEND_DIGEST
 * binding guard changed.
 */

import { eq, and, isNull } from 'drizzle-orm';
import type { Env } from '../types';
import { getMasterDb, getTenantDbForWorkspace, schema, masterSchema } from '../db';

/**
 * Compute current hour for each timezone using Intl.DateTimeFormat.
 */
function getCurrentHourForTimezones(timezones: string[]): Map<string, number> {
  const result = new Map<string, number>();
  const now = new Date();

  for (const tz of timezones) {
    try {
      const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        hour: 'numeric',
        hour12: false,
      });
      const parts = formatter.formatToParts(now);
      const hourPart = parts.find((p) => p.type === 'hour');
      if (hourPart) {
        const hour = parseInt(hourPart.value, 10) % 24;
        result.set(tz, hour);
      }
    } catch {
      console.warn(`[DigestSweep] Invalid timezone: ${tz}, skipping`);
    }
  }

  return result;
}

/**
 * Get today's date string (YYYY-MM-DD) in a given timezone.
 * Used for workflow instance ID dedup.
 */
function getTodayInTimezone(timezone: string): string {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return formatter.format(new Date());
}

/**
 * Run the hourly digest sweep.
 * Returns the number of workflow instances dispatched.
 */
export async function runDigestSweep(env: Env): Promise<{ dispatched: number }> {
  console.log('[DigestSweep] Starting hourly sweep');

  if (!env.SEND_DIGEST) {
    console.warn('[DigestSweep] SEND_DIGEST workflow binding missing — skipping sweep');
    return { dispatched: 0 };
  }

  const masterDb = getMasterDb(env);

  // Get all enabled digest schedules
  const allSchedules = await masterDb
    .select({
      workspaceId: masterSchema.digestSchedules.workspaceId,
      sendHour: masterSchema.digestSchedules.sendHour,
      timezone: masterSchema.digestSchedules.timezone,
    })
    .from(masterSchema.digestSchedules)
    .where(eq(masterSchema.digestSchedules.enabled, true));

  if (allSchedules.length === 0) {
    console.log('[DigestSweep] No enabled digest schedules');
    return { dispatched: 0 };
  }

  // Compute current hour for each unique timezone
  const uniqueTimezones = [...new Set(allSchedules.map((s) => s.timezone))];
  const hourByTimezone = getCurrentHourForTimezones(uniqueTimezones);

  // Filter to workspaces whose send_hour matches current hour in their timezone
  const dueWorkspaces = allSchedules.filter((s) => {
    const currentHour = hourByTimezone.get(s.timezone);
    return currentHour !== undefined && currentHour === s.sendHour;
  });

  console.log(`[DigestSweep] ${dueWorkspaces.length} workspaces due (of ${allSchedules.length} enabled)`);

  let dispatched = 0;

  for (const schedule of dueWorkspaces) {
    try {
      // Look up clerkOrgId
      const [workspace] = await masterDb
        .select({ clerkOrgId: masterSchema.workspaces.clerkOrgId })
        .from(masterSchema.workspaces)
        .where(eq(masterSchema.workspaces.id, schedule.workspaceId))
        .limit(1);

      if (!workspace?.clerkOrgId) {
        console.warn(`[DigestSweep] Workspace ${schedule.workspaceId} has no clerkOrgId`);
        continue;
      }

      const db = await getTenantDbForWorkspace(env, workspace.clerkOrgId);
      const dateStr = getTodayInTimezone(schedule.timezone);

      // Get active members
      const members = await db
        .select({
          userId: schema.workspaceMembers.userId,
          email: schema.workspaceMembers.email,
          name: schema.workspaceMembers.name,
        })
        .from(schema.workspaceMembers)
        .where(and(
          eq(schema.workspaceMembers.status, 'ACTIVE'),
          isNull(schema.workspaceMembers.deletedAt),
        ));

      for (const member of members) {
        if (!member.email) continue;

        // Check notification preferences
        const [prefs] = await db
          .select()
          .from(schema.notificationPreferences)
          .where(eq(schema.notificationPreferences.userId, member.userId))
          .limit(1);

        if (prefs?.doNotDisturb) continue;

        const modulePrefs = prefs?.modulePreferences as Record<string, any> | null;
        if (modulePrefs?.digest?.enabled === false || modulePrefs?.digest?.email === false) continue;

        // Dispatch workflow
        await env.SEND_DIGEST.create({
          id: `digest-${workspace.clerkOrgId}-${member.userId}-${dateStr}`,
          params: {
            workspaceId: workspace.clerkOrgId,
            userId: member.userId,
            email: member.email,
            name: member.name || member.email.split('@')[0],
            timezone: schedule.timezone,
          },
        });

        dispatched++;
      }

      console.log(`[DigestSweep] Dispatched for workspace ${schedule.workspaceId}: ${members.length} members checked`);
    } catch (err) {
      console.error(`[DigestSweep] Failed workspace ${schedule.workspaceId}:`, err instanceof Error ? err.message : err);
    }
  }

  console.log(`[DigestSweep] Completed: ${dispatched} workflows dispatched`);
  return { dispatched };
}
