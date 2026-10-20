import { describe, expect, it } from 'vitest';
import { isPasswordAuthFailure, isReadOnlyTransaction, isTenantLockedError } from './pg-errors';

function drizzleWrapper(cause: unknown): Error {
  return Object.assign(new Error('Failed query: insert into "audit_logs" values ($1) params: password authentication failed'), {
    name: 'DrizzleQueryError',
    cause,
  });
}

describe('isPasswordAuthFailure', () => {
  it('matches 28P01 anywhere in the cause chain and the Postgres message', () => {
    expect(isPasswordAuthFailure(Object.assign(new Error('x'), { code: '28P01' }))).toBe(true);
    expect(isPasswordAuthFailure(drizzleWrapper(Object.assign(new Error('x'), { code: '28P01' })))).toBe(true);
    expect(isPasswordAuthFailure(new Error('password authentication failed for user "a"'))).toBe(true);
    expect(isPasswordAuthFailure(drizzleWrapper(new Error('password authentication failed for user "a"')))).toBe(true);
  });

  it('does not read the Drizzle wrapper message (it carries the SQL and its parameters)', () => {
    // The wrapper text above contains the phrase, as an event's contents could; only the cause counts.
    expect(isPasswordAuthFailure(drizzleWrapper(new Error('duplicate key')))).toBe(false);
  });

  it('is false for anything else, including non-errors', () => {
    expect(isPasswordAuthFailure(new Error('timeout'))).toBe(false);
    expect(isPasswordAuthFailure(Object.assign(new Error('x'), { code: '23505' }))).toBe(false);
    expect(isPasswordAuthFailure(undefined)).toBe(false);
    expect(isPasswordAuthFailure('password authentication failed')).toBe(false);
  });
});

describe('isReadOnlyTransaction', () => {
  it('matches 25006 and the Postgres message', () => {
    expect(isReadOnlyTransaction(Object.assign(new Error('x'), { code: '25006' }))).toBe(true);
    expect(isReadOnlyTransaction(drizzleWrapper(Object.assign(new Error('x'), { code: '25006' })))).toBe(true);
    expect(isReadOnlyTransaction(new Error('cannot execute INSERT in a read-only transaction'))).toBe(true);
  });

  it('is false for anything else', () => {
    expect(isReadOnlyTransaction(new Error('syntax error'))).toBe(false);
    expect(isReadOnlyTransaction(null)).toBe(false);
  });

  it('stops following a cause chain that loops', () => {
    const a: { cause?: unknown; message: string } = { message: 'a' };
    a.cause = a;
    expect(isReadOnlyTransaction(a)).toBe(false);
  });
});

describe('isTenantLockedError', () => {
  it('is either of the two', () => {
    expect(isTenantLockedError(Object.assign(new Error('x'), { code: '28P01' }))).toBe(true);
    expect(isTenantLockedError(Object.assign(new Error('x'), { code: '25006' }))).toBe(true);
    expect(isTenantLockedError(new Error('connection reset'))).toBe(false);
  });
});
