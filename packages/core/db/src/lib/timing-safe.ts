/**
 * Constant-time comparison of shared secrets (bearer tokens, internal
 * secrets, webhook tokens).
 *
 * `a === b` / `a !== b` stops at the first differing byte, so response time
 * tells an attacker how long a correct prefix of the secret is. Every check of
 * a shared secret in the workers goes through these helpers instead.
 *
 * Import as `@weldsuite/db/lib/timing-safe` (a leaf module with no database
 * imports) or, in an API worker, through `@weldsuite/worker-kit/webhook-token`,
 * which re-exports it. It lives here because `@weldsuite/db` is the one
 * package every worker (realtime-worker included) already depends on.
 */

/**
 * Constant-time string comparison. Compares over the longer of the two lengths
 * so a length mismatch does not short-circuit and leak timing.
 */
export function timingSafeEqualStr(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  let diff = ab.length ^ bb.length;
  const len = Math.max(ab.length, bb.length);
  for (let i = 0; i < len; i++) {
    diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  }
  return diff === 0;
}

/**
 * Fail-closed shared-secret check: true only when a secret is configured
 * (`expected` is non-empty) AND `provided` equals it in constant time. An unset
 * or empty `expected` never authorizes anything, and neither does a missing
 * `provided`, so `undefined === undefined` can't open a route whose secret was
 * never configured.
 */
export function secretMatches(
  provided: string | null | undefined,
  expected: string | null | undefined,
): boolean {
  if (!expected || !provided) return false;
  return timingSafeEqualStr(provided, expected);
}
