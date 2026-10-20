/**
 * Postgres error predicates. The errors are built the way they reach a worker:
 * a `NeonDbError` from neon-http, wrapped by drizzle in a `DrizzleQueryError`.
 */

import { describe, it, expect } from 'vitest';
import { NeonDbError } from '@neondatabase/serverless';
import { DrizzleQueryError } from 'drizzle-orm/errors';
import {
  INVALID_PASSWORD,
  READ_ONLY_SQL_TRANSACTION,
  hasPgErrorCode,
  isForeignKeyViolation,
  isMissingTable,
  isPasswordAuthFailure,
  isReadOnlyTransaction,
  isUniqueViolation,
} from './pg-errors';

/** A neon-http driver error; `code` is empty, as it can be over HTTP. */
function neonError(message: string, code?: string): NeonDbError {
  const err = new NeonDbError(message);
  if (code !== undefined) err.code = code;
  return err;
}

function wrapped(cause: Error, sql = 'insert into "notes" ("body") values ($1)', params: unknown[] = ['hello']) {
  return new DrizzleQueryError(sql, params, cause);
}

describe('hasPgErrorCode', () => {
  it('finds the code on the error itself and anywhere in the cause chain', () => {
    expect(hasPgErrorCode({ code: '23505' }, '23505')).toBe(true);
    expect(hasPgErrorCode(wrapped(neonError('dup', '23505')), '23505')).toBe(true);
    expect(hasPgErrorCode(wrapped(neonError('dup', '23505')), '23503')).toBe(false);
  });

  it('keeps the older predicates on the same walk', () => {
    expect(isUniqueViolation(wrapped(neonError('x', '23505')))).toBe(true);
    expect(isMissingTable(wrapped(neonError('x', '42P01')))).toBe(true);
    expect(isForeignKeyViolation(wrapped(neonError('x', '23503')))).toBe(true);
  });

  it('is false for non-errors', () => {
    for (const value of [null, undefined, 'password authentication failed', 42]) {
      expect(hasPgErrorCode(value, '23505')).toBe(false);
    }
  });
});

describe('isReadOnlyTransaction', () => {
  it('matches SQLSTATE 25006 on the error or its cause', () => {
    expect(READ_ONLY_SQL_TRANSACTION).toBe('25006');
    expect(isReadOnlyTransaction({ code: '25006' })).toBe(true);
    expect(isReadOnlyTransaction(wrapped(neonError('boom', '25006')))).toBe(true);
  });

  it('matches the message when neon-http leaves the code empty', () => {
    const err = wrapped(neonError('cannot execute INSERT in a read-only transaction'));
    expect(isReadOnlyTransaction(err)).toBe(true);
    expect(isReadOnlyTransaction(neonError('cannot execute UPDATE in a read-only transaction', ''))).toBe(true);
  });

  it('is false for other database errors', () => {
    expect(isReadOnlyTransaction(wrapped(neonError('duplicate key value', '23505')))).toBe(false);
    expect(isReadOnlyTransaction(new Error('boom'))).toBe(false);
    expect(isReadOnlyTransaction(undefined)).toBe(false);
  });

  it('ignores the query text drizzle puts in its own message', () => {
    // A note whose body says so must not make the write look like a move.
    const err = wrapped(
      neonError('duplicate key value violates unique constraint "notes_pkey"', '23505'),
      'insert into "notes" ("body") values ($1)',
      ['cannot execute INSERT in a read-only transaction'],
    );
    expect(isReadOnlyTransaction(err)).toBe(false);
  });
});

describe('isPasswordAuthFailure', () => {
  it('matches SQLSTATE 28P01 on the error or its cause', () => {
    expect(INVALID_PASSWORD).toBe('28P01');
    expect(isPasswordAuthFailure({ code: '28P01' })).toBe(true);
    expect(isPasswordAuthFailure(wrapped(neonError('boom', '28P01')))).toBe(true);
  });

  it('matches the message when neon-http leaves the code empty', () => {
    const message = `password authentication failed for user 'tenant_role'`;
    expect(isPasswordAuthFailure(wrapped(neonError(message)))).toBe(true);
    expect(isPasswordAuthFailure(neonError(message, ''))).toBe(true);
    expect(isPasswordAuthFailure(new Error(message))).toBe(true);
  });

  it('is false for other database errors and other auth-looking text', () => {
    expect(isPasswordAuthFailure(wrapped(neonError('duplicate key value', '23505')))).toBe(false);
    expect(isPasswordAuthFailure(new Error('Unauthorized'))).toBe(false);
    expect(isPasswordAuthFailure(null)).toBe(false);
  });

  it('ignores the params drizzle puts in its own message', () => {
    const err = wrapped(neonError('value too long for type character varying(10)', '22001'), 'insert into "notes" ("body") values ($1)', [
      'password authentication failed',
    ]);
    expect(isPasswordAuthFailure(err)).toBe(false);
  });

  it('is not fooled by a cyclic cause chain', () => {
    const a: { message: string; cause?: unknown } = { message: 'a' };
    const b: { message: string; cause?: unknown } = { message: 'b', cause: a };
    a.cause = b;
    expect(isPasswordAuthFailure(a)).toBe(false);
    expect(isReadOnlyTransaction(a)).toBe(false);
  });
});
