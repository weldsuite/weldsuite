import { describe, it, expect, vi } from 'vitest';
import { executeWorkflowSteps } from './execute-steps';
import type {
  WorkflowDefinition,
  WorkflowStep,
  WorkflowRunContext,
  StepRuntime,
  ActionContext,
  ExecuteStepsDeps,
} from './types';

// --- helpers ---------------------------------------------------------------

function fakeRuntime() {
  const doCalls: string[] = [];
  const sleeps: { name: string; ms: number }[] = [];
  const runtime: StepRuntime = {
    do: async (name, fn) => {
      doCalls.push(name);
      return fn();
    },
    sleep: async (name, ms) => {
      sleeps.push({ name, ms });
    },
    waitForEvent: async () => {
      throw new Error('waitForEvent not expected in this test');
    },
  };
  return { runtime, doCalls, sleeps };
}

/** Fake action dispatcher: returns canned results keyed by step `type`. */
function recorder(results: Record<string, unknown> = {}) {
  const calls: Array<{
    type: string;
    inputs: Record<string, unknown>;
    previousResults: Record<string, unknown>;
  }> = [];
  const executeAction: ExecuteStepsDeps['executeAction'] = async (type, inputs, ctx: ActionContext) => {
    calls.push({ type, inputs, previousResults: { ...ctx.previousResults } });
    const r = results[type];
    if (typeof r === 'function') return (r as () => unknown)();
    return r ?? { ok: true, type };
  };
  return { executeAction, calls };
}

const step = (id: string, type: string, extra: Partial<WorkflowStep> = {}): WorkflowStep => ({
  id,
  type,
  name: id,
  config: {},
  ...extra,
});

function runContext(overrides: Partial<WorkflowRunContext> = {}): WorkflowRunContext {
  return {
    tenant: { workspaceId: 'ws_test', userId: 'user_test' },
    executionId: 'wex_test',
    db: {} as WorkflowRunContext['db'],
    env: {} as WorkflowRunContext['env'],
    triggerData: {},
    variables: {},
    ...overrides,
  };
}

const wf = (steps: WorkflowStep[]): WorkflowDefinition => ({ id: 'wf1', name: 'wf', steps });

// --- tests -----------------------------------------------------------------

