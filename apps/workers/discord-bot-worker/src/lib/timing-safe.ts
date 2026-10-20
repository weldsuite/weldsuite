/**
 * Constant-time comparison of a presented secret against the configured one.
 *
 * `a === b` stops at the first differing byte, so response time leaks how long
 * a correct prefix is. Same algorithm as `@weldsuite/db/lib/timing-safe`, which
 * every other worker imports; this worker has no workspace dependencies, so it
 * carries the few lines instead of taking one on.
 *
 * Fail-closed: an unset/empty `expected` or an empty `provided` never matches.
 */
export function secretMatches(provided: string | null | undefined, expected: string | null | undefined): boolean {
  if (!expected || !provided) return false;
  const enc = new TextEncoder();
  const a = enc.encode(provided);
  const b = enc.encode(expected);
  // Compare over the longer length so a length mismatch does not short-circuit.
  let diff = a.length ^ b.length;
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  }
  return diff === 0;
}
