/**
 * Execution persistence + realtime hooks.
 *
 * Turns the engine's `ExecutionHooks` callbacks into `workflow_execution_steps`
 * rows and realtime events, keeping the orchestrator itself free of I/O.
 *
 * Replay safety: Cloudflare Workflows re-runs `run()` from the top after every
 * sleep / waitForEvent, memoising only the `step.do` results. These hooks run
 * outside `step.do`, so they are called again for every step that already
 * ran. Each step row is therefore looked up by (execution, step index) before
 * it is inserted, and a step whose row is already terminal is "replayed": no
 * second row, no second error log, no duplicate realtime events.
 *
 * NOTE: these write to the `task`-source tables. helpdesk-source parity
 * (helpdesk_workflow_execution_steps) is wired during integration; the table
 * set is the only thing that differs.
 */

import { and, eq } from 'drizzle-orm';
import { schema } from '../db';
import { generateId } from '../lib/id';
import type { ExecutionHooks, StepOutcome, WorkflowDb, WorkflowStep } from './types';

// Minimal shape of the realtime publisher we depend on.
export interface RealtimeLike {
  workflowExecutionEvent(
    workspaceId: string,
    executionId: string,
    event: string,
    payload: Record<string, unknown>,
  ): unknown;
}

export interface BuildHooksArgs {
  db: WorkflowDb;
  rt: RealtimeLike | null;
  workspaceId: string;
  executionId: string;
  totalSteps: number;
  /** Stamped on `workflow_error_logs` rows so the error dashboard can filter by workflow. */
  workflowId?: string;
}

const STATUS_EVENT: Record<StepOutcome['status'], string> = {
  completed: 'step_completed',
  failed: 'step_failed',
  skipped: 'step_skipped',
  waiting_for_input: 'waiting_for_input',
};

type StepLog = { timestamp: string; level: 'debug' | 'info' | 'warn' | 'error'; message: string };

function logLine(level: StepLog['level'], message: string): StepLog {
  return { timestamp: new Date().toISOString(), level, message };
}

/** The closing log line for a step outcome (what the run page's Logs tab shows). */
function outcomeLog(outcome: StepOutcome, duration: number | null): StepLog {
  const attemptNote = outcome.attempts && outcome.attempts > 1 ? ` (attempt ${outcome.attempts})` : '';
  switch (outcome.status) {
    case 'completed':
      return logLine('info', `Completed in ${duration ?? 0}ms${attemptNote}`);
    case 'skipped':
      return logLine('info', 'Skipped: condition not met');
    case 'waiting_for_input':
      return logLine('info', 'Waiting for input');
    default:
      return logLine(
        'error',
        `Failed: ${outcome.error ?? 'unknown error'}${attemptNote}${outcome.continued ? ' (workflow continued)' : ''}`,
      );
  }
}

export type ExecutionHooksWithProgress = ExecutionHooks & {
  /**
   * Count a step as finished outside the engine loop (a waiting step resumed
   * by its input). `output` replaces the step row's output (an approval's decision).
   */
  markFinished(index: number, output?: Record<string, unknown>): Promise<void>;
  /**
   * Fail a step that waited for input and never got it (the wait timed out).
   * Only a row still `waiting_for_input` is touched, so a replay neither
   * rewrites the row nor logs the error twice.
   */
  markWaitExpired(step: WorkflowStep, index: number, message: string): Promise<void>;
};

/** One `workflow_error_logs` row per failed step. Never throws: logging must not fail the run. */
async function recordStepError(
  db: WorkflowDb,
  args: { workflowId?: string; executionId: string; step: WorkflowStep; outcome: StepOutcome },
): Promise<void> {
  const { workflowId, executionId, step, outcome } = args;
  try {
    await db.insert(schema.workflowErrorLogs).values({
      id: generateId('wel'),
      workflowId: workflowId ?? null,
      executionId,
      errorMessage: outcome.error ?? 'Unknown error',
      errorType: outcome.errorType?.slice(0, 100) ?? null,
      // A step the run carried on past is worth a look, not an alarm.
      severity: outcome.continued ? 'warning' : 'error',
      stepId: step.id.slice(0, 50),
      stepName: step.name?.slice(0, 255) ?? null,
      stepType: step.type.slice(0, 100),
      input: outcome.errorDetails !== undefined ? { details: outcome.errorDetails } : null,
      occurredAt: new Date(),
    });
  } catch (err) {
    console.warn('[ExecutionHooks] could not write error log:', err);
  }
}

