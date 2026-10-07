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
 * Cron math lives in `@weldsuite/workflow-integrations/cron`. app-api keeps the index in sync on schedule
 * CRUD (see app-api `services/workflow-schedules.ts`).
 *
 * Split into: a `ScheduleIndexStore` port (D1 impl `d1ScheduleStore`, so the
 * fire logic is testable against a fake), the pure-ish orchestrator
 * `sweepDueSchedules`, and the env-wired `runWorkflowScheduleSweep`.
 */

import { eq } from 'drizzle-orm';
import { getTenantDbForWorkspace, schema } from '../db';
import type { WorkflowEnv } from '../engine/types';
import { computeNextRunAt } from '@weldsuite/workflow-integrations/cron';
import { insertSkippedWorkflowExecution, isAtWorkflowConcurrencyLimit } from '@weldsuite/db/lib/workflow-concurrency';
import type { ScheduleIndexRow } from '../schedule-index';
import { scheduledSlot } from '../engine/trigger-data';

// Re-exported for back-compat / callers that want the matcher directly.
export { cronMatchesNow, cronMatchesAt, computeNextRunAt } from '@weldsuite/workflow-integrations/cron';

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

type OnFired = (row: ScheduleIndexRow, ok: boolean, nextRunAt: number | null, now: number) => Promise<void>;

/**
 * Gate a due row against its workflow's `settings.maxConcurrentRuns` before
 * dispatch. Returning `allowed: false` means the implementation already
 * recorded a `skipped` execution (best-effort) — the sweep still advances the
 * row's timing as if it had fired, so a workflow stuck at its limit doesn't
 * pile up catch-up dispatches. Defaults to always-allowed (no tenant I/O),
 * which is what every existing caller/test gets unless it opts in.
 */
export type CheckConcurrency = (row: ScheduleIndexRow, now: number) => Promise<{ allowed: boolean }>;
const ALWAYS_ALLOWED: CheckConcurrency = async () => ({ allowed: true });

/**
 * The row's one and only occurrence (its `execute_at`), used ONLY to
 * materialize a freshly-created one-time row's first `next_run_at`. No
 * `execute_at` (malformed data) means no occurrence, same as
 * `computeNextRunAt` returning null for a bad cron.
 */
function oneTimeNextRun(row: ScheduleIndexRow): Date | null {
  return row.execute_at != null ? new Date(row.execute_at) : null;
}

/** (a) Compute + store a row's first/next fire time (or disable it if none). */
async function computeMissingNextRun(store: ScheduleIndexStore, row: ScheduleIndexRow, now: number): Promise<void> {
  const next =
    row.schedule_type === 'one_time'
      ? oneTimeNextRun(row)
      : computeNextRunAt(row.cron_expression, row.timezone, new Date(now), boundsOf(row));
  if (!next) await store.disable(row.schedule_id, now);
  else await store.setNextRun(row.schedule_id, next.getTime(), now);
}

/**
 * (b) Validate a due row's range + double-fire guard. Returns true when the
 * row may fire; disables rows past their end date.
 */
async function isReadyToFire(store: ScheduleIndexStore, row: ScheduleIndexRow, now: number): Promise<boolean> {
  if (row.start_date != null && now < row.start_date) return false;
  if (row.end_date != null && now > row.end_date) {
    await store.disable(row.schedule_id, now);
    return false;
  }
  return !(row.last_run_at != null && now - row.last_run_at < DOUBLE_FIRE_GUARD_MS);
}

/** Dispatch the workflow for a schedule row. Returns whether it succeeded. */
async function dispatchScheduledWorkflow(
  executeWorkflow: ExecuteWorkflowBinding,
  row: ScheduleIndexRow,
  slotMs: number | null,
): Promise<boolean> {
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
          // The slot this run is for (the row's due time, floored to the minute),
          // not the moment the sweep got to it; `scheduledTimeLocal` is built
          // from it in the schedule's timezone (engine/trigger-data.ts).
          scheduledTime: scheduledSlot(slotMs, new Date()).toISOString(),
          timezone: row.timezone,
        },
        source: row.source === 'helpdesk' ? 'helpdesk' : 'weldconnect',
      },
    });
    console.log(`[ScheduleSweep] Dispatched workflow ${row.workflow_id} for schedule ${row.schedule_id}`);
    return true;
  } catch (err) {
    console.error(`[ScheduleSweep] Failed to dispatch workflow ${row.workflow_id}:`, err);
    return false;
  }
}

/**
 * Fire one due row: advance next_run_at first, then dispatch, then mirror the
 * run into the tenant row (best-effort). Returns whether dispatch succeeded.
 */
