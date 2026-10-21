/**
 * Postgres error-code predicates.
 *
 * Drizzle wraps driver errors in a `DrizzleQueryError`, so the `code` lives on
 * `cause`, not on the thrown error. A top-level-only check — the shape most
 * hand-rolled `err.code === '23505'` guards take — silently never matches,
 * which is worse than having no guard at all: the error looks handled and
 * still surfaces as a 500.
 *
 * These walk the cause chain instead.
 */

/** unique_violation — a UNIQUE index or constraint rejected the write. */
export const UNIQUE_VIOLATION = '23505';
/** undefined_table — the relation does not exist (e.g. migration not yet run). */
export const UNDEFINED_TABLE = '42P01';
/** foreign_key_violation */
export const FOREIGN_KEY_VIOLATION = '23503';
/**
 * read_only_sql_transaction: a write reached a database set read-only. A
 * database move does that to the source once it has locked it (TASK-1150).
 */
export const READ_ONLY_SQL_TRANSACTION = '25006';
/**
 * invalid_password: the role's password no longer matches. A database move
 * rotates the source role's password, so a request still holding the old
 * connection URL fails with this (TASK-1150).
 */
export const INVALID_PASSWORD = '28P01';

/** Does `err`, or anything in its cause chain, carry this Postgres error code? */
export function hasPgErrorCode(err: unknown, code: string): boolean {
  let current: unknown = err;
  for (let depth = 0; current && depth < 5; depth++) {
    if (typeof current === 'object' && (current as { code?: string }).code === code) {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

export function isUniqueViolation(err: unknown): boolean {
  return hasPgErrorCode(err, UNIQUE_VIOLATION);
}

export function isMissingTable(err: unknown): boolean {
  return hasPgErrorCode(err, UNDEFINED_TABLE);
}

export function isForeignKeyViolation(err: unknown): boolean {
  return hasPgErrorCode(err, FOREIGN_KEY_VIOLATION);
}

/**
 * Drizzle's wrapper around a driver error. Its message is `Failed query: <sql>`
 * followed by the bound params, so it carries request data (a note that says
 * "password authentication failed" must not look like a rotated password).
 */
function isDrizzleQueryWrapper(err: object): boolean {
  const { name, message } = err as { name?: unknown; message?: unknown };
  return name === 'DrizzleQueryError' || (typeof message === 'string' && message.startsWith('Failed query:'));
}

/**
 * Does the message of an error in the cause chain match? For the errors that
 * reach us without a usable `code`: through neon-http the `NeonDbError`'s
 * `code` can be empty, while its message is Postgres's own text. Drizzle's
 * query wrapper is skipped (see {@link isDrizzleQueryWrapper}); its `cause` is
 * the driver error that counts.
 */
function messageInChainMatches(err: unknown, pattern: RegExp): boolean {
  let current: unknown = err;
  for (let depth = 0; current && depth < 5; depth++) {
    if (typeof current === 'object' && !isDrizzleQueryWrapper(current)) {
      const message = (current as { message?: unknown }).message;
      if (typeof message === 'string' && pattern.test(message)) return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/** `cannot execute INSERT in a read-only transaction` (SQLSTATE 25006). */
const READ_ONLY_TRANSACTION_MESSAGE = /in a read-only transaction/i;
/** `password authentication failed for user '…'` (SQLSTATE 28P01). */
const PASSWORD_AUTH_FAILED_MESSAGE = /password authentication failed/i;

/** A write was refused because the database is read-only (25006, or its message). */
export function isReadOnlyTransaction(err: unknown): boolean {
  return (
    hasPgErrorCode(err, READ_ONLY_SQL_TRANSACTION) || messageInChainMatches(err, READ_ONLY_TRANSACTION_MESSAGE)
  );
}

/** The role's password was rejected (28P01, or its message). */
export function isPasswordAuthFailure(err: unknown): boolean {
  return hasPgErrorCode(err, INVALID_PASSWORD) || messageInChainMatches(err, PASSWORD_AUTH_FAILED_MESSAGE);
}
