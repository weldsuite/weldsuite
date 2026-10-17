/**
 * Task Digest Sweep — Cloudflare Cron Handler
 *
 * Runs every hour via Cloudflare Cron Trigger (0 * * * *) — declared in-repo
 * in wrangler.toml `[triggers]` (api-worker had these crons configured only in
 * the Cloudflare dashboard; the app-api re-host makes them declarative).
 *
 * Reads enabled digest schedules from master DB, keeps the workspaces whose
 * send_hour is the current hour in their timezone (ADR FLOW-007: only those
 * tenants are opened), then dispatches a SendDigestWorkflow per eligible member.
 *
 * A workspace whose pass failed (the tenant could not be opened, or some member's
 * dispatch threw) is recorded in KV and retried by the next hourly passes of the
 * same local day, and only that workspace: a pass that succeeded is never repeated.
 * The workflow instance id carries the workspace-local date, so a retry finds the
 * members that already got their digest (instance exists, skipped) and only
 * dispatches the ones the failed pass missed; it also stops at local midnight.
 *
 * Ported from apps/api-worker/src/cron/digest-sweep.ts (W4 legacy-worker
 * phase-out) — only the Env/db import paths and the optional SEND_DIGEST
 * binding guard changed.
 */

import { eq, and, inArray, isNull } from 'drizzle-orm';
import type { Env } from '../types';
import { getMasterDb, getTenantDbForWorkspace, schema, masterSchema } from '@weldsuite/worker-kit/db';

/** True when `currentHour` is the workspace's send hour (the only hour its tenant is opened). */
export function isDue(currentHour: number, sendHour: number): boolean {
  return currentHour === sendHour;
}

/** KV prefix of the workspaces whose pass failed and is retried the same local day. */
export const RETRY_KEY_PREFIX = 'flow:digest-retry:';

/** A retry record outlives the local day it belongs to; older ones are dropped on sight. */
const RETRY_TTL_SECONDS = 26 * 60 * 60;

/** The failed pass of one workspace, retried until its local day ends. */
interface DigestRetry {
  timezone: string;
  /** Workspace-local date (YYYY-MM-DD) of the failed pass. */
  date: string;
}

export async function recordRetry(kv: KVNamespace, workspaceId: string, retry: DigestRetry): Promise<void> {
  try {
    await kv.put(RETRY_KEY_PREFIX + workspaceId, JSON.stringify(retry), { expirationTtl: RETRY_TTL_SECONDS });
  } catch (err) {
    console.warn(`[DigestSweep] could not record retry for ${workspaceId}:`, err);
  }
}

export async function clearRetry(kv: KVNamespace, workspaceId: string): Promise<void> {
  await kv.delete(RETRY_KEY_PREFIX + workspaceId).catch(() => undefined);
}

/**
 * Workspaces to retry now: recorded failures that are still on the local day of the
 * failed pass and whose schedule is still enabled. Anything else is dropped. A KV
 * failure only loses the retries; it never widens the sweep to other tenants.
 */
export async function listRetries(
  kv: KVNamespace,
  schedules: Map<string, DueSchedule>,
): Promise<DueSchedule[]> {
  const retries: DueSchedule[] = [];
  try {
    const { keys } = await kv.list({ prefix: RETRY_KEY_PREFIX });
    for (const { name } of keys) {
      const workspaceId = name.slice(RETRY_KEY_PREFIX.length);
      const record = await kv.get<DigestRetry>(name, 'json');
      const sameDay = record && schedules.has(workspaceId) && getTodayInTimezone(record.timezone) === record.date;
      if (record && sameDay) retries.push({ workspaceId, timezone: record.timezone });
      else await clearRetry(kv, workspaceId);
    }
  } catch (err) {
    console.warn('[DigestSweep] could not read the retry list:', err);
  }
  return retries;
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
  return err instanceof Error && /already[_ ]exists/i.test(err.message);
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
 * failure is logged and does not stop the rest; the caller records the workspace
 * for a retry when any member failed (members already dispatched are skipped on
 * the retry). `counter.dispatched` is bumped per member so a mid-workspace
 * failure still keeps the count of workflows already created. Returns how many
 * members failed.
 */
async function sweepWorkspace(
  env: Env,
  workflow: SendDigestWorkflow,
  masterDb: MasterDb,
  schedule: DueSchedule,
  counter: { dispatched: number },
): Promise<number> {
  // Look up clerkOrgId
  const [workspace] = await masterDb
    .select({ clerkOrgId: masterSchema.workspaces.clerkOrgId })
    .from(masterSchema.workspaces)
    .where(eq(masterSchema.workspaces.id, schedule.workspaceId))
    .limit(1);

  if (!workspace?.clerkOrgId) {
    console.warn(`[DigestSweep] Workspace ${schedule.workspaceId} has no clerkOrgId`);
    return 0;
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
  if (members.length === 0) return 0;

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

  const failureNote = failed > 0 ? `, ${failed} failed (retried next pass)` : '';
  console.log(`[DigestSweep] Workspace ${schedule.workspaceId}: ${members.length} members checked${failureNote}`);
  return failed;
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

  // Only workspaces whose send_hour is the current hour in their timezone.
  const dueWorkspaces: DueSchedule[] = allSchedules.filter((s) => {
    const currentHour = hourByTimezone.get(s.timezone);
    return currentHour !== undefined && isDue(currentHour, s.sendHour);
  });

  // Plus the workspaces whose earlier pass today failed, and only those.
  const dueIds = new Set(dueWorkspaces.map((s) => s.workspaceId));
  const schedulesById = new Map(allSchedules.map((s) => [s.workspaceId, s]));
  const retries = (await listRetries(env.WORKSPACE_CACHE, schedulesById)).filter((s) => !dueIds.has(s.workspaceId));
  const toSweep = [...dueWorkspaces, ...retries];

  console.log(
    `[DigestSweep] ${dueWorkspaces.length} workspaces due, ${retries.length} retried (of ${allSchedules.length} enabled)`,
  );

  const counter = { dispatched: 0 };

  for (const schedule of toSweep) {
    let failed: number;
    try {
      failed = await sweepWorkspace(env, env.SEND_DIGEST, masterDb, schedule, counter);
    } catch (err) {
      failed = 1;
      console.error(`[DigestSweep] Failed workspace ${schedule.workspaceId}:`, err instanceof Error ? err.message : err);
    }
    if (failed > 0) {
      await recordRetry(env.WORKSPACE_CACHE, schedule.workspaceId, {
        timezone: schedule.timezone,
        date: getTodayInTimezone(schedule.timezone),
      });
    } else if (!dueIds.has(schedule.workspaceId)) {
      await clearRetry(env.WORKSPACE_CACHE, schedule.workspaceId);
    }
  }

  const { dispatched } = counter;
  console.log(`[DigestSweep] Completed: ${dispatched} workflows dispatched`);
  return { dispatched };
}