async function fireScheduleRow(
  store: ScheduleIndexStore,
  executeWorkflow: ExecuteWorkflowBinding,
  checkConcurrency: CheckConcurrency,
  onFired: OnFired,
  row: ScheduleIndexRow,
  now: number,
): Promise<boolean> {
  // The slot being fired, read before the index row is advanced past it.
  const slotMs = row.next_run_at;
  // Advance first, then dispatch. A one-time schedule has exactly one
  // occurrence — it never gets a next one, however this fire turns out.
  const next =
    row.schedule_type === 'one_time'
      ? null
      : computeNextRunAt(row.cron_expression, row.timezone, new Date(now), boundsOf(row));
  const nextMs = next ? next.getTime() : null;
  await store.markFired(row.schedule_id, nextMs, now);

  // The concurrency gate runs AFTER next_run_at is advanced: a workflow stuck
  // at its limit still keeps its normal cadence (recurring) or is still
  // marked done (one-time) instead of being retried every tick.
  const { allowed } = await checkConcurrency(row, now);
  const ok = allowed && (await dispatchScheduledWorkflow(executeWorkflow, row, slotMs));

  try {
    await onFired(row, ok, nextMs, now);
  } catch (statErr) {
    console.warn(`[ScheduleSweep] Tenant stat update failed for ${row.schedule_id}:`, statErr);
  }

  return ok;
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
  onFired: OnFired,
  now: number = Date.now(),
  checkConcurrency: CheckConcurrency = ALWAYS_ALLOWED,
): Promise<number> {
  const rows = await store.dueRows(now);
  let dispatched = 0;

  for (const row of rows) {
    // (a) Needs a fire time computed. A freshly-computed row is never due this
    // tick: computeNextRunAt always returns a moment strictly in the future,
    // and a one-time row's single occurrence is only "due" once this branch
    // has stored it as next_run_at (it may already be in the past — a
    // best-effort catch-up if the sweep missed its minute).
    if (row.next_run_at == null) {
      await computeMissingNextRun(store, row, now);
      continue;
    }

    // (b) Due row — validate range + guard before firing.
    if (!(await isReadyToFire(store, row, now))) continue;

    if (!executeWorkflow) {
      console.warn(`[ScheduleSweep] EXECUTE_WORKFLOW binding unavailable, skipping schedule ${row.schedule_id}`);
      continue;
    }

    if (await fireScheduleRow(store, executeWorkflow, checkConcurrency, onFired, row, now)) dispatched++;
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
  // A one-time schedule has no next occurrence either way (ok or not — the D1
  // index already disabled it for good in fireScheduleRow) — reflect that on
  // the UI-facing tenant row too, so it reads "done" rather than "enabled"
  // with a next run that will never come.
  const doneForever = row.schedule_type === 'one_time';

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
        lastRunStatus: 'completed',
        nextRunAt: nextDate,
        ...(doneForever ? { isEnabled: false } : {}),
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
        ...(doneForever ? { isEnabled: false } : {}),
        updatedAt: new Date(now),
      })
      .where(eq(schema.workflowSchedules.id, row.schedule_id));
  }
}

/**
 * Entry point wired to the cron trigger. Polls the D1 index and fires due
 * schedules. No-ops (with a warning) if the D1 binding is missing.
 */
/**
 * Real `CheckConcurrency`: opens the row's tenant DB (the same one `onFired`
 * is about to open anyway), reads the workflow's `settings.maxConcurrentRuns`,
 * and — when already at the limit — records a `skipped` execution instead of
 * dispatching. Any failure to even check is treated as allowed (fail open: a
 * schedule miss is worse than an occasional over-run).
 */
async function checkScheduleConcurrency(env: WorkflowEnv, row: ScheduleIndexRow, now: number): Promise<{ allowed: boolean }> {
  try {
    const db = await getTenantDbForWorkspace(env, row.workspace_id);
    const [workflow] = await db
      .select({ name: schema.workflows.name, version: schema.workflows.version, settings: schema.workflows.settings })
      .from(schema.workflows)
      .where(eq(schema.workflows.id, row.workflow_id))
      .limit(1);
    if (!workflow) return { allowed: true };

    if (!(await isAtWorkflowConcurrencyLimit(db, row.workflow_id, workflow.settings))) return { allowed: true };

    await insertSkippedWorkflowExecution(db, {
      workflowId: row.workflow_id,
      workflowVersion: workflow.version,
      workflowName: workflow.name,
      triggerType: 'schedule',
      triggerId: row.trigger_id,
      triggerData: {
        scheduleId: row.schedule_id,
        scheduledTime: scheduledSlot(row.next_run_at, new Date(now)).toISOString(),
      },
      reason: 'concurrency_limit',
      message: `Skipped: "${workflow.name}" is already at its concurrent run limit.`,
    });
    return { allowed: false };
  } catch (err) {
    console.warn(`[ScheduleSweep] Concurrency check failed for schedule ${row.schedule_id}, allowing:`, err);
    return { allowed: true };
  }
}

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
    (row, at) => checkScheduleConcurrency(env, row, at),
  );

  if (dispatched > 0) console.log(`[ScheduleSweep] Dispatched ${dispatched} workflow(s)`);
  return dispatched;
}
