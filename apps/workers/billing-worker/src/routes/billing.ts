/**
 * Billing API Routes
 *
 * All billing read AND write operations (subscription, plans, invoices,
 * payments, limits, checkout, seats, cancel, reactivate) are
 * handled by the api-worker.
 *
 * The billing-worker handles Stripe webhooks (see webhooks.ts).
 */

import { Hono } from 'hono';
import type { Env } from '../index';

export const billingRoutes = new Hono<{
  Bindings: Env;
  Variables: {
    userId: string;
    orgId: string | null;
  };
}>();
