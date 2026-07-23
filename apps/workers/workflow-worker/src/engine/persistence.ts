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

export function buildExecutionHooks(args: BuildHooksArgs): ExecutionHooks {
  const { db, rt, workspaceId, executionId, totalSteps } = args;
  const stepRowIds = new Map<number, string>();
  const startedAt = new Map<number, number>();

  return {
    async onStepStart(step: WorkflowStep, index: number) {
      const rowId = generateId('wes');
      stepRowIds.set(index, rowId);
      startedAt.set(index, Date.now());
      await db.insert(schema.workflowExecutionSteps).values({
        id: rowId,
        executionId,
        stepId: step.id,
        stepName: step.name ?? null,
        stepType: step.type,
        stepIndex: index + 1,
        status: 'running',
        startedAt: new Date(),
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
            error: outcome.error ? { message: outcome.error } : null,
            retryCount: outcome.attempts ? outcome.attempts - 1 : 0,
          })
          .where(eq(schema.workflowExecutionSteps.id, rowId));
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
