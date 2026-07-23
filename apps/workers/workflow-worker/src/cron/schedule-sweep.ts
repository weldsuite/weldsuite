/**
 * Workflow Schedule Sweep — Cloudflare Cron Handler (D1-indexed)
 *
 * Runs every minute (`* * * * *`) via a Cron Trigger on this worker. Instead of
 * fanning out to every workspace's Neon DB each tick (the old design, which kept
 * all tenant databases perpetually awake), the sweep polls a single always-on
 * **D1 schedule index** (`schedule-index.ts`): one cheap query returns the rows
 * that are due or need their next fire time (re)computed. A tenant DB is opened
 * only when a schedule actually fires — to mirror run stats into the UI-facing
 * `workflow_schedules` row — so idle workspaces' databases autosuspend normally.
 *
 * Cron math lives in `lib/cron.ts`. app-api keeps the index in sync on schedule
 * CRUD (see app-api `services/workflow-schedules.ts`).
 *
 * Split into: a `ScheduleIndexStore` port (D1 impl `d1ScheduleStore`, so the
 * fire logic is testable against a fake), the pure-ish orchestrator
 * `sweepDueSchedules`, and the env-wired `runWorkflowScheduleSweep`.
 */

import { eq } from 'drizzle-orm';
import { getTenantDbForWorkspace, schema } from '../db';
import type { WorkflowEnv } from '../engine/types';
import { computeNextRunAt } from '../lib/cron';
import type { ScheduleIndexRow } from '../schedule-index';

// Re-exported for back-compat / callers that want the matcher directly.
export { cronMatchesNow, cronMatchesAt, computeNextRunAt } from '../lib/cron';

const DOUBLE_FIRE_GUARD_MS = 55_000;

export interface ExecuteWorkflowBinding {
  create: (init: { params: Record<string, unknown> }) => Promise<unknown>;
}

/**
 * Storage port over the D1 index — abstracts the four writes the sweep needs so
 * `sweepDueSchedules` can be unit-tested against an in-memory fake.
 */
export interface ScheduleIndexStore {
  /** Enabled rows that are due now OR still need a next_run_at computed. */
  dueRows(now: number): Promise<ScheduleIndexRow[]>;
  /** Store a freshly-computed future next_run_at. */
  setNextRun(scheduleId: string, nextRunAt: number, now: number): Promise<void>;
  /** Turn a row off (no future occurrence / past endDate / bad expression). */
  disable(scheduleId: string, now: number): Promise<void>;
  /** Advance after a fire: set next_run_at + last_run_at (disable if none left). */
  markFired(scheduleId: string, nextRunAt: number | null, now: number): Promise<void>;
}

/** D1-backed implementation of the store port. */
export function d1ScheduleStore(d1: D1Database): ScheduleIndexStore {
  return {
    async dueRows(now: number): Promise<ScheduleIndexRow[]> {
      const res = await d1
        .prepare(
          `SELECT * FROM schedule_index
            WHERE is_enabled = 1 AND (next_run_at IS NULL OR next_run_at <= ?)
            ORDER BY next_run_at ASC`,
        )
        .bind(now)
        .all<ScheduleIndexRow>();
      return res.results ?? [];
    },
    async setNextRun(scheduleId, nextRunAt, now) {
      await d1
        .prepare(`UPDATE schedule_index SET next_run_at = ?, updated_at = ? WHERE schedule_id = ?`)
        .bind(nextRunAt, now, scheduleId)
        .run();
    },
    async disable(scheduleId, now) {
      await d1
        .prepare(`UPDATE schedule_index SET is_enabled = 0, next_run_at = NULL, updated_at = ? WHERE schedule_id = ?`)
        .bind(now, scheduleId)
        .run();
    },
    async markFired(scheduleId, nextRunAt, now) {
      await d1
        .prepare(
          `UPDATE schedule_index SET next_run_at = ?, last_run_at = ?, is_enabled = ?, updated_at = ? WHERE schedule_id = ?`,
        )
        .bind(nextRunAt, now, nextRunAt != null ? 1 : 0, now, scheduleId)
        .run();
    },
  };
}

function boundsOf(row: ScheduleIndexRow): { startDate: Date | null; endDate: Date | null } {
  return {
    startDate: row.start_date != null ? new Date(row.start_date) : null,
    endDate: row.end_date != null ? new Date(row.end_date) : null,
  };
}

/**
 * Core sweep: for each candidate row, either (a) compute+store its first/next
 * fire time if missing, or (b) fire it if due — advancing next_run_at BEFORE
 * dispatch so a dispatch failure never causes a refire next tick. `onFired`
 * mirrors the run into the tenant `workflow_schedules` row (opening that one
 * tenant DB); it is the only tenant I/O and is best-effort. Returns the number
 * of schedules successfully dispatched.
 */
