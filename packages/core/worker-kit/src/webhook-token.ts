/**
 * Shared-token webhook authentication.
 *
 * For providers without a usable signature scheme (currently MeetingBaas and
 * Realtime Register) we secure the receiver by registering the webhook URL
 * with a `?token=<secret>` value that only we and the provider know, then
 * requiring an exact, constant-time match on every inbound request.
 *
 * Fail-closed: when the secret env var is unset every request is rejected.
 * Callers should log the missing secret distinctly so a misconfiguration is
 * not mistaken for forged traffic.
 */

import type { Context } from 'hono';

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
 * Returns true when the request is authorized: the request's `?token=` query
 * parameter must exactly match `expected`. Returns false when `expected` is
 * unset/empty — an unconfigured secret never authorizes anything.
 */
export function verifyWebhookToken(c: Context, expected: string | undefined | null): boolean {
  if (!expected) return false;
  const provided = c.req.query('token') ?? '';
  return timingSafeEqualStr(provided, expected);
}
