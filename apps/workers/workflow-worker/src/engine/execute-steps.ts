/**
 * Runtime-agnostic workflow step orchestrator — the core of the engine.
 *
 * Decoupled from Cloudflare Workflows via the injected `StepRuntime` port, so
 * the whole machine (chaining, conditions, branches, loops, retries, delays,
 * waiting-for-input, error handling) is unit-testable with a synchronous fake
 * runtime. Persistence + realtime are emitted through `hooks`, never written
 * here. See execute-steps.test.ts for the behavioral contract.
 *
 * Steps run as the tree the canvas draws (step-tree.ts): the main flow in
 * order; a `condition` runs the steps of the branch its result picks (the
 * other branches are recorded as skipped) and the main flow then carries on;
 * a `loop` runs its body once per item.
 *
 * Durable step names: everything outside a loop keeps the names it always had
 * (`step-<index>-<id>-attempt-<n>`, `retry-…`, `delay-<index>`), so runs that
 * are in flight across a deploy replay against the same cached results. Inside
 * a loop body every name gets an `-i<item>` suffix per (nested) iteration.
 */

import type {
  WorkflowDefinition,
  WorkflowStep,
  WorkflowRunContext,
  ExecuteStepsDeps,
  ExecuteStepsResult,
  ActionContext,
  StepOutcome,
  WaitingForInputResult,
} from './types';
import { isWaitingForInput, getDelayMs } from './types';
import { resolveInputs, type LoopScope, type ResolveInputsOptions } from './resolve-inputs';
import { evaluateCondition } from './evaluate-condition';
import { errorDetails, isNonRetryableError, NonRetryableStepError } from './errors';
import {
  branchIdsOf,
  buildStepTree,
  conditionBranches,
  ifBranchId,
  ifNotBranchId,
  loopBodyId,
  stepsUnderBranch,
  valueBranchId,
  type StepTree,
} from './step-tree';

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

/** What happened to one step across every loop iteration it ran in. */
interface LoopStepTally {
  runs: number;
  skipped: number;
  /** The failure that stopped the loop, if this step caused it. */
  failed?: { error: string; errorDetails?: unknown; errorType?: string };
  /** Failures the loop carried on past (continueOnError). */
  continuedErrors: number;
  lastError?: string;
}

/**
 * Where a step is running.
 *  - `suffix`: appended to durable step names ('' outside loops).
 *  - `tally`: set inside a loop body. Steps there don't get a row per
 *    iteration; their outcomes are tallied and the outermost loop writes one
 *    row per body step when it finishes.
 *  - `nested`: inside a branch or a loop, where a step can't pause for input
 *    (the durable resume only knows how to restart the main flow).
 */
interface Scope {
  suffix: string;
  tally?: Map<number, LoopStepTally>;
  loop?: LoopScope;
  nested: boolean;
}

const TOP_SCOPE: Scope = { suffix: '', nested: false };

/** Most loop iterations (all loops, nested ones included) in one run. */
export const MAX_LOOP_ITERATIONS_PER_RUN = 250;

/**
 * Execute one step's action with retry. maxAttempts comes from retryPolicy or
 * onError=retry; sleeps between attempts follow the retry policy's backoff.
 */
async function runStepWithRetry(
  step: WorkflowStep,
  index: number,
  suffix: string,
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
        `step-${index}-${step.id}${suffix}-attempt-${attempts}`,
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
        if (delay > 0) await runtime.sleep(`retry-${index}${suffix}-${attempts}`, delay);
      }
    }
  }
  return { succeeded: false, lastError, attempts };
}

/** The branch a condition step's result picks, or null when none matches. */
function chosenBranch(step: WorkflowStep, result: unknown): string | null {
  const outcome = (result ?? {}) as { passed?: unknown; matchedBranch?: unknown };
  if (conditionBranches(step)) {
    return typeof outcome.matchedBranch === 'string' ? valueBranchId(step.id, outcome.matchedBranch) : null;
  }
  return outcome.passed === true ? ifBranchId(step.id) : ifNotBranchId(step.id);
}

