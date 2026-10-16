/**
 * Task Digest Sweep — Cloudflare Cron Handler
 *
 * Runs every hour via Cloudflare Cron Trigger (0 * * * *) — declared in-repo
 * in wrangler.toml `[triggers]` (api-worker had these crons configured only in
 * the Cloudflare dashboard; the app-api re-host makes them declarative).
 *
 * Reads enabled digest schedules from master DB, filters to workspaces
 * whose send_hour has come in their timezone (the send hour itself plus a short
 * catch-up window, see `isDue`), then dispatches a SendDigestWorkflow per
 * eligible member.
 *
 * Resumable: the workflow instance id carries the workspace-local date, so a
 * second pass the same day finds the members that already got their digest
 * (instance exists, skipped) and only dispatches the ones a failed earlier pass
 * missed.
 *
 * Ported from apps/api-worker/src/cron/digest-sweep.ts (W4 legacy-worker
 * phase-out) — only the Env/db import paths and the optional SEND_DIGEST
 * binding guard changed.
 */

import { eq, and, inArray, isNull } from 'drizzle-orm';
import type { Env } from '../types';
import { getMasterDb, getTenantDbForWorkspace, schema, masterSchema } from '@weldsuite/worker-kit/db';

/**
 * How many hours past `send_hour` a workspace is still swept. The sweep runs
 * hourly, so without this a member whose dispatch failed (or a workspace the
 * sweep itself failed on) would wait until the next day; with it they are
 * retried for a few hours. Stays within the local day: the instance id carries
 * the date, and a pass after midnight would start a second digest.
 */
export const CATCH_UP_HOURS = 3;

/** True when `currentHour` is the send hour or inside the catch-up window after it (same local day). */
export function isDue(currentHour: number, sendHour: number): boolean {
  return currentHour >= sendHour && currentHour - sendHour < CATCH_UP_HOURS;
}

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
        const hour = Number.parseInt(hourPart.value, 10) % 24;
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

type MasterDb = ReturnType<typeof getMasterDb>;
type SendDigestWorkflow = NonNullable<Env['SEND_DIGEST']>;

interface DigestMember {
  userId: string;
  email: string | null;
  name: string | null;
}

interface DueSchedule {
  workspaceId: string;
  timezone: string;
}

/** The slice of a member's notification preferences the digest honours. */
interface DigestPreferences {
  doNotDisturb: boolean | null;
  modulePreferences: unknown;
}

type DispatchResult = 'dispatched' | 'skipped' | 'already-sent';

/** Whether the member opted out of the digest (do-not-disturb, or digest / email preference disabled). */
function hasOptedOut(prefs: DigestPreferences | undefined): boolean {
  if (prefs?.doNotDisturb) return true;
  const modulePrefs = prefs?.modulePreferences as Record<string, { enabled?: boolean; email?: boolean }> | null | undefined;
  return modulePrefs?.digest?.enabled === false || modulePrefs?.digest?.email === false;
}

/** `workflow.create` rejects an id that already has an instance. */
function isDuplicateInstance(err: unknown): boolean {
  return err instanceof Error && /already|exist|duplicate/i.test(err.message);
}

/**
 * Dispatch the digest workflow for one member unless they have no email or
 * opted out. 'already-sent' means today's instance exists (an earlier pass
 * dispatched it), which is what makes a repeat pass safe.
 */
export async function dispatchMemberDigest(
  workflow: SendDigestWorkflow,
  prefs: DigestPreferences | undefined,
  clerkOrgId: string,
  member: DigestMember,
  timezone: string,
  dateStr: string,
): Promise<DispatchResult> {
  if (!member.email || hasOptedOut(prefs)) return 'skipped';

  try {
    await workflow.create({
      id: `digest-${clerkOrgId}-${member.userId}-${dateStr}`,
      params: {
        workspaceId: clerkOrgId,
        userId: member.userId,
        email: member.email,
        name: member.name || member.email.split('@')[0],
        timezone,
      },
    });
  } catch (err) {
    if (isDuplicateInstance(err)) return 'already-sent';
    throw err;
  }
  return 'dispatched';
}

/**
 * Dispatch digests for every active member of one due workspace. One member's
 * failure is logged and does not stop the rest, and the workspace is retried
 * on the next pass of the catch-up window (members already dispatched are
 * skipped). `counter.dispatched` is bumped per member so a mid-workspace
 * failure still keeps the count of workflows already created.
 */
async function sweepWorkspace(
  env: Env,
  workflow: SendDigestWorkflow,
  masterDb: MasterDb,
  schedule: DueSchedule,
  counter: { dispatched: number },
): Promise<void> {
  // Look up clerkOrgId
  const [workspace] = await masterDb
    .select({ clerkOrgId: masterSchema.workspaces.clerkOrgId })
    .from(masterSchema.workspaces)
    .where(eq(masterSchema.workspaces.id, schedule.workspaceId))
    .limit(1);

  if (!workspace?.clerkOrgId) {
    console.warn(`[DigestSweep] Workspace ${schedule.workspaceId} has no clerkOrgId`);
    return;
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
  if (members.length === 0) return;

  // Notification preferences for the whole workspace in one query.
  const prefRows = await db
    .select({
      userId: schema.notificationPreferences.userId,
      doNotDisturb: schema.notificationPreferences.doNotDisturb,
      modulePreferences: schema.notificationPreferences.modulePreferences,
    })
    .from(schema.notificationPreferences)
    .where(inArray(schema.notificationPreferences.userId, members.map((m) => m.userId)));
  const prefsByUser = new Map(prefRows.map((row) => [row.userId, row]));

  let failed = 0;
  for (const member of members) {
    try {
      const result = await dispatchMemberDigest(
        workflow,
        prefsByUser.get(member.userId),
        workspace.clerkOrgId,
        member,
        schedule.timezone,
        dateStr,
      );
      if (result === 'dispatched') counter.dispatched++;
    } catch (err) {
      failed++;
      console.error(
        `[DigestSweep] Failed member ${member.userId} in workspace ${schedule.workspaceId}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  console.log(
    `[DigestSweep] Workspace ${schedule.workspaceId}: ${members.length} members checked${failed > 0 ? `, ${failed} failed (retried next pass)` : ''}`,
  );
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

  // Filter to workspaces whose send_hour has come (send hour + catch-up window) in their timezone
  const dueWorkspaces = allSchedules.filter((s) => {
    const currentHour = hourByTimezone.get(s.timezone);
    return currentHour !== undefined && isDue(currentHour, s.sendHour);
  });

  console.log(`[DigestSweep] ${dueWorkspaces.length} workspaces due (of ${allSchedules.length} enabled)`);

  const counter = { dispatched: 0 };

  for (const schedule of dueWorkspaces) {
    try {
      await sweepWorkspace(env, env.SEND_DIGEST, masterDb, schedule, counter);
    } catch (err) {
      console.error(`[DigestSweep] Failed workspace ${schedule.workspaceId}:`, err instanceof Error ? err.message : err);
    }
  }

  const { dispatched } = counter;
  console.log(`[DigestSweep] Completed: ${dispatched} workflows dispatched`);
  return { dispatched };
}
