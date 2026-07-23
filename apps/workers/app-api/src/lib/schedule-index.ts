/**
 * D1 schedule-index sync (app-api side).
 *
 * The schedule sweep in `apps/workers/workflow-worker` polls a D1 table
 * (`schedule_index`) instead of fanning out to every tenant DB. app-api owns the
 * write side: on schedule create/update/toggle/delete we upsert or remove the
 * matching index row so the sweep sees current timing.
 *
 * We only ever write `next_run_at = NULL` here — the worker computes the actual
 * fire time (cron math lives there, `workflow-worker/src/lib/cron.ts`). Keep the
 * SQL in lockstep with `workflow-worker/src/schedule-index.ts` (deliberate copy,
 * same as the manifest copies noted in CLAUDE.md — two workers, no shared pkg).
 *
 * All calls are best-effort: a D1 hiccup logs and returns rather than failing
 * the user's save. A stale index self-heals via the worker's
 * `POST /internal/schedule-index/rebuild` backfill.
 */

export interface ScheduleIndexSync {
  d1?: D1Database;
  workspaceId?: string;
}

export interface UpsertScheduleIndexInput {
  scheduleId: string;
  workspaceId: string;
  workflowId: string;
  triggerId?: string | null;
  cronExpression: string;
  timezone?: string | null;
  startDate?: Date | null;
  endDate?: Date | null;
  isEnabled: boolean;
}

function sourceForWorkflowId(workflowId: string): 'task' | 'helpdesk' {
  return workflowId.startsWith('hwf_') ? 'helpdesk' : 'task';
}

/** Upsert a schedule into the D1 index, resetting next_run_at for recompute. */
export async function syncUpsertScheduleIndex(
  sync: ScheduleIndexSync | undefined,
  input: UpsertScheduleIndexInput,
): Promise<void> {
  if (!sync?.d1 || !input.workspaceId) return;
  try {
    const now = Date.now();
    await sync.d1
      .prepare(
        `INSERT INTO schedule_index
           (schedule_id, workspace_id, workflow_id, trigger_id, cron_expression, timezone,
            start_date, end_date, next_run_at, last_run_at, source, is_enabled, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?)
         ON CONFLICT(schedule_id) DO UPDATE SET
           workspace_id    = excluded.workspace_id,
           workflow_id     = excluded.workflow_id,
           trigger_id      = excluded.trigger_id,
           cron_expression = excluded.cron_expression,
           timezone        = excluded.timezone,
           start_date      = excluded.start_date,
           end_date        = excluded.end_date,
           next_run_at     = NULL,
           source          = excluded.source,
           is_enabled      = excluded.is_enabled,
           updated_at      = excluded.updated_at`,
      )
      .bind(
        input.scheduleId,
        input.workspaceId,
        input.workflowId,
        input.triggerId ?? null,
        input.cronExpression,
        input.timezone || 'UTC',
        input.startDate ? input.startDate.getTime() : null,
        input.endDate ? input.endDate.getTime() : null,
        sourceForWorkflowId(input.workflowId),
        input.isEnabled ? 1 : 0,
        now,
      )
      .run();
  } catch (err) {
    console.warn(`[schedule-index] upsert failed for ${input.scheduleId}:`, err);
  }
}

/** Remove a schedule from the D1 index (on delete). */
export async function syncRemoveScheduleIndex(
  sync: ScheduleIndexSync | undefined,
  scheduleId: string,
): Promise<void> {
  if (!sync?.d1) return;
  try {
    await sync.d1.prepare(`DELETE FROM schedule_index WHERE schedule_id = ?`).bind(scheduleId).run();
  } catch (err) {
    console.warn(`[schedule-index] remove failed for ${scheduleId}:`, err);
  }
}

/** Timing-relevant fields — a schedule update only needs an index sync if one changed. */
export function updateTouchesTiming(data: Record<string, unknown>): boolean {
  return (
    'cronExpression' in data ||
    'timezone' in data ||
    'startDate' in data ||
    'endDate' in data ||
    'isEnabled' in data
  );
}
