/**
 * D1-backed schedule index — the always-on timing layer for WeldConnect
 * scheduled triggers.
 *
 * Replaces the old per-minute fan-out that opened EVERY tenant Neon DB each tick
 * (which kept all databases perpetually awake). The sweep now polls this single
 * D1 table; a tenant DB is opened only when one of its schedules is actually due
 * to fire. app-api keeps rows in sync on schedule create/update/toggle/delete
 * (see app-api `services/workflow-schedules.ts`), writing `next_run_at = NULL`
 * to signal "recompute" whenever a timing-relevant field changes. Cron math
 * lives only in this worker (`lib/cron.ts`).
 *
 * The tenant `workflow_schedules` row stays the source of truth for config and
 * run stats; this index is the source of truth for *when to fire*.
 */

import { and, eq, isNull } from 'drizzle-orm';
import { getMasterDb, getTenantDbForWorkspace, schema, masterSchema } from './db';
import type { WorkflowEnv } from './engine/types';

/** One row of the `schedule_index` D1 table (SQLite: booleans/timestamps as INTEGER). */
export interface ScheduleIndexRow {
  schedule_id: string;
  workspace_id: string;
  workflow_id: string;
  trigger_id: string | null;
  cron_expression: string;
  timezone: string;
  start_date: number | null;
  end_date: number | null;
  next_run_at: number | null;
  last_run_at: number | null;
  source: string;
  is_enabled: number;
  updated_at: number;
}

export interface UpsertScheduleInput {
  scheduleId: string;
  workspaceId: string;
  workflowId: string;
  triggerId?: string | null;
  cronExpression: string;
  timezone?: string | null;
  startDate?: number | null;
  endDate?: number | null;
  source?: 'task' | 'helpdesk';
  isEnabled: boolean;
}

/** `task` unless the workflow id carries the helpdesk (`hwf_`) prefix. */
export function sourceForWorkflowId(workflowId: string): 'task' | 'helpdesk' {
  return workflowId.startsWith('hwf_') ? 'helpdesk' : 'task';
}

/**
 * Insert or replace a schedule row, resetting `next_run_at` to NULL so the next
 * sweep tick recomputes the fire time from the current cron/timezone/dates.
 * Idempotent; safe to call on every timing-relevant CRUD change.
 */
export async function upsertScheduleIndex(
  d1: D1Database,
  input: UpsertScheduleInput,
  now: number = Date.now(),
): Promise<void> {
  await d1
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
      input.startDate ?? null,
      input.endDate ?? null,
      input.source || sourceForWorkflowId(input.workflowId),
      input.isEnabled ? 1 : 0,
      now,
    )
    .run();
}

/** Remove a schedule from the index (on hard/soft delete of the schedule). */
export async function removeScheduleIndex(d1: D1Database, scheduleId: string): Promise<void> {
  await d1.prepare(`DELETE FROM schedule_index WHERE schedule_id = ?`).bind(scheduleId).run();
}

/**
 * One-time / manual backfill: fan out across every active workspace's tenant DB,
 * read enabled `workflow_schedules`, and upsert them into the index. This is the
 * ONLY code path that still fans out across all tenants — invoke it once after
 * deploy (via the worker's `POST /internal/schedule-index/rebuild` endpoint),
 * not on a timer. Returns the number of schedules indexed.
 */
export async function rebuildScheduleIndex(env: WorkflowEnv): Promise<number> {
  const d1 = env.SCHEDULE_INDEX as D1Database | undefined;
  if (!d1) throw new Error('SCHEDULE_INDEX D1 binding not configured');
  if (!env.DATABASE_URL_MASTER) throw new Error('DATABASE_URL_MASTER not configured');

  const masterDb = getMasterDb(env);
  const workspaces = await masterDb
    .select({ clerkOrgId: masterSchema.workspaces.clerkOrgId })
    .from(masterSchema.workspaces)
    .where(eq(masterSchema.workspaces.isActive, true));

  let indexed = 0;
  for (const ws of workspaces) {
    if (!ws.clerkOrgId) continue;
    try {
      const db = await getTenantDbForWorkspace(env, ws.clerkOrgId);
      const rows = await db
        .select()
        .from(schema.workflowSchedules)
        .where(and(eq(schema.workflowSchedules.isEnabled, true), isNull(schema.workflowSchedules.deletedAt)));

      for (const s of rows) {
        await upsertScheduleIndex(d1, {
          scheduleId: s.id,
          workspaceId: ws.clerkOrgId,
          workflowId: s.workflowId,
          triggerId: s.triggerId,
          cronExpression: s.cronExpression,
          timezone: s.timezone,
          startDate: s.startDate ? s.startDate.getTime() : null,
          endDate: s.endDate ? s.endDate.getTime() : null,
          source: sourceForWorkflowId(s.workflowId),
          isEnabled: s.isEnabled,
        });
        indexed++;
      }
    } catch (err) {
      console.warn(`[ScheduleIndex] rebuild: workspace ${ws.clerkOrgId} failed:`, err);
    }
  }

  console.log(`[ScheduleIndex] rebuild indexed ${indexed} schedule(s)`);
  return indexed;
}
