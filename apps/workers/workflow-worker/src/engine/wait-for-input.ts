/**
 * Runs a workflow through its pauses for input (approvals): run the steps;
 * when a step waits for input, mark the run `waiting_for_input`, wait durably
 * for the `resume-step` event, mark it `running` again and carry on after
 * that step. A wait that times out fails the step (and so the run) with a
 * readable message instead of crashing the durable instance.
 *
 * Runtime-agnostic like execute-steps.ts: the status writes go through
 * `runtime.do` (replay-safe), the wait through `runtime.waitForEvent`, so the
 * whole loop runs under a fake runtime in tests (wait-for-input.test.ts).
 *
 * Durable names (kept from when this loop lived in src/index.ts, so runs in
 * flight across a deploy replay against the same cached results):
 * `wait-input-<index>`, `resume-<index>`; new: `await-input-<index>`. An
 * expired wait leaves the row on `waiting_for_input` for finalize to fail.
 */

import { executeWorkflowSteps } from './execute-steps';
import { markExecutionResumed, markExecutionWaiting } from './execution-row';
import { manualStepDecision } from './actions/interactive';
import type { ExecutionHooksWithProgress } from './persistence';
import type { ExecuteStepsDeps, ExecuteStepsResult, WorkflowDb, WorkflowDefinition, WorkflowRunContext } from './types';

/** The event a waiting run is resumed with (connect-api POST /workflow-executions/:id/decision). */
export const RESUME_EVENT_TYPE = 'resume-step';

/** How long a run waits for input before the step fails. */
export const WAIT_FOR_INPUT_TIMEOUT = '7 days';

/** The message a step that never got its input fails with. */
export function waitExpiredMessage(stepType: string | undefined): string {
  return stepType === 'manual_step'
    ? 'Approval expired: nobody approved or rejected this step within 7 days'
    : 'No input arrived within 7 days';
}

export interface InputWaitDeps extends ExecuteStepsDeps {
  hooks: ExecutionHooksWithProgress;
  db: WorkflowDb;
  executionId: string;
  /** Override the wait (tests); a Cloudflare duration string or milliseconds. */
  timeout?: string | number;
}

/** What the resumed step's output becomes: an approval's decision, or the event payload as sent. */
function resumedStepOutput(stepType: string | undefined, payload: Record<string, unknown>): Record<string, unknown> {
  return stepType === 'manual_step' ? { ...manualStepDecision(payload) } : payload;
}

export async function runWithInputWaits(
  workflow: WorkflowDefinition,
  context: WorkflowRunContext,
  deps: InputWaitDeps,
): Promise<ExecuteStepsResult> {
  const { runtime, hooks, db, executionId } = deps;
  const steps = workflow.steps ?? [];
  const engineDeps: ExecuteStepsDeps = { runtime, executeAction: deps.executeAction, hooks };

  let result = await executeWorkflowSteps(workflow, context, engineDeps);

  while (result.status === 'waiting_for_input' && result.waiting) {
    const { stepId, stepType } = result.waiting;
    const index = steps.findIndex((s) => s.id === stepId);

    // Inside a step.do so the status write happens once, not on every replay.
    await runtime.do(`await-input-${index}`, () => markExecutionWaiting(db, executionId, index));

    let payload: Record<string, unknown>;
    try {
      const event = await runtime.waitForEvent<{ payload?: Record<string, unknown> }>(`wait-input-${index}`, {
        type: RESUME_EVENT_TYPE,
        timeout: deps.timeout ?? WAIT_FOR_INPUT_TIMEOUT,
      });
      payload = (event?.payload ?? {}) as Record<string, unknown>;
    } catch {
      // The only way a wait ends without its event is the timeout.
      const message = waitExpiredMessage(stepType);
      await hooks.markWaitExpired(steps[index], index, message);
      result = { status: 'failed', output: result.output, error: { stepId, message } };
      break;
    }

    await runtime.do(`resume-${index}`, () => markExecutionResumed(db, executionId));
    const stepOutput = resumedStepOutput(stepType, payload);
    // The step that waited has now finished: count it in the progress.
    await hooks.markFinished(index, stepOutput);
    result = await executeWorkflowSteps(workflow, context, engineDeps, {
      startIndex: index + 1,
      seedOutput: { ...result.output, [stepId]: stepOutput },
    });
  }

  return result;
}
