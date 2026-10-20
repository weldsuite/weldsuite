/**
 * Shared-token webhook authentication.
 *
 * For providers without a usable signature scheme (currently Realtime
 * Register, and the operator-only RealtimeKit /setup route) we secure the receiver by registering the webhook URL
 * with a `?token=<secret>` value that only we and the provider know, then
 * requiring an exact, constant-time match on every inbound request.
 *
 * Fail-closed: when the secret env var is unset every request is rejected.
 * Callers should log the missing secret distinctly so a misconfiguration is
 * not mistaken for forged traffic.
 */

import type { Context } from 'hono';
import { secretMatches, timingSafeEqualStr } from '@weldsuite/db/lib/timing-safe';

// The one constant-time compare for shared secrets. Re-exported here so every
// API worker keeps importing it from `@weldsuite/worker-kit/webhook-token`
// (and from the kit's index); the implementation lives in
// `@weldsuite/db/lib/timing-safe` so workers that don't use the kit
// (realtime-worker) share it instead of carrying a copy.
export { secretMatches, timingSafeEqualStr };

/**
 * Returns true when the request is authorized: the request's `?token=` query
 * parameter must exactly match `expected`. Returns false when `expected` is
 * unset/empty — an unconfigured secret never authorizes anything.
 */
export function verifyWebhookToken(c: Context, expected: string | undefined | null): boolean {
  return secretMatches(c.req.query('token'), expected);
}
