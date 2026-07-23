/**
 * Workflow executions service — list, fetch, steps, logs, trends, slow,
 * cancel, retry. Pure business logic; routes wire HTTP / permissions.
 */

import { and, desc, eq, gte, inArray, lt, lte, sql } from 'drizzle-orm';
import { schema, type Database } from '../db';

const { workflowExecutions, workflowExecutionSteps, workflows } = schema;

export interface ListExecutionsParams {
  workflowId?: string;
  status?: string;
  triggerType?: string;
  startDate?: string;
  endDate?: string;
  cursor?: string;
  limit?: number;
}

export interface ListResult<T> {
  data: T[];
  totalCount: number;
  hasMore: boolean;
  cursor: string | null;
}

export async function listExecutions(
  db: Database,
  params: ListExecutionsParams,
): Promise<ListResult<typeof workflowExecutions.$inferSelect>> {
  const limit = Math.min(params.limit ?? 25, 100);

  const filterConditions: any[] = [];
  if (params.workflowId) filterConditions.push(eq(workflowExecutions.workflowId, params.workflowId));
  if (params.status) filterConditions.push(eq(workflowExecutions.status, params.status));
  if (params.triggerType) filterConditions.push(eq(workflowExecutions.triggerType, params.triggerType));
  if (params.startDate) filterConditions.push(gte(workflowExecutions.startedAt, new Date(params.startDate)));
  if (params.endDate) filterConditions.push(lte(workflowExecutions.startedAt, new Date(params.endDate)));

  const conditions = [...filterConditions];
  if (params.cursor) conditions.push(lt(workflowExecutions.id, params.cursor));

  const [rows, countRes] = await Promise.all([
    db
      .select()
      .from(workflowExecutions)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(desc(workflowExecutions.startedAt), desc(workflowExecutions.id))
      .limit(limit + 1),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(workflowExecutions)
      .where(filterConditions.length ? and(...filterConditions) : undefined),
  ]);

  const hasMore = rows.length > limit;
  const data = hasMore ? rows.slice(0, limit) : rows;
  const cursor = hasMore && data.length > 0 ? data[data.length - 1].id : null;

  return { data, totalCount: Number(countRes[0]?.count ?? 0), hasMore, cursor };
}

export async function getExecution(db: Database, id: string) {
  const [row] = await db.select().from(workflowExecutions).where(eq(workflowExecutions.id, id)).limit(1);
  return row ?? null;
}

export async function getExecutionSteps(db: Database, executionId: string) {
  return db
    .select()
    .from(workflowExecutionSteps)
    .where(eq(workflowExecutionSteps.executionId, executionId))
    .orderBy(workflowExecutionSteps.stepIndex);
}

export async function getExecutionLogs(db: Database, executionId: string) {
  const steps = await db
    .select()
    .from(workflowExecutionSteps)
    .where(eq(workflowExecutionSteps.executionId, executionId))
    .orderBy(workflowExecutionSteps.stepIndex);

  const logs: Array<{ timestamp: string; level: string; message: string; stepId?: string; stepName?: string }> = [];
  for (const step of steps) {
    const stepLogs = step.logs as Array<{ timestamp: string; level: string; message: string }> | null | undefined;
    if (Array.isArray(stepLogs)) {
      for (const log of stepLogs) logs.push({ ...log, stepId: step.stepId, stepName: step.stepName ?? undefined });
    }
  }
  logs.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
  return logs;
}

export async function getRecentExecutions(db: Database, limit = 10) {
  return db
    .select()
    .from(workflowExecutions)
    .orderBy(desc(workflowExecutions.startedAt))
    .limit(Math.min(limit, 100));
}

function getStartDate(period: string): Date {
  const now = new Date();
  switch (period) {
    case 'day': return new Date(now.getTime() - 24 * 60 * 60 * 1000);
    case 'month': return new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    case 'week':
    default: return new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  }
}

export async function getExecutionTrends(db: Database, period = 'week') {
  const rows = await db
    .select({ status: workflowExecutions.status, startedAt: workflowExecutions.startedAt })
    .from(workflowExecutions)
    .where(gte(workflowExecutions.startedAt, getStartDate(period)));

  const trends: Record<string, { total: number; success: number; failure: number }> = {};
  for (const exec of rows) {
    if (!exec.startedAt) continue;
    const date = exec.startedAt.toISOString().split('T')[0];
    if (!trends[date]) trends[date] = { total: 0, success: 0, failure: 0 };
    trends[date].total++;
    if (exec.status === 'completed') trends[date].success++;
    else if (exec.status === 'failed') trends[date].failure++;
  }
  return Object.entries(trends)
    .map(([date, stats]) => ({ date, ...stats }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

export async function getSlowExecutions(db: Database, limit = 10) {
  return db
    .select()
    .from(workflowExecutions)
    .where(and(eq(workflowExecutions.status, 'completed'), sql`${workflowExecutions.duration} IS NOT NULL`))
    .orderBy(desc(workflowExecutions.duration))
    .limit(Math.min(limit, 50));
}

/**
 * Cancel a queued/running execution. If a CF Workflow instance is attached,
 * abort it via the EXECUTE_WORKFLOW binding before flipping the DB row.
 */
export async function cancelExecution(
  db: Database,
  id: string,
  executeWorkflow?: Workflow,
) {
  const [execution] = await db.select().from(workflowExecutions).where(eq(workflowExecutions.id, id)).limit(1);
  if (!execution) return null;

  if (execution.cfWorkflowInstanceId && executeWorkflow) {
    try {
      const instance = await executeWorkflow.get(execution.cfWorkflowInstanceId);
      // `abort()` exists at runtime on WorkflowInstance but isn't always in
      // the workers-types ambient definition; cast to any to bypass the gap.
      await (instance as any).abort();
    } catch (err) {
      console.warn('[app-api/workflow-executions] abort failed:', err);
    }
  }

  await db
    .update(workflowExecutions)
    .set({ status: 'cancelled', completedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(workflowExecutions.id, id), inArray(workflowExecutions.status, ['queued', 'running'])));

  return { id, status: 'cancelled' as const };
}

/**
 * Retry a failed execution by spawning a new CF Workflow instance with the
 * same trigger payload. Returns null if not found, 'not_failed' if status
 * isn't 'failed', 'workflow_missing' if the parent workflow was deleted.
 */
export async function retryExecution(
  db: Database,
  id: string,
  workspaceId: string,
  userId: string,
  executeWorkflow: Workflow,
): Promise<
  | { kind: 'ok'; id: string; instanceId: string; retryOf: string }
  | { kind: 'not_found' }
  | { kind: 'not_failed' }
  | { kind: 'workflow_missing'; workflowId: string }
> {
  const [original] = await db.select().from(workflowExecutions).where(eq(workflowExecutions.id, id)).limit(1);
  if (!original) return { kind: 'not_found' };
  if (original.status !== 'failed') return { kind: 'not_failed' };

  const [workflow] = await db.select().from(workflows).where(eq(workflows.id, original.workflowId)).limit(1);
  if (!workflow) return { kind: 'workflow_missing', workflowId: original.workflowId };

  const source = original.workflowId.startsWith('hwf_') ? 'helpdesk' : 'task';
  const instance = await executeWorkflow.create({
    params: {
      workspaceId,
      userId,
      workflowId: original.workflowId,
      triggerType: (original.triggerType ?? 'manual') as any,
      triggerData: (original.triggerData ?? {}) as Record<string, unknown>,
      source,
    },
  });

  return { kind: 'ok', id: instance.id, instanceId: instance.id, retryOf: id };
}
