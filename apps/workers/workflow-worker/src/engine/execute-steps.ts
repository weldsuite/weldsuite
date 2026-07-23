/**
 * Runtime-agnostic workflow step orchestrator — the core of the engine.
 *
 * Decoupled from Cloudflare Workflows via the injected `StepRuntime` port, so
 * the whole machine (chaining, conditions, retries, loops, delays,
 * waiting-for-input, error handling) is unit-testable with a synchronous fake
 * runtime. Persistence + realtime are emitted through `hooks`, never written
 * here. See execute-steps.test.ts for the behavioral contract.
 */

import type {
  WorkflowDefinition,
  WorkflowRunContext,
  ExecuteStepsDeps,
  ExecuteStepsResult,
  ActionContext,
  WaitingForInputResult,
} from './types';
import { isWaitingForInput, getDelayMs } from './types';
import { resolveInputs } from './resolve-inputs';
import { evaluateCondition } from './evaluate-condition';

/** Optional resume state — lets the durable wrapper restart after a pause. */
export interface ResumeState {
  startIndex?: number;
  seedOutput?: Record<string, unknown>;
}

export async function executeWorkflowSteps(
  workflow: WorkflowDefinition,
  context: WorkflowRunContext,
  deps: ExecuteStepsDeps,
  resume?: ResumeState,
): Promise<ExecuteStepsResult> {
  const { runtime, executeAction, hooks } = deps;
  const steps = workflow.steps ?? [];
  const variables: Record<string, unknown> = { ...(context.variables ?? {}) };
  const contactData = (context.contactData ?? {}) as Record<string, unknown>;
  const triggerData = context.triggerData ?? {};
  const output: Record<string, unknown> = { ...(resume?.seedOutput ?? {}) };
  const startIndex = resume?.startIndex ?? 0;

  for (let i = startIndex; i < steps.length; i++) {
    const step = steps[i];
    await hooks?.onStepStart?.(step, i);

    // 1. Condition — skip the step (and its action) when it evaluates false.
    if (step.condition) {
      const pass = evaluateCondition(step.condition, output, triggerData, variables, contactData);
      if (!pass) {
        output[step.id] = { skipped: true };
        await hooks?.onStepResult?.(step, i, { status: 'skipped' });
        continue;
      }
    }

    // 2. Resolve inputs (UI persists to `config`; fall back to `inputs`).
    const rawInputs = (step.config ?? step.inputs ?? {}) as Record<string, unknown>;
    const inputs = resolveInputs(rawInputs, output, triggerData, variables, contactData);

    const actionCtx: ActionContext = {
      tenant: context.tenant,
      executionId: context.executionId,
      stepId: step.id,
      db: context.db,
      env: context.env,
      previousResults: output,
      triggerData,
      variables,
      contactData,
    };

    // 3. Execute with retry. maxAttempts comes from retryPolicy or onError=retry.
    const maxAttempts =
      step.retryPolicy?.maxAttempts ??
      (step.onError?.action === 'retry' ? (step.onError.retryCount ?? 0) + 1 : 1);
    const baseDelay = step.retryPolicy?.delayMs ?? 0;
    const backoff = step.retryPolicy?.backoffMultiplier ?? 1;

    let attempts = 0;
    let lastError: unknown;
    let result: unknown;
    let succeeded = false;

    while (attempts < Math.max(1, maxAttempts)) {
      attempts++;
      try {
        result = await runtime.do(`step-${i}-${step.id}-attempt-${attempts}`, () =>
          executeAction(step.type, inputs, actionCtx),
        );
        succeeded = true;
        break;
      } catch (err) {
        lastError = err;
        if (attempts < Math.max(1, maxAttempts)) {
          const delay = baseDelay * Math.pow(backoff, attempts - 1);
          if (delay > 0) await runtime.sleep(`retry-${i}-${attempts}`, delay);
        }
      }
    }

    // 4. Failure handling.
    if (!succeeded) {
      const message = lastError instanceof Error ? lastError.message : String(lastError);
      const continueOnError = step.continueOnError === true || step.onError?.action === 'continue';
      if (continueOnError) {
        output[step.id] = { error: message };
        await hooks?.onStepResult?.(step, i, { status: 'failed', error: message, attempts });
        continue;
      }
      const failResult: ExecuteStepsResult = {
        status: 'failed',
        output,
        error: { stepId: step.id, message },
      };
      await hooks?.onStepResult?.(step, i, { status: 'failed', error: message, attempts });
      await hooks?.onComplete?.(failResult);
      return failResult;
    }

    // 5. Waiting-for-input — halt; the durable wrapper resumes us later.
    if (isWaitingForInput(result)) {
      const waitResult: ExecuteStepsResult = {
        status: 'waiting_for_input',
        output,
        waiting: { stepId: step.id, stepType: (result as WaitingForInputResult).stepType },
      };
      await hooks?.onStepResult?.(step, i, { status: 'waiting_for_input', result, attempts });
      await hooks?.onComplete?.(waitResult);
      return waitResult;
    }

    // 6. Store result + run any requested delay.
    output[step.id] = result;
    await hooks?.onStepResult?.(step, i, { status: 'completed', result, attempts });

    const delayMs = getDelayMs(result);
    if (delayMs && delayMs > 0) {
      await runtime.sleep(`delay-${i}`, delayMs);
    }
  }

  const completed: ExecuteStepsResult = { status: 'completed', output };
  await hooks?.onComplete?.(completed);
  return completed;
}
