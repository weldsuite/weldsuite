/**
 * Billing-worker HTTP client helpers.
 *
 * Browser clients must not call billing-worker directly — phone subscription
 * reads and credit topup checkout are proxied through app-api routes that
 * forward the caller's Clerk JWT. Telephony/porting already used the same
 * pattern server-side; this module is the shared home for it.
 *
 * Stripe webhooks and the phone/credit write implementations stay on
 * billing-worker; app-api only forwards authenticated browser/server calls.
 */

import type { Context } from 'hono';
import type { Env, Variables } from '../types';

/** Production custom domain from apps/workers/billing-worker/wrangler.toml. */
export const BILLING_WORKER_PRODUCTION_URL = 'https://billing-worker.weldsuite.org';

/**
 * Resolve the billing-worker base URL for the current environment.
 * Production host matches wrangler.toml (`billing-worker.weldsuite.org`).
 */
export function billingWorkerUrl(env: Pick<Env, 'ENVIRONMENT'>): string {
  return env.ENVIRONMENT === 'production' || env.ENVIRONMENT === 'preview'
    ? BILLING_WORKER_PRODUCTION_URL
    : 'http://localhost:8788';
}

type AppContext = Context<{ Bindings: Env; Variables: Variables }>;

export type CallBillingWorkerInit = {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
};

/**
 * Forward a request to billing-worker, preserving the caller's Clerk
 * Authorization header so billing-worker re-verifies the JWT (not M2M).
 *
 * `path` is the full worker path, e.g. `/api/billing/phone/subscription`.
 */
export async function callBillingWorker(
  c: AppContext,
  path: string,
  init: CallBillingWorkerInit = {},
): Promise<Response> {
  const authHeader = c.req.header('Authorization');
  const method = init.method ?? (init.body !== undefined ? 'POST' : 'GET');

  return fetch(`${billingWorkerUrl(c.env)}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(authHeader ? { Authorization: authHeader } : {}),
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
}