describe('executeWorkflowSteps', () => {
  it('runs steps sequentially and keys each result by step id', async () => {
    const { runtime } = fakeRuntime();
    const { executeAction } = recorder({ t1: { value: 'v1' }, t2: { value: 'v2' } });

    const res = await executeWorkflowSteps(
      wf([step('s1', 't1'), step('s2', 't2')]),
      runContext(),
      { runtime, executeAction },
    );

    expect(res.status).toBe('completed');
    expect(res.output.s1).toEqual({ value: 'v1' });
    expect(res.output.s2).toEqual({ value: 'v2' });
  });

  it('makes prior step output available to later steps via previousResults', async () => {
    const { runtime } = fakeRuntime();
    const { executeAction, calls } = recorder({ t1: { name: 'Ada' } });

    await executeWorkflowSteps(wf([step('s1', 't1'), step('s2', 't2')]), runContext(), {
      runtime,
      executeAction,
    });

    expect(calls[1].previousResults.s1).toEqual({ name: 'Ada' });
  });

  it('resolves templated inputs against prior results before dispatching', async () => {
    const { runtime } = fakeRuntime();
    const { executeAction, calls } = recorder({ t1: { name: 'Ada' } });

    await executeWorkflowSteps(
      wf([
        step('s1', 't1'),
        step('s2', 't2', { config: { greeting: 'Hi {{steps.s1.name}}' } }),
      ]),
      runContext(),
      { runtime, executeAction },
    );

    expect(calls[1].inputs.greeting).toBe('Hi Ada');
  });

  it('skips a step whose condition is false (action not invoked)', async () => {
    const { runtime } = fakeRuntime();
    const { executeAction, calls } = recorder();

    const res = await executeWorkflowSteps(
      wf([step('s1', 't1', { condition: { field: 'trigger.go', operator: 'eq', value: true } })]),
      runContext({ triggerData: { go: false } }),
      { runtime, executeAction },
    );

    expect(calls).toHaveLength(0);
    expect(res.output.s1).toEqual({ skipped: true });
    expect(res.status).toBe('completed');
  });

  it('runs a step whose condition is true', async () => {
    const { runtime } = fakeRuntime();
    const { executeAction, calls } = recorder({ t1: { done: true } });

    await executeWorkflowSteps(
      wf([step('s1', 't1', { condition: { field: 'trigger.go', operator: 'eq', value: true } })]),
      runContext({ triggerData: { go: true } }),
      { runtime, executeAction },
    );

    expect(calls).toHaveLength(1);
  });

  it('stops with status failed when a step throws (no continue)', async () => {
    const { runtime } = fakeRuntime();
    const { executeAction, calls } = recorder({
      t2: () => {
        throw new Error('boom');
      },
    });

    const res = await executeWorkflowSteps(
      wf([step('s1', 't1'), step('s2', 't2'), step('s3', 't3')]),
      runContext(),
      { runtime, executeAction },
    );

    expect(res.status).toBe('failed');
    expect(res.error?.stepId).toBe('s2');
    expect(res.error?.message).toContain('boom');
    expect(res.output.s3).toBeUndefined();
    expect(calls.map((c) => c.type)).toEqual(['t1', 't2']); // s3 never ran
  });

  it('continues past a failing step when continueOnError is true', async () => {
    const { runtime } = fakeRuntime();
    const { executeAction, calls } = recorder({
      t2: () => {
        throw new Error('boom');
      },
      t3: { ok: true },
    });

    const res = await executeWorkflowSteps(
      wf([step('s1', 't1'), step('s2', 't2', { continueOnError: true }), step('s3', 't3')]),
      runContext(),
      { runtime, executeAction },
    );

    expect(res.status).toBe('completed');
    expect(res.output.s2).toMatchObject({ error: expect.stringContaining('boom') });
    expect(calls.map((c) => c.type)).toContain('t3');
  });

  it('retries a failing step per retryPolicy and succeeds', async () => {
    const { runtime, sleeps } = fakeRuntime();
    let attempts = 0;
    const { executeAction } = recorder({
      t1: () => {
        attempts += 1;
        if (attempts < 2) throw new Error('transient');
        return { ok: true };
      },
    });

    const res = await executeWorkflowSteps(
      wf([step('s1', 't1', { retryPolicy: { maxAttempts: 3, delayMs: 10 } })]),
      runContext(),
      { runtime, executeAction },
    );

    expect(attempts).toBe(2);
    expect(res.status).toBe('completed');
    expect(sleeps.some((s) => s.ms === 10)).toBe(true); // waited between attempts
  });

  it('fails after exhausting retry attempts', async () => {
    const { runtime } = fakeRuntime();
    let attempts = 0;
    const { executeAction } = recorder({
      t1: () => {
        attempts += 1;
        throw new Error('always');
      },
    });

    const res = await executeWorkflowSteps(
      wf([step('s1', 't1', { retryPolicy: { maxAttempts: 2, delayMs: 0 } })]),
      runContext(),
      { runtime, executeAction },
    );

    expect(attempts).toBe(2);
    expect(res.status).toBe('failed');
  });

  it('sleeps for a delay step using runtime.sleep, then continues', async () => {
    const { runtime, sleeps } = fakeRuntime();
    const { executeAction, calls } = recorder({
      t1: { delayed: true, __delayMs: 1000 },
      t2: { ok: true },
    });

    const res = await executeWorkflowSteps(wf([step('s1', 't1'), step('s2', 't2')]), runContext(), {
      runtime,
      executeAction,
    });

    expect(sleeps.some((s) => s.ms === 1000)).toBe(true);
    expect(calls.map((c) => c.type)).toContain('t2');
    expect(res.status).toBe('completed');
  });

  it('halts with waiting_for_input when an action signals it', async () => {
    const { runtime } = fakeRuntime();
    const { executeAction, calls } = recorder({
      t1: { __waitingForInput: true, stepType: 'collect_input' },
    });

    const res = await executeWorkflowSteps(wf([step('s1', 't1'), step('s2', 't2')]), runContext(), {
      runtime,
      executeAction,
    });

    expect(res.status).toBe('waiting_for_input');
    expect(res.waiting?.stepId).toBe('s1');
    expect(calls.map((c) => c.type)).not.toContain('t2');
  });

  it('invokes lifecycle hooks', async () => {
    const { runtime } = fakeRuntime();
    const { executeAction } = recorder();
    const onStepStart = vi.fn();
    const onStepResult = vi.fn();
    const onComplete = vi.fn();

    await executeWorkflowSteps(wf([step('s1', 't1'), step('s2', 't2')]), runContext(), {
      runtime,
      executeAction,
      hooks: { onStepStart, onStepResult, onComplete },
    });

    expect(onStepStart).toHaveBeenCalledTimes(2);
    expect(onStepResult).toHaveBeenCalledTimes(2);
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it('runs every step inside runtime.do', async () => {
    const { runtime, doCalls } = fakeRuntime();
    const { executeAction } = recorder();

    await executeWorkflowSteps(wf([step('s1', 't1'), step('s2', 't2')]), runContext(), {
      runtime,
      executeAction,
    });

    expect(doCalls.length).toBeGreaterThanOrEqual(2);
  });

  it('resumes from a start index with seeded output (durable resume seam)', async () => {
    const { runtime } = fakeRuntime();
    const { executeAction, calls } = recorder({ t2: { ok: true }, t3: { done: true } });

    const res = await executeWorkflowSteps(
      wf([step('s1', 't1'), step('s2', 't2'), step('s3', 't3')]),
      runContext(),
      { runtime, executeAction },
      { startIndex: 1, seedOutput: { s1: { resumed: true } } },
    );

    // s1 is not re-run (seeded); s2 and s3 execute.
    expect(calls.map((c) => c.type)).toEqual(['t2', 't3']);
    expect(res.output.s1).toEqual({ resumed: true });
    expect(res.status).toBe('completed');
  });
});
