import { describe, it, expect } from 'vitest';
import {
  handleSetVariable,
  handleLog,
  handleCondition,
  handleLoop,
  handleDelay,
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
  it('iterates an array, exposing item + index as variables', async () => {
    const ctx = makeActionContext({ variables: {} });
    const res = (await handleLoop({ items: ['a', 'b'], iteratorName: 'row' }, ctx)) as {
      items: unknown[];
      count: number;
    };
    expect(res.count).toBe(2);
    expect(res.items).toHaveLength(2);
    // last iteration leaves the iterator + index set
    expect(ctx.variables.row).toBe('b');
    expect(ctx.variables.rowIndex).toBe(1);
  });

  it('throws when items is not an array', async () => {
    await expect(handleLoop({ items: 'nope' }, makeActionContext())).rejects.toThrow(/array/i);
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

  it('defaults to 1000ms when no duration is given', async () => {
    expect(((await handleDelay({}, makeActionContext())) as any).__delayMs).toBe(1000);
  });
});
