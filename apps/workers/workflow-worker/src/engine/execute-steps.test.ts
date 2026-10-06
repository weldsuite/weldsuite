import { describe, it, expect, vi } from 'vitest';
import { executeWorkflowSteps } from './execute-steps';
import { NonRetryableStepError } from './errors';
import { handleCondition, handleLoop } from './actions/control';
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

  it('does not retry a non-retryable failure, even with a retry policy, and passes its details on', async () => {
    const { runtime, sleeps } = fakeRuntime();
    let attempts = 0;
    const { executeAction } = recorder({
      t1: () => {
        attempts += 1;
        throw new NonRetryableStepError('Recipient address "x" is not valid', { status: 400 });
      },
    });
    const onStepResult = vi.fn();

    const res = await executeWorkflowSteps(
      wf([step('s1', 't1', { retryPolicy: { maxAttempts: 5, delayMs: 1000 } })]),
      runContext(),
      { runtime, executeAction, hooks: { onStepResult } },
    );

    expect(attempts).toBe(1);
    expect(sleeps).toHaveLength(0);
    expect(res.status).toBe('failed');
    expect(res.error?.message).toBe('Recipient address "x" is not valid');
    expect(onStepResult).toHaveBeenCalledWith(
      expect.anything(),
      0,
      expect.objectContaining({ status: 'failed', attempts: 1, errorDetails: { status: 400 } }),
    );
    expect(onStepResult.mock.calls[0][2].continued).toBeUndefined();
  });

  it('recognises a non-retryable error that lost its prototype crossing the step boundary', async () => {
    const { runtime } = fakeRuntime();
    let attempts = 0;
    const { executeAction } = recorder({
      t1: () => {
        attempts += 1;
        const e = new Error('rebuilt');
        e.name = 'NonRetryableStepError';
        throw e;
      },
    });
    await executeWorkflowSteps(
      wf([step('s1', 't1', { retryPolicy: { maxAttempts: 3, delayMs: 0 } })]),
      runContext(),
      { runtime, executeAction },
    );
    expect(attempts).toBe(1);
  });

  it('flags a failed step the run continued past', async () => {
    const { runtime } = fakeRuntime();
    const { executeAction } = recorder({
      t1: () => {
        throw new Error('nope');
      },
    });
    const onStepResult = vi.fn();
    const res = await executeWorkflowSteps(wf([step('s1', 't1', { continueOnError: true })]), runContext(), {
      runtime,
      executeAction,
      hooks: { onStepResult },
    });
    expect(res.status).toBe('completed');
    expect(onStepResult).toHaveBeenCalledWith(
      expect.anything(),
      0,
      expect.objectContaining({ status: 'failed', continued: true }),
    );
  });

  it('runs action attempts as engine-retried steps (the durable runtime must not retry them too)', async () => {
    const opts: Array<{ engineRetries?: boolean } | undefined> = [];
    const runtime: StepRuntime = {
      do: async (_name, fn, o) => {
        opts.push(o);
        return fn();
      },
      sleep: async () => undefined,
      waitForEvent: async () => {
        throw new Error('unexpected');
      },
    };
    const { executeAction } = recorder();
    await executeWorkflowSteps(wf([step('s1', 't1')]), runContext(), { runtime, executeAction });
    expect(opts).toEqual([{ engineRetries: true }]);
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

// --- branches and loops (real condition / loop handlers) ---------------------

describe('executeWorkflowSteps: branches and loops', () => {
  /** Runs `condition` / `loop` through their real handlers and records every other step. */
  function engineWith(results: Record<string, unknown> = {}) {
    const ran: Array<{ id: string; inputs: Record<string, unknown> }> = [];
    const executeAction: ExecuteStepsDeps['executeAction'] = async (type, inputs, ctx) => {
      if (type === 'condition') return handleCondition(inputs, ctx);
      if (type === 'loop') return handleLoop(inputs, ctx);
      ran.push({ id: ctx.stepId, inputs });
      const r = results[ctx.stepId];
      if (typeof r === 'function') return (r as (i: Record<string, unknown>) => unknown)(inputs);
      return r ?? { ok: true };
    };
    return { executeAction, ran };
  }

  function recordingHooks() {
    const rows: Array<{ id: string; status: string; error?: string }> = [];
    const hooks: ExecuteStepsDeps['hooks'] = {
      onStepResult: (s, _i, outcome) => void rows.push({ id: s.id, status: outcome.status, error: outcome.error }),
    };
    return { rows, hooks };
  }

  const ifElse = (field: string, operator: string, value?: unknown) =>
    step('c1', 'condition', { config: { field, operator, value } });

  it('runs only the branch the condition picks, then continues the main flow', async () => {
    const { runtime } = fakeRuntime();
    const { executeAction, ran } = engineWith();
    const { rows, hooks } = recordingHooks();

    const res = await executeWorkflowSteps(
      wf([
        ifElse('{{trigger.data.status}}', 'eq', 'won'),
        step('after', 'notify'),
        step('yes', 'notify', { parentBranchId: 'c1_if' }),
        step('no', 'notify', { parentBranchId: 'c1_if_not' }),
      ]),
      runContext({ triggerData: { data: { status: 'won' } } }),
      { runtime, executeAction, hooks },
    );

    expect(res.status).toBe('completed');
    expect(ran.map((r) => r.id)).toEqual(['yes', 'after']);
    expect(rows).toEqual(
      expect.arrayContaining([
        { id: 'c1', status: 'completed', error: undefined },
        { id: 'no', status: 'skipped', error: undefined },
        { id: 'yes', status: 'completed', error: undefined },
      ]),
    );
  });

  it('takes the If false branch, and nested branches only run when their parent does', async () => {
    const { runtime } = fakeRuntime();
    const { executeAction, ran } = engineWith();
    const { rows, hooks } = recordingHooks();

    await executeWorkflowSteps(
      wf([
        ifElse('{{trigger.amount}}', 'gt', 100),
        step('big', 'notify', { parentBranchId: 'c1_if' }),
        step('c2', 'condition', { parentBranchId: 'c1_if', config: { field: 'x', operator: 'eq', value: 'x' } }),
        step('big-x', 'notify', { parentBranchId: 'c2_if' }),
        step('small', 'notify', { parentBranchId: 'c1_if_not' }),
      ]),
      runContext({ triggerData: { amount: 20 } }),
      { runtime, executeAction, hooks },
    );

    expect(ran.map((r) => r.id)).toEqual(['small']);
    const skipped = rows.filter((r) => r.status === 'skipped').map((r) => r.id);
    expect(skipped.sort()).toEqual(['big', 'big-x', 'c2']);
  });

  it('runs the matching value branch of a multi-branch condition', async () => {
    const { runtime } = fakeRuntime();
    const { executeAction, ran } = engineWith();

    await executeWorkflowSteps(
      wf([
        step('route', 'condition', {
          config: { field: '{{trigger.country}}', branches: [{ value: 'nl' }, { value: 'default' }] },
        }),
        step('dutch', 'notify', { parentBranchId: 'route_branch_nl' }),
        step('other', 'notify', { parentBranchId: 'route_branch_default' }),
      ]),
      runContext({ triggerData: { country: 'nl' } }),
      { runtime, executeAction },
    );

    expect(ran.map((r) => r.id)).toEqual(['dutch']);
  });

  it('runs a loop body once per item with loop.item / loop.index, under per-iteration durable names', async () => {
    const { runtime, doCalls } = fakeRuntime();
    const { executeAction, ran } = engineWith();
    const { rows, hooks } = recordingHooks();

    const res = await executeWorkflowSteps(
      wf([
        step('l1', 'loop', { config: { items: '{{trigger.lines}}' } }),
        step('each', 'notify', {
          parentBranchId: 'l1_each',
          config: { text: '{{loop.index}}: {{loop.item.sku}}' },
        }),
        step('after', 'notify'),
      ]),
      runContext({ triggerData: { lines: [{ sku: 'A' }, { sku: 'B' }] } }),
      { runtime, executeAction, hooks },
    );

    expect(res.status).toBe('completed');
    expect(ran.map((r) => [r.id, r.inputs.text])).toEqual([
      ['each', '0: A'],
      ['each', '1: B'],
      ['after', undefined],
    ]);
    expect(doCalls).toContain('step-1-each-i0-attempt-1');
    expect(doCalls).toContain('step-1-each-i1-attempt-1');
    // One row for the body step (all iterations), one for the loop.
    expect(rows.filter((r) => r.id === 'each')).toEqual([{ id: 'each', status: 'completed', error: undefined }]);
    expect(res.output.l1).toEqual({ count: 2, iterations: 2 });
  });

  it('fails the loop (and the run) when a body step fails, naming the item', async () => {
    const { runtime } = fakeRuntime();
    const { executeAction } = engineWith({
      each: (inputs: Record<string, unknown>) => {
        if (inputs.n === 2) throw new NonRetryableStepError('bad item');
        return { ok: true };
      },
    });
    const { rows, hooks } = recordingHooks();

    const res = await executeWorkflowSteps(
      wf([
        step('l1', 'loop', { config: { items: [1, 2, 3] } }),
        step('each', 'notify', { parentBranchId: 'l1_each', config: { n: '{{loop.item}}' } }),
        step('after', 'notify'),
      ]),
      runContext(),
      { runtime, executeAction, hooks },
    );

    expect(res.status).toBe('failed');
    expect(res.error).toEqual({ stepId: 'l1', message: 'Item 2: bad item' });
    expect(rows.find((r) => r.id === 'each')).toMatchObject({ status: 'failed', error: 'bad item' });
  });

  it('carries on past a failed loop when the loop step continues on error', async () => {
    const { runtime } = fakeRuntime();
    const { executeAction, ran } = engineWith({
      each: () => {
        throw new NonRetryableStepError('nope');
      },
    });

    const res = await executeWorkflowSteps(
      wf([
        step('l1', 'loop', { config: { items: [1] }, continueOnError: true }),
        step('each', 'notify', { parentBranchId: 'l1_each' }),
        step('after', 'notify'),
      ]),
      runContext(),
      { runtime, executeAction },
    );

    expect(res.status).toBe('completed');
    expect(ran.map((r) => r.id)).toContain('after');
  });

  it('sleeps inside a loop body under per-iteration names', async () => {
    const { runtime, sleeps } = fakeRuntime();
    const { executeAction } = engineWith({ wait: { __delayMs: 1000 } });

    await executeWorkflowSteps(
      wf([
        step('l1', 'loop', { config: { items: ['a', 'b'] } }),
        step('wait', 'delay', { parentBranchId: 'l1_each' }),
      ]),
      runContext(),
      { runtime, executeAction },
    );

    expect(sleeps.map((s) => s.name)).toEqual(['delay-1-i0', 'delay-1-i1']);
  });

  it('refuses a step that waits for input inside a branch', async () => {
    const { runtime } = fakeRuntime();
    const { executeAction } = engineWith({ ask: { __waitingForInput: true, stepType: 'collect_input' } });

    const res = await executeWorkflowSteps(
      wf([ifElse('a', 'eq', 'a'), step('ask', 'collect_input', { parentBranchId: 'c1_if' })]),
      runContext(),
      { runtime, executeAction },
    );

    expect(res.status).toBe('failed');
    expect(res.error?.stepId).toBe('ask');
  });

  it('calls onComplete exactly once, also when a branch step fails', async () => {
    const { runtime } = fakeRuntime();
    const { executeAction } = engineWith({
      boom: () => {
        throw new NonRetryableStepError('x');
      },
    });
    const onComplete = vi.fn();

    await executeWorkflowSteps(
      wf([ifElse('a', 'eq', 'a'), step('boom', 'notify', { parentBranchId: 'c1_if' })]),
      runContext(),
      { runtime, executeAction, hooks: { onComplete } },
    );

    expect(onComplete).toHaveBeenCalledOnce();
    expect(onComplete.mock.calls[0][0].status).toBe('failed');
  });
});
