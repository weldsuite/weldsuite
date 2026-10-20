/**
 * Postgres error predicates for the move Workflow.
 *
 * `@weldsuite/worker-kit` has the same predicates (`pg-errors.ts`), but this
 * worker does not depend on it, so the few it needs live here. They walk the
 * `cause` chain (Drizzle wraps driver errors) and also match Postgres's message
 * text, because through neon-http the `NeonDbError.code` can be empty.
 *
 * Nothing here reads or returns an error message that could carry request
 * data: Drizzle's `Failed query: <sql>` wrapper (SQL plus bound params, so row
 * contents) is skipped, and the helpers only ever return an SQLSTATE or a
 * boolean.
 */

export const UNIQUE_VIOLATION = '23505';
/** invalid_password: the role's password no longer matches (the lock rotates it). */
export const INVALID_PASSWORD = '28P01';

const SQLSTATE = /^(?=.*\d)[0-9A-Z]{5}$/;
const MAX_CAUSE_DEPTH = 5;

function isDrizzleQueryWrapper(err: object): boolean {
  const { name, message } = err as { name?: unknown; message?: unknown };
  return name === 'DrizzleQueryError' || (typeof message === 'string' && message.startsWith('Failed query:'));
}

/** Does `err`, or anything in its cause chain, carry this SQLSTATE? */
export function hasPgErrorCode(err: unknown, code: string): boolean {
  let current: unknown = err;
  for (let depth = 0; current && depth < MAX_CAUSE_DEPTH; depth++) {
    if (typeof current === 'object' && (current as { code?: unknown }).code === code) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/** The first SQLSTATE found in the cause chain, if any. */
export function sqlStateOf(err: unknown): string | undefined {
  let current: unknown = err;
  for (let depth = 0; current && depth < MAX_CAUSE_DEPTH; depth++) {
    if (typeof current === 'object') {
      const code = (current as { code?: unknown }).code;
      if (typeof code === 'string' && SQLSTATE.test(code)) return code;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

function messageInChainMatches(err: unknown, pattern: RegExp): boolean {
  let current: unknown = err;
  for (let depth = 0; current && depth < MAX_CAUSE_DEPTH; depth++) {
    if (typeof current === 'object' && !isDrizzleQueryWrapper(current)) {
      const message = (current as { message?: unknown }).message;
      if (typeof message === 'string' && pattern.test(message)) return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

export function isUniqueViolation(err: unknown): boolean {
  return hasPgErrorCode(err, UNIQUE_VIOLATION);
}

/** The role's password was rejected (28P01, or its message). */
export function isPasswordAuthFailure(err: unknown): boolean {
  return hasPgErrorCode(err, INVALID_PASSWORD) || messageInChainMatches(err, /password authentication failed/i);
}

/** A write was refused because the database is read-only (25006, or its message). */
export function isReadOnlyTransaction(err: unknown): boolean {
  return hasPgErrorCode(err, '25006') || messageInChainMatches(err, /in a read-only transaction/i);
}

/** Drizzle's wrapper around a driver error: its message carries SQL and bound params. */
export function isDrizzleQueryError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && isDrizzleQueryWrapper(err);
}
