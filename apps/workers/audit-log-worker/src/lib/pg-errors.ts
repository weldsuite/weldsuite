/**
 * Postgres error predicates for the one failure this worker must not drop an
 * event over: its tenant database is locked by a database move (TASK-1150, ADR
 * DATA-016).
 *
 * A move first rotates the old database's role password (every cached URL then
 * fails with 28P01, `password authentication failed`) and then makes the
 * database read-only (writes fail with 25006, `read-only transaction`). Both
 * last until the move switches the workspace to its new database (or is undone),
 * so the right answer to either is to try again later, not to give up.
 *
 * The predicates walk the `cause` chain (Drizzle wraps the driver error) and
 * also match the message text, because through neon-http the `NeonDbError.code`
 * can be empty. They only ever return a boolean: Drizzle's `Failed query: <sql>`
 * wrapper (SQL plus bound parameters, so event contents) is never read.
 */

const MAX_CAUSE_DEPTH = 5;

function isDrizzleQueryWrapper(err: object): boolean {
  const { name, message } = err as { name?: unknown; message?: unknown };
  return name === 'DrizzleQueryError' || (typeof message === 'string' && message.startsWith('Failed query:'));
}

function hasPgErrorCode(err: unknown, code: string): boolean {
  let current: unknown = err;
  for (let depth = 0; current && depth < MAX_CAUSE_DEPTH; depth++) {
    if (typeof current === 'object' && (current as { code?: unknown }).code === code) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
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

/** The role's password was rejected (28P01, or its message): the move rotated it. */
export function isPasswordAuthFailure(err: unknown): boolean {
  return hasPgErrorCode(err, '28P01') || messageInChainMatches(err, /password authentication failed/i);
}

/** A write was refused because the database is read-only (25006, or its message): the move locked it. */
export function isReadOnlyTransaction(err: unknown): boolean {
  return hasPgErrorCode(err, '25006') || messageInChainMatches(err, /in a read-only transaction/i);
}

/** Is this the signature of a tenant database locked by a move: worth trying again later. */
export function isTenantLockedError(err: unknown): boolean {
  return isPasswordAuthFailure(err) || isReadOnlyTransaction(err);
}
