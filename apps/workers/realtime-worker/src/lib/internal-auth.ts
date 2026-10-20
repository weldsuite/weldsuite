/**
 * Guard for the `/publish/*` routes.
 *
 * Those routes take caller-supplied workspace, room and user ids and push the
 * event to every socket connected there, so a request that reaches one without
 * proof of who it is can inject events into any tenant's live stream. The proof
 * is `REALTIME_INTERNAL_SECRET`, in the `x-internal-secret` header, required on
 * every request:
 *
 *  - from every caller: the workers publishing over their `REALTIME` service
 *    binding (via `RealtimePublisher`) as much as the HTTP callers (admin
 *    console, meeting portal, Discord bot). There is no "trusted because it came
 *    over a binding" shortcut, so nothing depends on which headers the edge
 *    does or does not set;
 *  - compared in constant time;
 *  - fail-closed: with no secret configured on this worker every publish is
 *    refused (403), never waved through.
 */

import { createMiddleware } from 'hono/factory';
import { secretMatches } from '@weldsuite/db/lib/timing-safe';
import { REALTIME_INTERNAL_SECRET_HEADER } from '@weldsuite/realtime/server';
import type { Env } from './protocol';

export const requireInternalSecret = () =>
  createMiddleware<{ Bindings: Env }>(async (c, next) => {
    const expected = c.env.REALTIME_INTERNAL_SECRET;
    if (!expected) {
      // Distinct from a forged request so a missing secret is not mistaken for an attack.
      console.error('[realtime] REALTIME_INTERNAL_SECRET is not configured; refusing /publish/*');
      return c.text('Forbidden: REALTIME_INTERNAL_SECRET not configured', 403);
    }

    if (!secretMatches(c.req.header(REALTIME_INTERNAL_SECRET_HEADER), expected)) {
      return c.text('Forbidden', 403);
    }

    await next();
  });
