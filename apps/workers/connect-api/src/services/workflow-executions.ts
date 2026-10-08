/**
 * Workflow executions service — list, fetch, steps, logs, trends, slow,
 * cancel, retry. Pure business logic; routes wire HTTP / permissions.
 */

import { and, desc, eq, gte, inArray, isNull, lt, lte, sql, type SQL } from 'drizzle-orm';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import { insertSkippedWorkflowExecution, isAtWorkflowConcurrencyLimit } from '@weldsuite/db/lib/workflow-concurrency';
import { SEQUENCE_WORKFLOW_TAG } from './weldconnect-mvp';

const { workflowExecutions, workflowExecutionSteps, workflows } = schema;

/**
 * Runs of CRM sequences (workflows tagged `__type:sequence`) share the
 * `workflow_executions` table but are not WeldConnect runs: they have their own
 * enrollment screens, and the workflows list already hides the workflows
 * themselves. WeldConnect lists, trends and stats leave them out.
 */
export const notSequenceRun: SQL = sql`not exists (
  select 1 from ${workflows}
  where ${workflows.id} = ${workflowExecutions.workflowId}
    and coalesce(${workflows.tags}, '[]'::jsonb) ? ${SEQUENCE_WORKFLOW_TAG}
)`;

/** Runs started from the editor's Test button stay out of analytics (they still show in the runs list). */
export const notTestRun: SQL = sql`coalesce(${workflowExecutions.executionContext}->>'isTest', 'false') <> 'true'`;

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
  // An explicit workflowId is the one way to read a sequence's runs.
  if (params.workflowId) filterConditions.push(eq(workflowExecutions.workflowId, params.workflowId));
  else filterConditions.push(notSequenceRun);
  // Comma-separated list (`running,queued`); unknown values simply match nothing.
  const statuses = (params.status ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (statuses.length === 1) filterConditions.push(eq(workflowExecutions.status, statuses[0]));
  else if (statuses.length > 1) filterConditions.push(inArray(workflowExecutions.status, statuses));
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

export function getExecutionSteps(db: Database, executionId: string) {
  return Promise.resolve(
    db
      .select()
      .from(workflowExecutionSteps)
      .where(eq(workflowExecutionSteps.executionId, executionId))
      .orderBy(workflowExecutionSteps.stepIndex),
  );
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

export function getRecentExecutions(db: Database, limit = 10) {
  return Promise.resolve(
    db
      .select()
      .from(workflowExecutions)
      .where(notSequenceRun)
      .orderBy(desc(workflowExecutions.startedAt))
      .limit(Math.min(limit, 100)),
  );
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function getStartDate(period: string, now: Date = new Date()): Date {
  switch (period) {
    case 'day': return new Date(now.getTime() - DAY_MS);
    case 'month': return new Date(now.getTime() - 30 * DAY_MS);
    case 'year': return new Date(now.getTime() - 365 * DAY_MS);
    case 'week':
    default: return new Date(now.getTime() - 7 * DAY_MS);
  }
}

/** Trend bucket key: the UTC day, or for `year` the first of the UTC month (`YYYY-MM-01`). */
export function trendBucket(period: string, at: Date): string {
  const day = at.toISOString().split('T')[0];
  return period === 'year' ? `${day.slice(0, 7)}-01` : day;
}

export async function getExecutionTrends(db: Database, period = 'week') {
  const rows = await db
    .select({ status: workflowExecutions.status, startedAt: workflowExecutions.startedAt })
    .from(workflowExecutions)
    .where(and(gte(workflowExecutions.startedAt, getStartDate(period)), notSequenceRun, notTestRun));

  const trends: Record<string, { total: number; success: number; failure: number }> = {};
  for (const exec of rows) {
    if (!exec.startedAt) continue;
    const date = trendBucket(period, exec.startedAt);
    if (!trends[date]) trends[date] = { total: 0, success: 0, failure: 0 };
    trends[date].total++;
    if (exec.status === 'completed') trends[date].success++;
    else if (exec.status === 'failed') trends[date].failure++;
  }
  return Object.entries(trends)
    .map(([date, stats]) => ({ date, ...stats }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

export function getSlowExecutions(db: Database, limit = 10) {
  return Promise.resolve(
    db
      .select()
      .from(workflowExecutions)
      .where(
        and(
          eq(workflowExecutions.status, 'completed'),
          sql`${workflowExecutions.duration} IS NOT NULL`,
          notSequenceRun,
          notTestRun,
        ),
      )
      .orderBy(desc(workflowExecutions.duration))
      .limit(Math.min(limit, 50)),
  );
}

/** Statuses a run can still be cancelled from. */
const CANCELLABLE_STATUSES = ['queued', 'pending', 'running', 'waiting_for_input'];

export type CancelExecutionResult =
  | { kind: 'cancelled'; id: string; workflowId: string; status: 'cancelled' }
  | { kind: 'not_found' }
  | { kind: 'not_cancellable'; status: string };

/**
 * Cancel a queued, running or waiting execution. The row is flipped first so
 * the worker's finalize step (which never overwrites `cancelled`) cannot race
 * it, then the Cloudflare Workflow instance is terminated so no further step
 * runs. A failed terminate is logged, not surfaced: the instance may already
 * have finished, and the row is cancelled either way.
 */
export async function cancelExecution(
  db: Database,
  id: string,
  executeWorkflow?: Workflow,
): Promise<CancelExecutionResult> {
  const [execution] = await db.select().from(workflowExecutions).where(eq(workflowExecutions.id, id)).limit(1);
  if (!execution) return { kind: 'not_found' };
  if (!CANCELLABLE_STATUSES.includes(execution.status)) {
    return { kind: 'not_cancellable', status: execution.status };
  }

  const now = new Date();
  await db
    .update(workflowExecutions)
    .set({ status: 'cancelled', completedAt: now, updatedAt: now })
    .where(and(eq(workflowExecutions.id, id), inArray(workflowExecutions.status, CANCELLABLE_STATUSES)));

  if (execution.cfWorkflowInstanceId && executeWorkflow) {
    try {
      const instance = await executeWorkflow.get(execution.cfWorkflowInstanceId);
      await instance.terminate();
    } catch (err) {
      console.warn('[connect-api/workflow-executions] terminate failed:', err);
    }
  }

  return { kind: 'cancelled', id, workflowId: execution.workflowId, status: 'cancelled' };
}

type WorkflowRow = typeof workflows.$inferSelect;

export interface StartRunInput {
  workspaceId: string;
  /** Who is starting the run (stored as `triggeredBy`). */
  userId: string;
  workflow: WorkflowRow;
  triggerType: string;
  triggerId?: string | null;
  triggerData: Record<string, unknown>;
  isTest?: boolean;
  /** Retry lineage: the failed run this one repeats. */
  parent?: { id: string; retryCount: number };
}

/**
 * Either a normal start (`skipped: false`, a real CF Workflow instance) or a
 * run that never started because the workflow was already at its
 * `settings.maxConcurrentRuns` limit (`skipped: true` — a `skipped`
 * `workflow_executions` row was inserted instead, no CF Workflow instance).
 */
export type StartRunResult =
  | { skipped: false; executionId: string; instanceId: string }
  | { skipped: true; executionId: string; instanceId: null };

/**
 * Start a run with a real execution id up front. The `workflow_executions` row
 * is inserted here as `queued` (with a pre-generated `wex_` id), then the
 * Cloudflare Workflow is started with that id in its params and upgrades the
 * row when it begins, so callers can navigate to the run straight away. (The
 * Cloudflare instance id is a different thing and not a valid execution id.)
 * When the workflow cannot be started the row is marked failed rather than
 * left queued.
 *
 * Covers every non-schedule dispatcher: manual trigger, retry, Test run, and
 * the public webhook receiver all call this. Test runs (`isTest`) are exempt
 * from the concurrency check — same exemption as the "workflow must be
 * active" gate, and for the same reason: trying out a workflow in the editor
 * should never be blocked by its own in-flight runs.
 */
export async function startRun(
  db: Database,
  executeWorkflow: Workflow,
  input: StartRunInput,
): Promise<StartRunResult> {
  if (!input.isTest && (await isAtWorkflowConcurrencyLimit(db, input.workflow.id, input.workflow.settings))) {
    const executionId = await insertSkippedWorkflowExecution(db, {
      workflowId: input.workflow.id,
      workflowVersion: input.workflow.version,
      workflowName: input.workflow.name,
      triggeredBy: input.userId,
      triggerType: input.triggerType,
      triggerId: input.triggerId,
      triggerData: input.triggerData,
      reason: 'concurrency_limit',
      message: `Skipped: "${input.workflow.name}" is already at its concurrent run limit.`,
    });
    return { skipped: true, executionId, instanceId: null };
  }

  const executionId = generateId('wex');
  const now = new Date();
  const steps = Array.isArray(input.workflow.steps) ? input.workflow.steps.length : 0;

  await db.insert(workflowExecutions).values({
    id: executionId,
    workflowId: input.workflow.id,
    workflowVersion: input.workflow.version,
    workflowName: input.workflow.name,
    status: 'queued',
    triggeredBy: input.userId,
    triggerType: input.triggerType,
    triggerId: input.triggerId ?? null,
    triggerData: input.triggerData,
    // Set now so the list orders the new run correctly while it waits; the
    // worker restarts the clock when it picks the run up.
    startedAt: now,
    totalSteps: steps,
    currentStepIndex: 0,
    parentExecutionId: input.parent?.id ?? null,
    retryCount: input.parent ? input.parent.retryCount + 1 : 0,
    executionContext: input.isTest ? { isTest: true } : null,
    createdAt: now,
    updatedAt: now,
  });

  try {
    const instance = await executeWorkflow.create({
      params: {
        workspaceId: input.workspaceId,
        userId: input.userId,
        workflowId: input.workflow.id,
        triggerId: input.triggerId ?? undefined,
        triggerType: input.triggerType,
        triggerData: input.triggerData,
        source: 'weldconnect',
        // Lets the worker run a draft/paused workflow that is being tested.
        ...(input.isTest ? { isTest: true } : {}),
        executionId,
      },
    });
    // So Cancel can abort the instance even before the worker has picked it up.
    await db
      .update(workflowExecutions)
      .set({ cfWorkflowInstanceId: instance.id })
      .where(eq(workflowExecutions.id, executionId))
      .catch((linkErr) => console.warn('[workflow-executions] could not link the workflow instance:', linkErr));
    return { skipped: false, executionId, instanceId: instance.id };
  } catch (err) {
    const failedAt = new Date();
    await db
      .update(workflowExecutions)
      .set({
        status: 'failed',
        completedAt: failedAt,
        error: { message: `Could not start the run: ${err instanceof Error ? err.message : String(err)}` },
        updatedAt: failedAt,
      })
      .where(eq(workflowExecutions.id, executionId))
      .catch((updateErr) => console.error('[workflow-executions] could not mark the unstarted run failed:', updateErr));
    throw err;
  }
}

/**
 * Retry a failed execution as a NEW execution row (`parentExecutionId` = the
 * original, `retryCount` + 1) with the same trigger payload. Returns null if
 * not found, 'not_failed' if status isn't 'failed', 'workflow_missing' if the
 * parent workflow was deleted, 'workflow_inactive' if it is no longer active
 * (the worker would skip the run silently; test runs are exempt).
 */
export async function retryExecution(
  db: Database,
  id: string,
  workspaceId: string,
  userId: string,
  executeWorkflow: Workflow,
): Promise<
  | { kind: 'ok'; id: string; executionId: string; instanceId: string; retryOf: string }
  | { kind: 'skipped'; id: string; executionId: string; retryOf: string }
  | { kind: 'not_found' }
  | { kind: 'not_failed' }
  | { kind: 'workflow_missing'; workflowId: string }
  | { kind: 'workflow_inactive'; workflowId: string; status: string }
> {
  const [original] = await db.select().from(workflowExecutions).where(eq(workflowExecutions.id, id)).limit(1);
  if (!original) return { kind: 'not_found' };
  if (original.status !== 'failed') return { kind: 'not_failed' };

  const [workflow] = await db
    .select()
    .from(workflows)
    .where(and(eq(workflows.id, original.workflowId), isNull(workflows.deletedAt)))
    .limit(1);
  if (!workflow) return { kind: 'workflow_missing', workflowId: original.workflowId };

  const isTest = original.executionContext?.isTest === true;
  if (workflow.status !== 'active' && !isTest) {
    return { kind: 'workflow_inactive', workflowId: workflow.id, status: workflow.status };
  }

  const result = await startRun(db, executeWorkflow, {
    workspaceId,
    userId,
    workflow,
    triggerType: original.triggerType ?? 'manual',
    triggerId: original.triggerId,
    triggerData: (original.triggerData ?? {}) as Record<string, unknown>,
    isTest,
    parent: { id: original.id, retryCount: original.retryCount ?? 0 },
  });

  if (result.skipped) return { kind: 'skipped', id: result.executionId, executionId: result.executionId, retryOf: id };
  return { kind: 'ok', id: result.executionId, executionId: result.executionId, instanceId: result.instanceId, retryOf: id };
}

/** Engine trigger types a Test run may simulate. */
const TEST_TRIGGER_TYPES = new Set([
  'manual',
  'schedule',
  'webhook',
  'entity_event',
  'integration_event',
  'api',
  'workflow_complete',
]);

type TriggerLike = { type?: string; isEnabled?: boolean; timezone?: string; config?: { timezone?: string } };

/**
 * The trigger type a Test run simulates: the requested one, else the type of
 * the workflow's first enabled trigger, else `manual`. Sending the right type
 * is what makes the engine build `{{trigger.record.*}}` for an entity-event
 * workflow.
 */
export function resolveTestTriggerType(workflow: Pick<WorkflowRow, 'triggers'>, requested?: string): string {
  if (requested && TEST_TRIGGER_TYPES.has(requested)) return requested;
  const triggers = Array.isArray(workflow.triggers) ? (workflow.triggers as TriggerLike[]) : [];
  const first = triggers.find((t) => t?.type && t.isEnabled !== false);
  return first?.type && TEST_TRIGGER_TYPES.has(first.type) ? first.type : 'manual';
}

/** Timezone of the workflow's first enabled schedule trigger, if it has one. */
export function scheduleTimezone(workflow: Pick<WorkflowRow, 'triggers'>): string | undefined {
  const triggers = Array.isArray(workflow.triggers) ? (workflow.triggers as TriggerLike[]) : [];
  const schedule = triggers.find((t) => t?.type === 'schedule' && t.isEnabled !== false);
  return schedule?.timezone ?? schedule?.config?.timezone;
}

/** Start a Test run of a workflow (any status): same row pattern as a retry, flagged `isTest`. */
export async function startTestRun(
  db: Database,
  executeWorkflow: Workflow,
  input: { workspaceId: string; userId: string; workflowId: string; testData?: Record<string, unknown>; triggerType?: string },
): Promise<
  | { kind: 'ok'; executionId: string; instanceId: string; triggerType: string }
  | { kind: 'workflow_missing' }
> {
  const [workflow] = await db
    .select()
    .from(workflows)
    .where(and(eq(workflows.id, input.workflowId), isNull(workflows.deletedAt)))
    .limit(1);
  if (!workflow) return { kind: 'workflow_missing' };

  const triggerType = resolveTestTriggerType(workflow, input.triggerType);
  const triggerData: Record<string, unknown> = { ...(input.testData ?? {}) };
  if (triggerType === 'schedule' && triggerData.timezone === undefined) {
    const timezone = scheduleTimezone(workflow);
    if (timezone) triggerData.timezone = timezone;
  }

  // isTest: true always exempts this from the concurrency gate (see startRun),
  // so `result.skipped` is unreachable here — narrowed for the return type below.
  const result = await startRun(db, executeWorkflow, {
    workspaceId: input.workspaceId,
    userId: input.userId,
    workflow,
    triggerType,
    triggerData,
    isTest: true,
  });
  if (result.skipped) return { kind: 'workflow_missing' };
  return { kind: 'ok', executionId: result.executionId, instanceId: result.instanceId, triggerType };
}
