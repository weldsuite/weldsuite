/**
 * Adapter from a Cloudflare `WorkflowStep` to the engine's `StepRuntime` port.
 *
 * Retry ownership: Cloudflare gives every `step.do` an implicit 5 retries with
 * 10s exponential backoff (about 5 minutes of waiting) unless told otherwise.
 * The engine already owns retries for action steps (`retryPolicy` / `onError`
 * in `runStepWithRetry`, one `step.do` per attempt), so for those the implicit
 * retry stacked on top of it: a send_email to a bad address sat "running" for
 * 5 minutes, a step with `maxAttempts: 3` could run up to 18 times, and a
 * non-idempotent action like send_email could be repeated after an unclear
 * failure. A failed action attempt is therefore handed to Cloudflare as its
 * `NonRetryableError` (the documented way to fail a step without retries),
 * whatever the cause; whether to try again is the engine's call.
 *
 * Infrastructure steps (load-workflow, create-execution, finalize) keep
 * Cloudflare's default retries: they are idempotent and a transient database
 * blip should not fail a run.
 */

import type { WorkflowStep } from 'cloudflare:workers';
import type { StepRuntime } from './types';

/** Shape of `NonRetryableError` from `cloudflare:workflows` (injected: that module only exists in the Workers runtime). */
/** Cloudflare's duration type for a wait (`'7 days'`, or ms). */
type WaitTimeout = Parameters<WorkflowStep['waitForEvent']>[1]['timeout'];

export type NonRetryableErrorCtor = new (message: string, name?: string) => Error;

export function makeStepRuntime(step: WorkflowStep, NonRetryableError: NonRetryableErrorCtor): StepRuntime {
  return {
    do: async (name: string, fn: () => Promise<unknown>, opts?: { engineRetries?: boolean }) => {
      if (!opts?.engineRetries) return step.do(name, fn as () => Promise<never>);

      // What the action actually threw. An error that crosses the step boundary
      // is rebuilt from name + message only, so the engine gets the original
      // back (class, `details`) whenever the attempt ran in this invocation.
      let failure: { error: unknown } | undefined;
      const guarded = async () => {
        try {
          return await fn();
        } catch (err) {
          failure = { error: err };
          const original = err instanceof Error ? err : new Error(String(err));
          // The original name travels along, so a replayed failure (the step's
          // stored result, `fn` not run) is still told apart by the engine:
          // only a `NonRetryableStepError` stops its retry loop.
          throw new NonRetryableError(original.message, original.name);
        }
      };
      try {
        return await step.do(name, guarded as () => Promise<never>);
      } catch (err) {
        throw failure ? failure.error : err;
      }
    },
    sleep: (name: string, ms: number) => step.sleep(name, ms),
    waitForEvent: (name: string, opts: { type: string; timeout?: string | number }) =>
      step.waitForEvent(name, { type: opts.type, timeout: opts.timeout as WaitTimeout }),
  } as StepRuntime;
}
