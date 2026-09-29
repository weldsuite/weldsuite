/**
 * Internal service-to-service telephony routes — `/api/internal/telephony/*`.
 *
 * Moved here from app-api's internal router (routes/internal/index.ts) with
 * the rest of the call module; @weldsuite/api-modules gives call the
 * `/api/internal/telephony` prefix (longest prefix wins over core's
 * `/api/internal`), so app-api's forwarder hands these calls to this worker.
 *
 * Caller: billing-worker's paid phone-number fulfilment
 * (apps/workers/billing-worker/src/lib/phone-fulfill.ts), over its
 * `CALL_INTERNAL` binding to the `CallInternal` entrypoint (no secret).
 *
 * The PUBLIC mount (registered BEFORE the global /api/* Clerk guard in
 * src/index.ts, reached through app-api's forwarder) stays until every caller
 * uses the entrypoint; it authenticates in-route via a shared-secret bearer:
 * `Authorization: Bearer <INTERNAL_API_SECRET>`, identical to app-api's
 * internal router. The caller's INTERNAL_API_SECRET must match this worker's
 * (ops contract) while it does.
 *
 * Response shapes intentionally preserve the LEGACY internal contract
 * ({ success, ... } / { success:false, error }) rather than the app-api
 * { data }/{ error } envelope. This is a machine contract, not a
 * platform-consumed route.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import type { Env, Variables } from '../../types';

export const internalTelephonyRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

// ---------------------------------------------------------------------------
// Auth — requests through the `CallInternal` entrypoint (service binding only)
// are trusted by topology; the public mount keeps the shared INTERNAL_API_SECRET
// bearer on every route until all callers use the entrypoint (same check as
// app-api's routes/internal/index.ts).
// ---------------------------------------------------------------------------

internalTelephonyRoutes.use('*', async (c, next) => {
  if (c.get('internalTrusted') === true) {
    await next();
    return;
  }

  const secret = c.env.INTERNAL_API_SECRET;
  if (!secret) {
    console.error('[Internal API] INTERNAL_API_SECRET is not configured');
    return c.json({ error: 'Internal auth not configured' }, 503);
  }

  const authHeader = c.req.header('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return c.json({ error: 'Missing or invalid Authorization header' }, 401);
  }

  if (authHeader.slice(7) !== secret) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  await next();
});

const fulfillPhoneNumberSchema = z.object({
  clerkOrgId: z.string().min(1),
  phoneNumber: z.string().min(1),
  countryCode: z.string().min(2).max(5),
  numberType: z.string().min(1),
  addressId: z.string().optional(),
  displayName: z.string().optional(),
  friendlyName: z.string().optional(),
  voipPhoneNumberId: z.string().optional(),
});

internalTelephonyRoutes.post(
  '/fulfill-number',
  zValidator('json', fulfillPhoneNumberSchema),
  async (c) => {
    try {
      const { fulfillPaidPhoneNumber } = await import('../../services/phone-number-order');
      const result = await fulfillPaidPhoneNumber(c.env, c.req.valid('json'));
      return c.json({ success: true, ...result });
    } catch (err) {
      console.error('[Internal] Phone fulfill failed:', err);
      return c.json(
        { success: false, error: err instanceof Error ? err.message : 'Unknown error' },
        500,
      );
    }
  },
);
