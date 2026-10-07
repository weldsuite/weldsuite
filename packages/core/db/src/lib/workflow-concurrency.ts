/**
 * Workflow run concurrency — `workflows.settings.maxConcurrentRuns` enforcement.
 *
 * Shared by every WeldConnect dispatcher so a workflow's run limit holds no
 * matter which trigger started the run:
 *   - connect-api `services/workflow-executions.ts` (`startRun`: manual, test,
 *     retry, webhook)
 *   - `@weldsuite/entity-events` `workflow-dispatch.ts` (entity-event matcher,
 *     consumed by workflow-worker's entity-workflows queue consumer)
 *   - workflow-worker's schedule sweep (`cron/schedule-sweep.ts`)
 *
 * Lives in `@weldsuite/db` (not `@weldsuite/worker-kit`) because
 * `@weldsuite/entity-events` depends on `@weldsuite/db` directly but not on
 * worker-kit, and workers never import across each other's folders.
 *
 * Counting-then-inserting is best-effort, NOT a hard guarantee under truly
 * concurrent writes: two dispatches racing between the count and their own
 * insert can both pass and both start, so the limit can be exceeded by a
 * small margin under heavy concurrent traffic. That's an accepted tradeoff —
 * a workflow run is not a financial transaction, and a strict guarantee would
 * need a DB-level advisory lock around every dispatch path, which isn't worth
 * the complexity here.
 */

import { and, eq, inArray, sql } from 'drizzle-orm';
import type { NeonHttpDatabase } from 'drizzle-orm/neon-http';
import * as schema from '../schema';

type TenantDbLike = NeonHttpDatabase<typeof schema>;

/** Execution statuses that occupy a concurrency "slot". */
export const ACTIVE_WORKFLOW_EXECUTION_STATUSES = ['queued', 'running', 'waiting_for_input'] as const;

function randomBase36(length: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (b) => (b % 36).toString(36)).join('');
}

function generateId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${randomBase36(8)}`;
}

/**
 * `workflows.settings.maxConcurrentRuns`, normalized. Anything that isn't a
 * positive finite number (missing, zero, negative, non-numeric legacy value)
 * means unlimited.
 */
export function workflowConcurrencyLimit(settings: unknown): number | undefined {
  if (!settings || typeof settings !== 'object') return undefined;
  const raw = (settings as Record<string, unknown>).maxConcurrentRuns;
  return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : undefined;
}

/** Runs of this workflow currently occupying a slot (queued/running/waiting_for_input). */
export async function countActiveWorkflowExecutions(db: TenantDbLike, workflowId: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(schema.workflowExecutions)
    .where(
      and(
        eq(schema.workflowExecutions.workflowId, workflowId),
        inArray(schema.workflowExecutions.status, ACTIVE_WORKFLOW_EXECUTION_STATUSES),
      ),
    );
  return Number(row?.count ?? 0);
}

/**
 * Would starting one more run of this workflow exceed its configured limit?
 * Always false when `settings.maxConcurrentRuns` is unset/non-positive.
 */
export async function isAtWorkflowConcurrencyLimit(
  db: TenantDbLike,
  workflowId: string,
  settings: unknown,
): Promise<boolean> {
  const limit = workflowConcurrencyLimit(settings);
  if (limit === undefined) return false;
  const active = await countActiveWorkflowExecutions(db, workflowId);
  return active >= limit;
}

export interface SkippedWorkflowExecutionInput {
  workflowId: string;
  workflowVersion?: number | null;
  workflowName?: string | null;
  triggeredBy?: string | null;
  triggerType: string;
  triggerId?: string | null;
  triggerData?: Record<string, unknown> | null;
  /** Short machine-readable reason, surfaced as `error.code`. */
  reason: string;
  /** Human-readable explanation, surfaced as `error.message`. */
  message: string;
}

/**
 * Record a run that never started because the workflow was already at its
 * concurrency limit. Inserts a `skipped` `workflow_executions` row (no CF
 * Workflow instance is created, nothing to cancel) so the run stays visible
 * in the executions list instead of silently vanishing.
 */
export async function insertSkippedWorkflowExecution(
  db: TenantDbLike,
  input: SkippedWorkflowExecutionInput,
): Promise<string> {
  const id = generateId('wex');
  const now = new Date();
  await db.insert(schema.workflowExecutions).values({
    id,
    workflowId: input.workflowId,
    workflowVersion: input.workflowVersion ?? 1,
    workflowName: input.workflowName ?? null,
    status: 'skipped',
    triggeredBy: input.triggeredBy ?? 'system',
    triggerType: input.triggerType,
    triggerId: input.triggerId ?? null,
    triggerData: input.triggerData ?? null,
    startedAt: now,
    completedAt: now,
    totalSteps: 0,
    currentStepIndex: 0,
    error: { message: input.message, code: input.reason },
    createdAt: now,
    updatedAt: now,
  });
  return id;
}
