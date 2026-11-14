/**
 * WeldDesk report schedule sweep: Cloudflare cron handler (every minute).
 *
 * Sends the scheduled report emails that came due (`helpdesk_report_schedules`,
 * TASK-1228). It never wakes idle tenant DBs (ADR DATA-008): timing lives in
 * the SCHEDULE_INDEX D1 `workspace_due_index` (kind `desk_report`). Every
 * write to a schedule marks the workspace due at the schedule's `nextRunAt`
 * (lib/report-due.ts); each tick reads only D1, opens the workspaces that are
 * due, sends their due schedules and stores when the workspace is next due (or
 * drops the row when no enabled schedule is left). Nothing existed before this
 * index, so there is nothing to seed.
 *
 * Bounds per tick: at most WORKSPACES_PER_TICK workspaces, SCHEDULES_PER_WORKSPACE
 * schedules in each, and SCHEDULES_PER_TICK sends in all. Whatever does not fit
 * stays due and goes out on the next tick.
 *
 * A schedule is claimed (its `nextRunAt` moved to the next slot) before it is
 * sent, so two overlapping ticks never send it twice and a failing one is not
 * retried in a loop: the next attempt is the next scheduled slot.
 */

import { and, asc, eq, isNotNull, lte, min } from 'drizzle-orm';
import { getTenantDbForWorkspace, schema, type Database } from '@weldsuite/worker-kit/db';
import { runDueIndexSweep, type DueIndexSweepResult } from '@weldsuite/worker-kit/due-index';
import type { Env } from '../types';
import {
  nextReportRun,
  REPORT_GONE_MESSAGE,
  sendScheduledReport,
  timingOf,
  type ReportScheduleRow,
  type ReportSendResult,
} from '../services/desk-report-schedules';

/** The cron expression that runs this sweep; keep in step with wrangler.toml. */
export const REPORT_SWEEP_CRONS = ['* * * * *'] as const;

export function isReportSweepCron(cron: string): boolean {
  return (REPORT_SWEEP_CRONS as readonly string[]).includes(cron);
}

/** KV flag for the due index's one-time seed (nothing to seed: see above). */
export const REPORT_INDEX_SEED_KEY = 'desk:report-index:seed:v1';

/** A workspace that failed (Neon hiccup, broken tenant) is retried after this. */
const RETRY_AFTER_MS = 10 * 60_000;
const WORKSPACES_PER_TICK = 50;
export const SCHEDULES_PER_WORKSPACE = 20;
const SCHEDULES_PER_TICK = 60;

type Send = (schedule: ReportScheduleRow, now: Date) => Promise<ReportSendResult>;

export interface WorkspaceReportSweep {
  sent: number;
  failed: number;
  disabled: number;
  /** When the workspace next has a schedule due (null: none enabled). */
  next: Date | null;
}

/**
 * Send one workspace's due schedules and answer when it next has one due.
 * `send` is replaceable for tests.
 */
export async function sweepWorkspaceReports(
  env: Env,
  db: Database,
  orgId: string,
  now: Date,
  options: { send?: Send; limit?: number; shouldStop?: () => boolean } = {},
): Promise<WorkspaceReportSweep> {
  const { helpdeskReportSchedules: schedules } = schema;
  const send: Send =
    options.send ?? ((schedule, at) => sendScheduledReport({ env, db, clerkOrgId: orgId, schedule, now: at }));
  const result: WorkspaceReportSweep = { sent: 0, failed: 0, disabled: 0, next: null };

  const due = await db
    .select()
    .from(schedules)
    .where(and(eq(schedules.enabled, true), isNotNull(schedules.nextRunAt), lte(schedules.nextRunAt, now)))
    .orderBy(asc(schedules.nextRunAt))
    .limit(options.limit ?? SCHEDULES_PER_WORKSPACE);

  for (const schedule of due) {
    if (options.shouldStop?.()) break;
    // Claim the slot: only the tick that moves `nextRunAt` off the value it read sends.
    const claimed = await db
      .update(schedules)
      .set({ nextRunAt: nextReportRun(timingOf(schedule), now) })
      .where(and(eq(schedules.id, schedule.id), eq(schedules.nextRunAt, schedule.nextRunAt!)))
      .returning({ id: schedules.id });
    if (claimed.length === 0) continue;

    const outcome = await send(schedule, now);
    if (outcome.status === 'gone') {
      await db
        .update(schedules)
        .set({ enabled: false, nextRunAt: null, lastRunAt: now, lastStatus: 'failed', lastError: REPORT_GONE_MESSAGE })
        .where(eq(schedules.id, schedule.id));
      result.disabled += 1;
      continue;
    }
    await db
      .update(schedules)
      .set({
        lastRunAt: now,
        lastStatus: outcome.status,
        lastError: outcome.status === 'failed' ? outcome.error : null,
      })
      .where(eq(schedules.id, schedule.id));
    if (outcome.status === 'sent') result.sent += 1;
    else result.failed += 1;
  }

  const [earliest] = await db
    .select({ next: min(schedules.nextRunAt) })
    .from(schedules)
    .where(and(eq(schedules.enabled, true), isNotNull(schedules.nextRunAt)));
  result.next = earliest?.next ? new Date(earliest.next) : null;
  return result;
}

export async function runReportScheduleSweep(
  env: Env,
  now: Date = new Date(),
): Promise<DueIndexSweepResult & { sent: number; sendFailed: number; disabled: number }> {
  const totals = { sent: 0, failed: 0, disabled: 0 };
  const result = await runDueIndexSweep({
    d1: env.SCHEDULE_INDEX,
    kv: env.WORKSPACE_CACHE,
    kind: 'desk_report',
    label: '[DeskReports]',
    seed: { key: REPORT_INDEX_SEED_KEY, listWorkspaces: async () => [] },
    retryAfterMs: RETRY_AFTER_MS,
    limit: WORKSPACES_PER_TICK,
    now: now.getTime(),
    shouldStop: () => totals.sent + totals.failed + totals.disabled >= SCHEDULES_PER_TICK,
    process: async (orgId, at) => {
      const db = (await getTenantDbForWorkspace(env, orgId)) as unknown as Database;
      const swept = await sweepWorkspaceReports(env, db, orgId, at, {
        limit: Math.min(SCHEDULES_PER_WORKSPACE, SCHEDULES_PER_TICK - (totals.sent + totals.failed + totals.disabled)),
      });
      totals.sent += swept.sent;
      totals.failed += swept.failed;
      totals.disabled += swept.disabled;
      return swept.next;
    },
  });
  if (result.due > 0 || result.failed > 0) {
    console.log(
      `[DeskReports] due=${result.due} processed=${result.processed} sent=${totals.sent} sendFailed=${totals.failed} disabled=${totals.disabled} workspaceFailures=${result.failed}`,
    );
  }
  return { ...result, sent: totals.sent, sendFailed: totals.failed, disabled: totals.disabled };
}
