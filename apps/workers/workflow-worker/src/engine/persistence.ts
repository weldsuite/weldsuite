/**
 * Execution persistence + realtime hooks.
 *
 * Turns the engine's `ExecutionHooks` callbacks into `workflow_execution_steps`
 * rows and realtime events, keeping the orchestrator itself free of I/O.
 *
 * NOTE: these write to the `task`-source tables. helpdesk-source parity
 * (helpdesk_workflow_execution_steps) is wired during integration; the table
 * set is the only thing that differs.
 */

import { eq } from 'drizzle-orm';
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
  ): Promise<unknown> | unknown;
}

export interface BuildHooksArgs {
  db: WorkflowDb;
  rt: RealtimeLike | null;
  workspaceId: string;
  executionId: string;
  totalSteps: number;
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
  /** Count a step as finished outside the engine loop (a waiting step resumed by its input). */
  markFinished(index: number): Promise<void>;
};

export function buildExecutionHooks(args: BuildHooksArgs): ExecutionHooksWithProgress {
  const { db, rt, workspaceId, executionId, totalSteps } = args;
  const stepRowIds = new Map<number, string>();
  const startedAt = new Map<number, number>();
  const stepLogs = new Map<number, StepLog[]>();
  // Steps that have finished (completed, skipped, or failed but carried on).
  // `currentStepIndex` is its size, so a failure on step N leaves N-1.
  const finished = new Set<number>();

  async function writeProgress() {
    await db
      .update(schema.workflowExecutions)
      .set({ currentStepIndex: finished.size, updatedAt: new Date() })
      .where(eq(schema.workflowExecutions.id, executionId));
  }

  return {
    async markFinished(index: number) {
      finished.add(index);
      await writeProgress();
    },

    async onStepStart(step: WorkflowStep, index: number) {
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

      const stepFinished =
        outcome.status === 'completed' ||
        outcome.status === 'skipped' ||
        (outcome.status === 'failed' && outcome.continued === true);
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