export async function sweepDueSchedules(
  store: ScheduleIndexStore,
  executeWorkflow: ExecuteWorkflowBinding | undefined,
  onFired: (row: ScheduleIndexRow, ok: boolean, nextRunAt: number | null, now: number) => Promise<void>,
  now: number = Date.now(),
): Promise<number> {
  const rows = await store.dueRows(now);
  let dispatched = 0;

  for (const row of rows) {
    const bounds = boundsOf(row);

    // (a) Needs a fire time computed. computeNextRunAt always returns a moment
    // strictly in the future, so a freshly-computed row is never due this tick.
    if (row.next_run_at == null) {
      const next = computeNextRunAt(row.cron_expression, row.timezone, new Date(now), bounds);
      if (!next) await store.disable(row.schedule_id, now);
      else await store.setNextRun(row.schedule_id, next.getTime(), now);
      continue;
    }

    // (b) Due row — validate range + guard before firing.
    if (row.start_date != null && now < row.start_date) continue;
    if (row.end_date != null && now > row.end_date) {
      await store.disable(row.schedule_id, now);
      continue;
    }
    if (row.last_run_at != null && now - row.last_run_at < DOUBLE_FIRE_GUARD_MS) continue;

    if (!executeWorkflow) {
      console.warn(`[ScheduleSweep] EXECUTE_WORKFLOW binding unavailable, skipping schedule ${row.schedule_id}`);
      continue;
    }

    // Advance first, then dispatch.
    const next = computeNextRunAt(row.cron_expression, row.timezone, new Date(now), bounds);
    const nextMs = next ? next.getTime() : null;
    await store.markFired(row.schedule_id, nextMs, now);

    let ok = true;
    try {
      await executeWorkflow.create({
        params: {
          workspaceId: row.workspace_id,
          userId: 'system',
          workflowId: row.workflow_id,
          triggerId: row.trigger_id || undefined,
          triggerType: 'schedule',
          triggerData: {
            scheduleId: row.schedule_id,
            cronExpression: row.cron_expression,
          },
          source: row.source === 'helpdesk' ? 'helpdesk' : 'task',
        },
      });
      console.log(`[ScheduleSweep] Dispatched workflow ${row.workflow_id} for schedule ${row.schedule_id}`);
    } catch (err) {
      ok = false;
      console.error(`[ScheduleSweep] Failed to dispatch workflow ${row.workflow_id}:`, err);
    }

    try {
      await onFired(row, ok, nextMs, now);
    } catch (statErr) {
      console.warn(`[ScheduleSweep] Tenant stat update failed for ${row.schedule_id}:`, statErr);
    }

    if (ok) dispatched++;
  }

  return dispatched;
}

/**
 * Mirror a fired schedule's run into the UI-facing tenant `workflow_schedules`
 * row. Opens the workspace's tenant DB — deliberately the ONLY per-fire tenant
 * I/O, so databases with no firing schedule are never touched.
 */
async function writeTenantScheduleRun(
  env: WorkflowEnv,
  row: ScheduleIndexRow,
  ok: boolean,
  nextRunAt: number | null,
  now: number,
): Promise<void> {
  const db = await getTenantDbForWorkspace(env, row.workspace_id);
  const nextDate = nextRunAt != null ? new Date(nextRunAt) : null;

  if (ok) {
    const [existing] = await db
      .select({ totalRuns: schema.workflowSchedules.totalRuns })
      .from(schema.workflowSchedules)
      .where(eq(schema.workflowSchedules.id, row.schedule_id))
      .limit(1);
    await db
      .update(schema.workflowSchedules)
      .set({
        lastRunAt: new Date(now),
        nextRunAt: nextDate,
        totalRuns: (existing?.totalRuns ?? 0) + 1,
        updatedAt: new Date(now),
      })
      .where(eq(schema.workflowSchedules.id, row.schedule_id));
  } else {
    await db
      .update(schema.workflowSchedules)
      .set({
        lastRunAt: new Date(now),
        lastRunStatus: 'failed',
        nextRunAt: nextDate,
        updatedAt: new Date(now),
      })
      .where(eq(schema.workflowSchedules.id, row.schedule_id));
  }
}

/**
 * Entry point wired to the cron trigger. Polls the D1 index and fires due
 * schedules. No-ops (with a warning) if the D1 binding is missing.
 */
export async function runWorkflowScheduleSweep(env: WorkflowEnv, now: number = Date.now()): Promise<number> {
  const d1 = env.SCHEDULE_INDEX as D1Database | undefined;
  if (!d1) {
    console.warn('[ScheduleSweep] SCHEDULE_INDEX D1 binding not configured, skipping sweep');
    return 0;
  }

  const store = d1ScheduleStore(d1);
  const dispatched = await sweepDueSchedules(
    store,
    env.EXECUTE_WORKFLOW,
    (row, ok, nextRunAt, at) => writeTenantScheduleRun(env, row, ok, nextRunAt, at),
    now,
  );

  if (dispatched > 0) console.log(`[ScheduleSweep] Dispatched ${dispatched} workflow(s)`);
  return dispatched;
}