export function buildExecutionHooks(args: BuildHooksArgs): ExecutionHooksWithProgress {
  const { db, rt, workspaceId, executionId, totalSteps, workflowId } = args;
  const stepRowIds = new Map<number, string>();
  const startedAt = new Map<number, number>();
  const stepLogs = new Map<number, StepLog[]>();
  // Steps that have finished (completed, skipped, or failed but carried on).
  // `currentStepIndex` is its size, so a failure on step N leaves N-1.
  const finished = new Set<number>();
  // Steps whose row was already terminal when this invocation reached them.
  const replayed = new Set<number>();

  async function writeProgress() {
    await db
      .update(schema.workflowExecutions)
      .set({ currentStepIndex: finished.size, updatedAt: new Date() })
      .where(eq(schema.workflowExecutions.id, executionId));
  }

  return {
    async markFinished(index: number, output?: Record<string, unknown>) {
      finished.add(index);
      const rowId = stepRowIds.get(index);
      if (rowId) {
        // The input arrived: the waiting step is done.
        await db
          .update(schema.workflowExecutionSteps)
          .set({ status: 'completed', completedAt: new Date(), ...(output ? { output } : {}) })
          .where(
            and(
              eq(schema.workflowExecutionSteps.id, rowId),
              eq(schema.workflowExecutionSteps.status, 'waiting_for_input'),
            ),
          );
      }
      await writeProgress();
    },

    async markWaitExpired(step: WorkflowStep, index: number, message: string) {
      const rowId = stepRowIds.get(index);
      if (!rowId) return;
      const completedAt = new Date();
      const start = startedAt.get(index);
      const duration = start ? completedAt.getTime() - start : null;
      const updated = await db
        .update(schema.workflowExecutionSteps)
        .set({
          status: 'failed',
          completedAt,
          duration,
          error: { message },
          logs: [...(stepLogs.get(index) ?? []), outcomeLog({ status: 'failed', error: message }, duration)],
        })
        .where(
          and(
            eq(schema.workflowExecutionSteps.id, rowId),
            eq(schema.workflowExecutionSteps.status, 'waiting_for_input'),
          ),
        )
        .returning({ id: schema.workflowExecutionSteps.id });
      if (updated.length === 0) return;
      const outcome: StepOutcome = { status: 'failed', error: message, errorType: 'WaitExpiredError' };
      await recordStepError(db, { workflowId, executionId, step, outcome });
      if (rt) {
        await rt.workflowExecutionEvent(workspaceId, executionId, STATUS_EVENT.failed, {
          stepIndex: index + 1,
          totalSteps,
          stepId: step.id,
          stepName: step.name,
          error: message,
        });
      }
    },

    async onStepStart(step: WorkflowStep, index: number) {
      const [existing] = await db
        .select({
          id: schema.workflowExecutionSteps.id,
          status: schema.workflowExecutionSteps.status,
          startedAt: schema.workflowExecutionSteps.startedAt,
          logs: schema.workflowExecutionSteps.logs,
        })
        .from(schema.workflowExecutionSteps)
        .where(
          and(
            eq(schema.workflowExecutionSteps.executionId, executionId),
            eq(schema.workflowExecutionSteps.stepIndex, index + 1),
          ),
        )
        .limit(1);
      if (existing) {
        // A replay (or a step resumed mid-retry): keep the row already written.
        stepRowIds.set(index, existing.id);
        startedAt.set(index, existing.startedAt?.getTime() ?? Date.now());
        stepLogs.set(index, existing.logs ?? []);
        if (existing.status !== 'running') replayed.add(index);
        return;
      }

      const rowId = generateId('wes');
      stepRowIds.set(index, rowId);
      startedAt.set(index, Date.now());
      const logs = [logLine('info', `Started ${step.name ?? step.id} (${step.type})`)];
      stepLogs.set(index, logs);
      await db.insert(schema.workflowExecutionSteps).values({
        id: rowId,
        executionId,
        stepId: step.id,
        stepName: step.name ?? null,
        stepType: step.type,
        stepIndex: index + 1,
        status: 'running',
        startedAt: new Date(),
        logs,
      });
      if (rt) {
        await rt.workflowExecutionEvent(workspaceId, executionId, 'step_started', {
          stepIndex: index + 1,
          totalSteps,
          stepId: step.id,
          stepName: step.name,
          stepType: step.type,
        });
      }
    },

    async onStepResult(step: WorkflowStep, index: number, outcome: StepOutcome) {
      const stepFinished =
        outcome.status === 'completed' ||
        outcome.status === 'skipped' ||
        (outcome.status === 'failed' && outcome.continued === true);

      if (replayed.has(index)) {
        // Recorded by an earlier invocation; only rebuild the progress count.
        if (stepFinished) finished.add(index);
        return;
      }

      const rowId = stepRowIds.get(index);
      const start = startedAt.get(index);
      const completedAt = new Date();
      const duration = start ? completedAt.getTime() - start : null;

      if (rowId) {
        await db
          .update(schema.workflowExecutionSteps)
          .set({
            status: outcome.status,
            completedAt,
            duration,
            output:
              outcome.status === 'skipped'
                ? { skipped: true }
                : (outcome.result as Record<string, unknown> | undefined) ?? null,
            error: outcome.error
              ? {
                  message: outcome.error,
                  ...(outcome.errorDetails !== undefined ? { details: outcome.errorDetails } : {}),
                }
              : null,
            retryCount: outcome.attempts ? outcome.attempts - 1 : 0,
            logs: [...(stepLogs.get(index) ?? []), outcomeLog(outcome, duration)],
          })
          .where(eq(schema.workflowExecutionSteps.id, rowId));
      }

      if (outcome.status === 'failed') {
        await recordStepError(db, { workflowId, executionId, step, outcome });
      }

      if (stepFinished) {
        finished.add(index);
        await writeProgress();
      }

      if (rt) {
        await rt.workflowExecutionEvent(
          workspaceId,
          executionId,
          STATUS_EVENT[outcome.status],
          {
            stepIndex: index + 1,
            totalSteps,
            stepId: step.id,
            stepName: step.name,
            ...(outcome.error ? { error: outcome.error } : {}),
            ...(duration != null ? { duration } : {}),
          },
        );
      }
    },
  };
}
