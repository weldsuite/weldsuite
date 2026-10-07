/**
 * Workflow error log service — the Errors view of WeldConnect › Analytics.
 *
 * The workflow engine writes one `workflow_error_logs` row per failed step
 * (apps/workers/workflow-worker/src/engine/persistence.ts), for every run:
 * Test runs and CRM-sequence runs included. Like the other analytics figures
 * (`notTestRun` / `notSequenceRun` in workflow-executions.ts) this view leaves
 * both out — a Test run's failure is already on its own run page, and
 * sequences have their own screens.
 */

import { and, count, desc, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { SEQUENCE_WORKFLOW_TAG } from './weldconnect-mvp';

const { workflowErrorLogs, workflowExecutions, workflows } = schema;

/** The row is not about a CRM sequence (workflows tagged `__type:sequence`). */
const notSequenceError: SQL = sql`not exists (
  select 1 from ${workflows}
  where ${workflows.id} = ${workflowErrorLogs.workflowId}
    and coalesce(${workflows.tags}, '[]'::jsonb) ? ${SEQUENCE_WORKFLOW_TAG}
)`;

/** The row did not come from a run started with the editor's Test button. */
const notTestError: SQL = sql`not exists (
  select 1 from ${workflowExecutions}
  where ${workflowExecutions.id} = ${workflowErrorLogs.executionId}
    and coalesce(${workflowExecutions.executionContext}->>'isTest', 'false') = 'true'
)`;

export type ErrorAckStatus = 'all' | 'acknowledged' | 'unacknowledged';

export interface ListErrorLogsParams {
  workflowId?: string;
  status?: ErrorAckStatus;
  page?: number;
  limit?: number;
}

function visibleErrors(workflowId?: string): SQL[] {
  const conditions: SQL[] = [notSequenceError, notTestError];
  if (workflowId) conditions.push(eq(workflowErrorLogs.workflowId, workflowId));
  return conditions;
}

function ackCondition(status: ErrorAckStatus): SQL | undefined {
  if (status === 'unacknowledged') return isNull(workflowErrorLogs.acknowledgedAt);
  if (status === 'acknowledged') return sql`${workflowErrorLogs.acknowledgedAt} is not null`;
  return undefined;
}

/**
 * One page of error rows (newest first, with the workflow's current name) plus
 * the aggregates the view shows. `total`, `byType` and `byWorkflow` follow the
 * workflow + acknowledgement filters; `unacknowledged` ignores the latter, so
 * the badge stays the same whichever list the user is looking at.
 */
export async function listErrorLogs(db: Database, params: ListErrorLogsParams = {}) {
  const page = Math.max(1, params.page ?? 1);
  const limit = Math.min(Math.max(1, params.limit ?? 20), 100);
  const status = params.status ?? 'all';

  const base = visibleErrors(params.workflowId);
  const ack = ackCondition(status);
  const filtered = and(...base, ...(ack ? [ack] : []));

  const [items, totals, unacknowledged, byTypeRows, byWorkflowRows] = await Promise.all([
    db
      .select({ error: workflowErrorLogs, workflowName: workflows.name })
      .from(workflowErrorLogs)
      .leftJoin(workflows, eq(workflows.id, workflowErrorLogs.workflowId))
      .where(filtered)
      .orderBy(desc(workflowErrorLogs.occurredAt), desc(workflowErrorLogs.id))
      .limit(limit)
      .offset((page - 1) * limit),
    db.select({ value: count() }).from(workflowErrorLogs).where(filtered),
    db
      .select({ value: count() })
      .from(workflowErrorLogs)
      .where(and(...base, isNull(workflowErrorLogs.acknowledgedAt))),
    db
      .select({ errorType: workflowErrorLogs.errorType, value: count() })
      .from(workflowErrorLogs)
      .where(filtered)
      .groupBy(workflowErrorLogs.errorType),
    db
      .select({ workflowId: workflowErrorLogs.workflowId, workflowName: workflows.name, value: count() })
      .from(workflowErrorLogs)
      .leftJoin(workflows, eq(workflows.id, workflowErrorLogs.workflowId))
      .where(filtered)
      .groupBy(workflowErrorLogs.workflowId, workflows.name)
      .orderBy(desc(count()))
      .limit(10),
  ]);

  const byType: Record<string, number> = {};
  for (const row of byTypeRows) {
    const key = row.errorType || 'unknown';
    byType[key] = (byType[key] ?? 0) + Number(row.value);
  }

  return {
    total: Number(totals[0]?.value ?? 0),
    unacknowledged: Number(unacknowledged[0]?.value ?? 0),
    byType,
    byWorkflow: byWorkflowRows.map((row) => ({
      workflowId: row.workflowId,
      workflowName: row.workflowName,
      count: Number(row.value),
    })),
    items: items.map((row) => ({ ...row.error, workflowName: row.workflowName })),
    page,
    limit,
  };
}

/** Mark one error row acknowledged. Null when it doesn't exist. Re-acknowledging keeps the first stamp. */
export async function acknowledgeErrorLog(db: Database, id: string, userId: string) {
  const [existing] = await db.select().from(workflowErrorLogs).where(eq(workflowErrorLogs.id, id)).limit(1);
  if (!existing) return null;
  if (existing.acknowledgedAt) return existing;
  const [row] = await db
    .update(workflowErrorLogs)
    .set({ isAcknowledged: true, acknowledgedAt: new Date(), acknowledgedBy: userId })
    .where(eq(workflowErrorLogs.id, id))
    .returning();
  return row ?? null;
}

export type BulkAcknowledgeTarget = { ids: string[] } | { all: true; workflowId?: string };

/**
 * Acknowledge several rows at once: the given ids, or every unacknowledged row
 * the Errors view shows (optionally for one workflow). Returns how many rows
 * changed.
 */
export async function acknowledgeErrorLogs(db: Database, target: BulkAcknowledgeTarget, userId: string) {
  const conditions: SQL[] = [isNull(workflowErrorLogs.acknowledgedAt)];
  if ('ids' in target) {
    if (target.ids.length === 0) return 0;
    conditions.push(inArray(workflowErrorLogs.id, target.ids));
  } else {
    conditions.push(...visibleErrors(target.workflowId));
  }
  const rows = await db
    .update(workflowErrorLogs)
    .set({ isAcknowledged: true, acknowledgedAt: new Date(), acknowledgedBy: userId })
    .where(and(...conditions))
    .returning({ id: workflowErrorLogs.id });
  return rows.length;
}
