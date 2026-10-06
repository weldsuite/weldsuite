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
  WorkflowStep,
  WorkflowRunContext,
  ExecuteStepsDeps,
  ExecuteStepsResult,
  ActionContext,
  WaitingForInputResult,
} from './types';
import { isWaitingForInput, getDelayMs } from './types';
import { resolveInputs, type ResolveInputsOptions } from './resolve-inputs';
import { evaluateCondition } from './evaluate-condition';
import { errorDetails, isNonRetryableError } from './errors';

/**
 * Per-action template options. An HTML email body is markup the author wrote
 * with record data spliced in, so the spliced values are escaped. Plain-text
 * bodies (`isHtml: false`) are escaped wholesale by the send_email handler.
 */
function resolveOptionsFor(type: string, rawInputs: Record<string, unknown>): ResolveInputsOptions | undefined {
  if ((type === 'send_email' || type === 'email') && rawInputs.isHtml !== false) {
    return { escapeHtmlKeys: ['body', 'html'] };
  }
  return undefined;
}

/** Optional resume state — lets the durable wrapper restart after a pause. */
export interface ResumeState {
  startIndex?: number;
  seedOutput?: Record<string, unknown>;
}

type StepAttemptResult =
  | { succeeded: true; result: unknown; attempts: number }
  | { succeeded: false; lastError: unknown; attempts: number };

/**
 * Execute one step's action with retry. maxAttempts comes from retryPolicy or
 * onError=retry; sleeps between attempts follow the retry policy's backoff.
 */
async function runStepWithRetry(
  step: WorkflowStep,
  index: number,
  inputs: Record<string, unknown>,
  actionCtx: ActionContext,
  deps: ExecuteStepsDeps,
): Promise<StepAttemptResult> {
  const { runtime, executeAction } = deps;
  const maxAttempts =
    step.retryPolicy?.maxAttempts ??
    (step.onError?.action === 'retry' ? (step.onError.retryCount ?? 0) + 1 : 1);
  const limit = Math.max(1, maxAttempts);
  const baseDelay = step.retryPolicy?.delayMs ?? 0;
  const backoff = step.retryPolicy?.backoffMultiplier ?? 1;

  let attempts = 0;
  let lastError: unknown;

  while (attempts < limit) {
    attempts++;
    try {
      // The engine owns retries (the loop above), so the durable runtime must
      // not stack its own implicit retry/backoff on top.
      const result = await runtime.do(
        `step-${index}-${step.id}-attempt-${attempts}`,
        () => executeAction(step.type, inputs, actionCtx),
        { engineRetries: true },
      );
      return { succeeded: true, result, attempts };
    } catch (err) {
      lastError = err;
      // Bad input / validation rejections fail the same way every time.
      if (isNonRetryableError(err)) break;
      if (attempts < limit) {
        const delay = baseDelay * Math.pow(backoff, attempts - 1);
        if (delay > 0) await runtime.sleep(`retry-${index}-${attempts}`, delay);
      }
    }
  }
  return { succeeded: false, lastError, attempts };
}

/**
 * Failure handling for a step that exhausted its attempts. Returns the failed
 * run result to halt with, or null when the step is configured to continue.
 */
async function handleStepFailure(
  step: WorkflowStep,
  index: number,
  attempt: Extract<StepAttemptResult, { succeeded: false }>,
  output: Record<string, unknown>,
  hooks: ExecuteStepsDeps['hooks'],
): Promise<ExecuteStepsResult | null> {
  const { lastError, attempts } = attempt;
  const message = lastError instanceof Error ? lastError.message : String(lastError);
  const errorDetail = errorDetails(lastError);
  const continueOnError = step.continueOnError === true || step.onError?.action === 'continue';
  if (continueOnError) {
    output[step.id] = { error: message };
    await hooks?.onStepResult?.(step, index, {
      status: 'failed',
      error: message,
      errorDetails: errorDetail,
      continued: true,
      attempts,
    });
    return null;
  }
  const failResult: ExecuteStepsResult = {
    status: 'failed',
    output,
    error: { stepId: step.id, message },
  };
  await hooks?.onStepResult?.(step, index, {
    status: 'failed',
    error: message,
    errorDetails: errorDetail,
    attempts,
  });
  await hooks?.onComplete?.(failResult);
  return failResult;
}

export async function executeWorkflowSteps(
  workflow: WorkflowDefinition,
  context: WorkflowRunContext,
  deps: ExecuteStepsDeps,
  resume?: ResumeState,
): Promise<ExecuteStepsResult> {
  const { runtime, hooks } = deps;
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
    if (step.condition && !evaluateCondition(step.condition, output, triggerData, variables, contactData)) {
      output[step.id] = { skipped: true };
      await hooks?.onStepResult?.(step, i, { status: 'skipped' });
      continue;
    }

    // 2. Resolve inputs (UI persists to `config`; fall back to `inputs`).
    const rawInputs = (step.config ?? step.inputs ?? {}) as Record<string, unknown>;
    const inputs = resolveInputs(
      rawInputs,
      output,
      triggerData,
      variables,
      contactData,
      resolveOptionsFor(step.type, rawInputs),
    );

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
      chainDepth: context.chainDepth ?? 0,
    };

    // 3. Execute with retry.
    const attempt = await runStepWithRetry(step, i, inputs, actionCtx, deps);

    // 4. Failure handling.
    if (!attempt.succeeded) {
      const failResult = await handleStepFailure(step, i, attempt, output, hooks);
      if (failResult) return failResult;
      continue;
    }
    const { result, attempts } = attempt;

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
