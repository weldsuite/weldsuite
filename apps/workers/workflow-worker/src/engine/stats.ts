/**
 * Workflow execution statistics. Ported from api-worker `updateWorkflowStats`.
 */

import { and, desc, eq, isNotNull, sql } from 'drizzle-orm';
import { schema } from '../db';
import type { WorkflowDb } from './types';

/** How many of the latest timed runs the average covers. Bounds the query on busy workflows. */
export const AVERAGE_WINDOW = 500;

/**
 * Mean duration (ms) of the workflow's latest timed, non-test runs, rounded to
 * the column's two decimals; null when no run has a duration yet. Computed from
 * the execution rows rather than folded into the previous average, so it
 * cannot drift when runs are retried, deleted or predate duration tracking.
 */
async function recentAverageDuration(db: WorkflowDb, workflowId: string): Promise<string | null> {
  const runs = schema.workflowExecutions;
  const recent = db
    .select({ duration: runs.duration })
    .from(runs)
    .where(
      and(
        eq(runs.workflowId, workflowId),
        isNotNull(runs.duration),
        sql`coalesce(${runs.executionContext}->>'isTest', 'false') <> 'true'`,
      ),
    )
    .orderBy(desc(runs.startedAt))
    .limit(AVERAGE_WINDOW)
    .as('recent_runs');
  const [row] = await db.select({ avg: sql<string | null>`avg(${recent.duration})` }).from(recent);
  return row?.avg == null ? null : Number(row.avg).toFixed(2);
}

/**
 * Count a finished (non-test) run on its workflow and refresh the average run
 * time. Deliberately leaves `updatedAt` alone: the Workflows list shows it as
 * "Last modified", which must only move when the workflow is edited. Call it
 * after the run's own `duration` has been written.
 */
export async function updateWorkflowStats(
  db: WorkflowDb,
  workflowId: string,
  success: boolean,
  source?: 'weldconnect' | 'helpdesk',
): Promise<void> {
  const table = source === 'helpdesk' ? schema.helpdeskWorkflows : schema.workflows;
  const [workflow] = (await db.select().from(table).where(eq(table.id, workflowId)).limit(1)) as any[];
  if (!workflow) return;

  // Helpdesk runs are recorded in other tables; only WeldConnect gets an average.
  const averageExecutionTime = source === 'helpdesk' ? undefined : await recentAverageDuration(db, workflowId);

  await db
    .update(table)
    .set({
      executionCount: (workflow.executionCount || 0) + 1,
      successCount: success ? (workflow.successCount || 0) + 1 : workflow.successCount,
      failureCount: !success ? (workflow.failureCount || 0) + 1 : workflow.failureCount,
      lastExecutedAt: new Date(),
      ...(averageExecutionTime != null ? { averageExecutionTime } : {}),
    })
    .where(eq(table.id, workflowId));
}
