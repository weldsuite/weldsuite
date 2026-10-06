import { describe, it, expect } from 'vitest';
import {
  handleSetVariable,
  handleLog,
  handleCondition,
  handleLoop,
  handleDelay,
  MAX_LOOP_ITEMS,
} from './control';
import { makeActionContext } from '../../test/ctx';

describe('set_variable', () => {
  it('writes the variable into ctx.variables and echoes it back', async () => {
    const ctx = makeActionContext({ variables: {} });
    const res = (await handleSetVariable({ name: 'count', value: 7 }, ctx)) as Record<string, unknown>;
    expect(ctx.variables.count).toBe(7);
    expect(res).toMatchObject({ set: true, name: 'count', value: 7 });
  });

  it('throws when name is missing', async () => {
    await expect(handleSetVariable({ value: 1 }, makeActionContext())).rejects.toThrow(/name/i);
  });
});

describe('log', () => {
  it('returns logged:true with the message', async () => {
    const res = (await handleLog({ message: 'hello', level: 'info' }, makeActionContext())) as Record<
      string,
      unknown
    >;
    expect(res).toMatchObject({ logged: true, message: 'hello' });
  });
});

describe('condition action', () => {
  it('passes when the predicate holds and returns the field value', async () => {
    const ctx = makeActionContext({ triggerData: { status: 'open' } });
    const res = (await handleCondition(
      { field: 'trigger.status', operator: 'eq', value: 'open' },
      ctx,
    )) as Record<string, unknown>;
    expect(res.passed).toBe(true);
    expect(res.result).toBe('open');
  });

  it('reads loop.item / loop.index from the context', async () => {
    const ctx = makeActionContext({ loopItem: { id: 'x' }, loopIndex: 2 });
    const res = (await handleCondition({ field: 'loop.index', operator: 'eq', value: 2 }, ctx)) as Record<
      string,
      unknown
    >;
    expect(res.passed).toBe(true);
  });

  it('does not pass when the predicate is false', async () => {
    const ctx = makeActionContext({ variables: { n: 1 } });
    const res = (await handleCondition({ field: 'variables.n', operator: 'gt', value: 5 }, ctx)) as Record<
      string,
      unknown
    >;
    expect(res.passed).toBe(false);
  });
});

describe('loop', () => {
  it('returns the validated items for the engine to run the body over', async () => {
    const res = (await handleLoop({ items: ['a', 'b'] }, makeActionContext())) as { items: unknown[]; count: number };
    expect(res).toEqual({ items: ['a', 'b'], count: 2 });
  });

  it('treats an empty or unresolved list as zero items', async () => {
    expect(await handleLoop({ items: '' }, makeActionContext())).toEqual({ items: [], count: 0 });
    expect(await handleLoop({}, makeActionContext())).toEqual({ items: [], count: 0 });
  });

  it('accepts a JSON array string', async () => {
    expect(await handleLoop({ items: '[1,2,3]' }, makeActionContext())).toEqual({ items: [1, 2, 3], count: 3 });
  });

  it('rejects a value that is not a list, without retrying', async () => {
    await expect(handleLoop({ items: 'nope' }, makeActionContext())).rejects.toMatchObject({
      name: 'NonRetryableStepError',
    });
  });

  it('rejects more items than a loop may run over', async () => {
    const items = Array.from({ length: MAX_LOOP_ITEMS + 1 }, (_, i) => i);
    await expect(handleLoop({ items }, makeActionContext())).rejects.toThrow(/at most 100/);
  });
});

describe('condition operators', () => {
  const check = (operator: string, field: unknown, value?: unknown) =>
    handleCondition({ field, operator, value }, makeActionContext()) as Promise<{ passed: boolean }>;

  it('compares resolved template values loosely across strings and numbers', async () => {
    expect((await check('eq', 5, '5')).passed).toBe(true);
    expect((await check('ne', 'open', 'closed')).passed).toBe(true);
    expect((await check('gt', '10', 9)).passed).toBe(true);
    expect((await check('lte', 3, '3')).passed).toBe(true);
    expect((await check('gt', 'abc', 1)).passed).toBe(false);
  });

  it('supports the text, emptiness, list and regex operators the editor offers', async () => {
    expect((await check('contains', 'Hello World', 'world')).passed).toBe(true);
    expect((await check('contains', ['a', 'b'], 'b')).passed).toBe(true);
    expect((await check('startswith', 'Invoice 12', 'invoice')).passed).toBe(true);
    expect((await check('endswith', 'report.pdf', '.PDF')).passed).toBe(true);
    expect((await check('isEmpty', '')).passed).toBe(true);
    expect((await check('isEmpty', [])).passed).toBe(true);
    expect((await check('isNotEmpty', 'x')).passed).toBe(true);
    expect((await check('in', 'nl', 'be, nl, de')).passed).toBe(true);
    expect((await check('regex', 'ORD-123', '^ORD-[0-9]+$')).passed).toBe(true);
  });

  it('accepts older operator names', async () => {
    expect((await check('neq', 1, 2)).passed).toBe(true);
    expect((await check('starts_with', 'abc', 'a')).passed).toBe(true);
    expect((await check('not_exists', null)).passed).toBe(true);
  });

  it('fails the step on an unknown operator or an invalid regex instead of passing', async () => {
    await expect(check('fuzzy', 1, 1)).rejects.toMatchObject({ name: 'NonRetryableStepError' });
    await expect(check('regex', 'x', '(')).rejects.toMatchObject({ name: 'NonRetryableStepError' });
  });

  it('picks the matching value branch, falling back to default', async () => {
    const branches = [{ value: 'nl' }, { value: 'be' }, { value: 'default' }];
    expect(await handleCondition({ field: 'be', branches }, makeActionContext())).toMatchObject({ matchedBranch: 'be' });
    expect(await handleCondition({ field: 'fr', branches }, makeActionContext())).toMatchObject({
      matchedBranch: 'default',
    });
    expect(
      await handleCondition({ field: 'fr', branches: [{ value: 'nl' }] }, makeActionContext()),
    ).toMatchObject({ matchedBranch: null });
  });
});

describe('delay', () => {
  it('computes durationMs from seconds and exposes the __delayMs sentinel', async () => {
    const res = (await handleDelay({ seconds: 5 }, makeActionContext())) as Record<string, unknown>;
    expect(res.__delayMs).toBe(5000);
    expect(res.delayed).toBe(true);
  });

  it('supports minutes / hours / days and a raw ms duration', async () => {
    expect(((await handleDelay({ minutes: 2 }, makeActionContext())) as any).__delayMs).toBe(120000);
    expect(((await handleDelay({ hours: 1 }, makeActionContext())) as any).__delayMs).toBe(3600000);
    expect(((await handleDelay({ days: 1 }, makeActionContext())) as any).__delayMs).toBe(86400000);
    expect(((await handleDelay({ ms: 250 }, makeActionContext())) as any).__delayMs).toBe(250);
  });

  it('rejects a negative or over-long wait', async () => {
    await expect(handleDelay({ ms: -5 }, makeActionContext())).rejects.toMatchObject({ name: 'NonRetryableStepError' });
    await expect(handleDelay({ days: 400 }, makeActionContext())).rejects.toThrow(/365 days/);
  });

  it('defaults to 1000ms when no duration is given', async () => {
    expect(((await handleDelay({}, makeActionContext())) as any).__delayMs).toBe(1000);
  });
});
