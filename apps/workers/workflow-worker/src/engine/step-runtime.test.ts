import { describe, it, expect, vi } from 'vitest';
import type { WorkflowStep } from 'cloudflare:workers';
import { makeStepRuntime } from './step-runtime';
import { NonRetryableStepError } from './errors';

class FakeNonRetryableError extends Error {
  constructor(message: string, name?: string) {
    super(message);
    this.name = name ?? 'NonRetryableError';
  }
}

/** A fake CF step: runs the callback once; remembers the config it was given (if any). */
function fakeStep() {
  const calls: Array<{ name: string; config?: unknown }> = [];
  const step = {
    do: vi.fn(async (name: string, a: unknown, b?: unknown) => {
      const config = typeof a === 'function' ? undefined : a;
      const fn = (typeof a === 'function' ? a : b) as () => Promise<unknown>;
      calls.push({ name, config });
      return fn();
    }),
    sleep: vi.fn(),
    waitForEvent: vi.fn(),
  };
  return { step: step as unknown as WorkflowStep, calls };
}

describe('makeStepRuntime', () => {
  it('leaves infrastructure steps on Cloudflare default retries (no config)', async () => {
    const { step, calls } = fakeStep();
    const rt = makeStepRuntime(step, FakeNonRetryableError);
    await rt.do('load-workflow', async () => 1);
    expect(calls).toEqual([{ name: 'load-workflow', config: undefined }]);
  });

  it('returns the result of an engine-retried action attempt', async () => {
    const { step, calls } = fakeStep();
    const rt = makeStepRuntime(step, FakeNonRetryableError);
    await expect(rt.do('step-0-s1-attempt-1', async () => 'ok', { engineRetries: true })).resolves.toBe('ok');
    expect(calls).toEqual([{ name: 'step-0-s1-attempt-1', config: undefined }]);
  });

  it("hands every failed action attempt to Cloudflare as its NonRetryableError, keeping the error's name", async () => {
    const thrownInsideStep: unknown[] = [];
    const step = {
      do: vi.fn(async (_name: string, fn: () => Promise<unknown>) => {
        try {
          return await fn();
        } catch (err) {
          thrownInsideStep.push(err);
          throw err;
        }
      }),
    } as unknown as WorkflowStep;
    const rt = makeStepRuntime(step, FakeNonRetryableError);

    await rt.do('a', async () => { throw new Error('boom'); }, { engineRetries: true }).catch(() => undefined);
    await rt
      .do('b', async () => { throw new NonRetryableStepError('bad address'); }, { engineRetries: true })
      .catch(() => undefined);

    // Cloudflare never retries either: retrying is the engine's decision.
    expect(thrownInsideStep).toHaveLength(2);
    expect(thrownInsideStep[0]).toBeInstanceOf(FakeNonRetryableError);
    expect((thrownInsideStep[0] as Error).name).toBe('Error');
    expect((thrownInsideStep[0] as Error).message).toBe('boom');
    expect(thrownInsideStep[1]).toBeInstanceOf(FakeNonRetryableError);
    expect((thrownInsideStep[1] as Error).name).toBe('NonRetryableStepError');
  });

  it('gives the engine the original error back, with its class and details', async () => {
    const { step } = fakeStep();
    const rt = makeStepRuntime(step, FakeNonRetryableError);
    const original = new NonRetryableStepError('bad address', { status: 400 });
    const err = await rt
      .do('a', async () => { throw original; }, { engineRetries: true })
      .catch((e) => e);
    expect(err).toBe(original);
    expect(err.details).toEqual({ status: 400 });

    const boom = new Error('boom');
    await expect(rt.do('b', async () => { throw boom; }, { engineRetries: true })).rejects.toBe(boom);
  });

  it('passes a replayed failure through (the step callback is not run again)', async () => {
    // On replay Cloudflare rejects with the stored error without calling the callback.
    const stored = new FakeNonRetryableError('bad address', 'NonRetryableStepError');
    const step = { do: vi.fn(async () => { throw stored; }) } as unknown as WorkflowStep;
    const rt = makeStepRuntime(step, FakeNonRetryableError);
    await expect(rt.do('a', async () => 'never', { engineRetries: true })).rejects.toBe(stored);
  });
});
