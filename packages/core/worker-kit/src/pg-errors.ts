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