/** The item list a loop step's handler validated (see handleLoop). */
function loopItems(result: unknown): unknown[] {
  const items = (result as { items?: unknown } | null)?.items;
  return Array.isArray(items) ? items : [];
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function executeWorkflowSteps(
  workflow: WorkflowDefinition,
  context: WorkflowRunContext,
  deps: ExecuteStepsDeps,
  resume?: ResumeState,
): Promise<ExecuteStepsResult> {
  const { hooks } = deps;
  const steps = workflow.steps ?? [];
  const tree = buildStepTree(steps);
  const runner = new StepRunner(steps, tree, context, deps, resume?.seedOutput);

  // A resume restarts the main flow after the step that waited (steps that
  // wait are only allowed in the main flow, whose indexes are ascending).
  const startIndex = resume?.startIndex ?? 0;
  const halted = await runner.sequence(
    tree.main.filter((index) => index >= startIndex),
    TOP_SCOPE,
  );

  const result: ExecuteStepsResult = halted ?? { status: 'completed', output: runner.output };
  await hooks?.onComplete?.(result);
  return result;
}

class StepRunner {
  readonly output: Record<string, unknown>;
  private readonly variables: Record<string, unknown>;
  private readonly contactData: Record<string, unknown>;
  private readonly triggerData: unknown;
  private loopIterations = 0;

  constructor(
    private readonly steps: WorkflowStep[],
    private readonly tree: StepTree,
    private readonly context: WorkflowRunContext,
    private readonly deps: ExecuteStepsDeps,
    seedOutput?: Record<string, unknown>,
  ) {
    this.output = { ...(seedOutput ?? {}) };
    this.variables = { ...(context.variables ?? {}) };
    this.contactData = (context.contactData ?? {}) as Record<string, unknown>;
    this.triggerData = context.triggerData ?? {};
  }

  /** Run steps in order; returns the run result to halt with, or null to carry on. */
  async sequence(indexes: number[], scope: Scope): Promise<ExecuteStepsResult | null> {
    for (const index of indexes) {
      const halted = await this.runStep(index, scope);
      if (halted) return halted;
    }
    return null;
  }

  // --- recording -----------------------------------------------------------

  private async begin(step: WorkflowStep, index: number, scope: Scope): Promise<void> {
    if (!scope.tally) await this.deps.hooks?.onStepStart?.(step, index);
  }

  private async report(step: WorkflowStep, index: number, scope: Scope, outcome: StepOutcome): Promise<void> {
    if (!scope.tally) {
      await this.deps.hooks?.onStepResult?.(step, index, outcome);
      return;
    }
    const tally = scope.tally.get(index) ?? { runs: 0, skipped: 0, continuedErrors: 0 };
    if (outcome.status === 'skipped') tally.skipped++;
    else tally.runs++;
    if (outcome.status === 'failed') {
      if (outcome.continued) {
        tally.continuedErrors++;
        tally.lastError = outcome.error;
      } else {
        tally.failed = { error: outcome.error ?? 'Unknown error', errorDetails: outcome.errorDetails, errorType: outcome.errorType };
      }
    }
    scope.tally.set(index, tally);
  }

  /** Record every step under the given branches as skipped (recorded scopes only). */
  private async skipBranches(branchIds: string[], scope: Scope): Promise<void> {
    if (scope.tally) return;
    for (const branchId of branchIds) {
      for (const index of stepsUnderBranch(this.tree, this.steps, branchId)) {
        const step = this.steps[index];
        await this.deps.hooks?.onStepStart?.(step, index);
        await this.deps.hooks?.onStepResult?.(step, index, { status: 'skipped' });
      }
    }
  }

  // --- one step ------------------------------------------------------------

  private async runStep(index: number, scope: Scope): Promise<ExecuteStepsResult | null> {
    const step = this.steps[index];
    await this.begin(step, index, scope);

    // 1. Condition — skip the step (and its action) when it evaluates false.
    if (
      step.condition &&
      !evaluateCondition(step.condition, this.output, this.triggerData, this.variables, this.contactData)
    ) {
      this.output[step.id] = { skipped: true };
      await this.report(step, index, scope, { status: 'skipped' });
      await this.skipBranches(branchIdsOf(step), scope);
      return null;
    }

    // 2. Resolve inputs (UI persists to `config`; fall back to `inputs`).
    const rawInputs = (step.config ?? step.inputs ?? {}) as Record<string, unknown>;
    const options = resolveOptionsFor(step.type, rawInputs);
    const inputs = resolveInputs(
      rawInputs,
      this.output,
      this.triggerData,
      this.variables,
      this.contactData,
      scope.loop ? { ...options, loop: scope.loop } : options,
    );

    const actionCtx: ActionContext = {
      tenant: this.context.tenant,
      executionId: this.context.executionId,
      stepId: step.id,
      db: this.context.db,
      env: this.context.env,
      previousResults: this.output,
      triggerData: this.triggerData,
      variables: this.variables,
      contactData: this.contactData,
      chainDepth: this.context.chainDepth ?? 0,
      loopItem: scope.loop?.item,
      loopIndex: scope.loop?.index,
      maxCreditsPerRun: this.context.maxCreditsPerRun,
    };

    // 3. Execute with retry.
    const attempt = await runStepWithRetry(step, index, scope.suffix, inputs, actionCtx, this.deps);
    if (!attempt.succeeded) return this.fail(step, index, scope, attempt);
    const { result, attempts } = attempt;

    // 4. Waiting-for-input — halt; the durable wrapper resumes us later.
    if (isWaitingForInput(result)) {
      if (scope.nested) {
        return this.fail(step, index, scope, {
          succeeded: false,
          attempts,
          lastError: new NonRetryableStepError('A step that waits for input cannot run inside a branch or a loop'),
        });
      }
      await this.report(step, index, scope, { status: 'waiting_for_input', result, attempts });
      return {
        status: 'waiting_for_input',
        output: this.output,
        waiting: { stepId: step.id, stepType: (result as WaitingForInputResult).stepType },
      };
    }

    // 5. Store the result, then branch, loop or wait as the step asks.
    this.output[step.id] = result;

    if (step.type === 'loop') return this.runLoop(step, index, scope, result, attempts);

    await this.report(step, index, scope, { status: 'completed', result, attempts });

    if (step.type === 'condition') {
      const chosen = chosenBranch(step, result);
      await this.skipBranches(
        branchIdsOf(step).filter((branchId) => branchId !== chosen),
        scope,
      );
      if (chosen) {
        const halted = await this.sequence(this.tree.branches.get(chosen) ?? [], { ...scope, nested: true });
        if (halted) return halted;
      }
      return null;
    }

    const delayMs = getDelayMs(result);
    if (delayMs && delayMs > 0) {
      await this.deps.runtime.sleep(`delay-${index}${scope.suffix}`, delayMs);
    }
    return null;
  }

  /**
   * Failure handling for a step that exhausted its attempts. Returns the failed
   * run result to halt with, or null when the step is configured to continue.
   */
  private async fail(
    step: WorkflowStep,
    index: number,
    scope: Scope,
    attempt: Extract<StepAttemptResult, { succeeded: false }>,
  ): Promise<ExecuteStepsResult | null> {
    const { lastError, attempts } = attempt;
    const message = messageOf(lastError);
    const errorDetail = errorDetails(lastError);
    const errorType = lastError instanceof Error ? lastError.name : undefined;
    const continueOnError = step.continueOnError === true || step.onError?.action === 'continue';

    if (continueOnError) {
      this.output[step.id] = { error: message };
      await this.report(step, index, scope, {
        status: 'failed',
        error: message,
        errorDetails: errorDetail,
        errorType,
        continued: true,
        attempts,
      });
      // A branching step that failed runs none of its branches.
      await this.skipBranches(branchIdsOf(step), scope);
      return null;
    }

    await this.report(step, index, scope, {
      status: 'failed',
      error: message,
      errorDetails: errorDetail,
      errorType,
      attempts,
    });
    return { status: 'failed', output: this.output, error: { stepId: step.id, message } };
  }

  // --- loops -----------------------------------------------------------------

  private async runLoop(
    step: WorkflowStep,
    index: number,
    scope: Scope,
    result: unknown,
    attempts: number,
  ): Promise<ExecuteStepsResult | null> {
    const items = loopItems(result);
    const bodyId = loopBodyId(step.id);
    const body = this.tree.branches.get(bodyId) ?? [];
    // The outermost loop tallies its whole body; a nested loop adds to it.
    const tally = scope.tally ?? new Map<number, LoopStepTally>();

    let failure: { message: string; item: number } | null = null;
    for (let i = 0; i < items.length; i++) {
      this.loopIterations++;
      if (this.loopIterations > MAX_LOOP_ITERATIONS_PER_RUN) {
        failure = {
          message: `This run reached the limit of ${MAX_LOOP_ITERATIONS_PER_RUN} loop iterations`,
          item: i,
        };
        break;
      }
      const halted = await this.sequence(body, {
        suffix: `${scope.suffix}-i${i}`,
        tally,
        loop: { item: items[i], index: i },
        nested: true,
      });
      if (halted) {
        failure = { message: halted.error?.message ?? 'A step in the loop failed', item: i };
        break;
      }
    }

    // Only the outermost loop writes rows: one per body step, for all iterations.
    if (!scope.tally) await this.recordLoopBody(stepsUnderBranch(this.tree, this.steps, bodyId), tally);

    if (failure) {
      return this.fail(step, index, scope, {
        succeeded: false,
        attempts,
        lastError: new NonRetryableStepError(`Item ${failure.item + 1}: ${failure.message}`),
      });
    }

    const summary = { count: items.length, iterations: items.length };
    this.output[step.id] = summary;
    await this.report(step, index, scope, { status: 'completed', result: summary, attempts });
    return null;
  }

  /** One row per loop-body step, summarising every iteration it ran in. */
  private async recordLoopBody(indexes: number[], tally: Map<number, LoopStepTally>): Promise<void> {
    const hooks = this.deps.hooks;
    for (const index of indexes) {
      const step = this.steps[index];
      const counts = tally.get(index);
      await hooks?.onStepStart?.(step, index);
      if (!counts || counts.runs === 0) {
        await hooks?.onStepResult?.(step, index, { status: 'skipped' });
      } else if (counts.failed) {
        await hooks?.onStepResult?.(step, index, {
          status: 'failed',
          error: counts.failed.error,
          errorDetails: counts.failed.errorDetails,
          errorType: counts.failed.errorType,
          attempts: 1,
        });
      } else if (counts.continuedErrors > 0) {
        await hooks?.onStepResult?.(step, index, {
          status: 'failed',
          error: `${counts.continuedErrors} of ${counts.runs} runs failed; last error: ${counts.lastError ?? 'unknown'}`,
          continued: true,
          attempts: 1,
        });
      } else {
        await hooks?.onStepResult?.(step, index, {
          status: 'completed',
          result: { runs: counts.runs, skipped: counts.skipped },
          attempts: 1,
        });
      }
    }
  }
}
