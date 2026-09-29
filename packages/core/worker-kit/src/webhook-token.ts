/**
 * Shared-token webhook authentication.
 *
 * For providers whose own signature scheme is unavailable or undocumented —
 * currently Cloudflare RealtimeKit (post-Dyte migration, HMAC scheme
 * undocumented) and MeetingBaas — we secure the receiver by registering the
 * webhook URL with a `?token=<secret>` value that only we and the provider
 * know, then requiring an exact, constant-time match on every inbound request.
 *
 * Optional-enforcement: when the secret env var is unset the check is skipped
 * (legacy behaviour). This mirrors the Telnyx receiver's pattern so nothing
 * breaks before the secret is set AND the webhook URL is re-registered — do
 * those two together (see each receiver's /setup or provider dashboard).
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
 * Returns true when the request is authorized. When `expected` is unset/empty
 * the check is disabled (returns true — legacy behaviour). Otherwise the
 * request's `?token=` query parameter must exactly match `expected`.
 */
export function verifyWebhookToken(c: Context, expected: string | undefined | null): boolean {
  if (!expected) return true;
  const provided = c.req.query('token') ?? '';
  return timingSafeEqualStr(provided, expected);
}
