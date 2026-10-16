/**
 * Helpers for case-insensitive "contains" search (ILIKE).
 *
 * `%` and `_` are LIKE wildcards: user input must be escaped or typing "50%"
 * matches everything and "a_c" matches "abc". Postgres' default LIKE escape
 * character is the backslash, so that is what is escaped here.
 */

/** Escape the LIKE wildcards (`%`, `_`) and the escape character itself. */
export function escapeLikePattern(input: string): string {
  return input.replace(/[\\%_]/g, '\\$&');
}

/** `%term%` for an ILIKE "contains" match, with the user's wildcards escaped. */
export function containsPattern(term: string): string {
  return `%${escapeLikePattern(term)}%`;
}
