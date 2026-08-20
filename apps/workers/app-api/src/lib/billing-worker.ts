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

/** Bound how long app-api waits on billing-worker before aborting. */
export const BILLING_WORKER_TIMEOUT_MS = 10_000;

/**
 * Resolve the billing-worker base URL for the current environment.
 * Production host matches wrangler.toml (`billing-worker.weldsuite.org`).
 */
export function billingWorkerUrl(env: Pick<Env, 'ENVIRONMENT'>): string {
  return env.ENVIRONMENT === 'production' || env.ENVIRONMENT === 'preview'
    ? BILLING_WORKER_PRODUCTION_URL
    : 'http://localhost:8788';
}

/**
 * Whether it is safe to forward a bearer token to `baseUrl`.
 *
 * Only HTTPS (production / preview / any TLS endpoint) gets the caller's
 * Authorization header. The local wrangler URL is plain HTTP — never send
 * Clerk JWTs over cleartext, even on loopback (CWE-319).
 */
export function canForwardAuthorization(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).protocol === 'https:';
  } catch {
    return false;
  }
}

export type FetchBillingWorkerInit = {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  authorization?: string | null;
  timeoutMs?: number;
  /** Injectable for tests. Defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
};

/**
 * Forward a request to billing-worker without a Hono context.
 * Uses AbortController so a stalled upstream cannot hold the Worker open.
 */
export async function fetchBillingWorker(
  env: Pick<Env, 'ENVIRONMENT'>,
  path: string,
  init: FetchBillingWorkerInit = {},
): Promise<Response> {
  const method = init.method ?? (init.body !== undefined ? 'POST' : 'GET');
  const timeoutMs = init.timeoutMs ?? BILLING_WORKER_TIMEOUT_MS;
  const fetchImpl = init.fetchImpl ?? fetch;
  const baseUrl = billingWorkerUrl(env);
  const forwardAuth =
    Boolean(init.authorization) && canForwardAuthorization(baseUrl);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetchImpl(`${baseUrl}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(forwardAuth && init.authorization
          ? { Authorization: init.authorization }
          : {}),
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

type AppContext = Context<{ Bindings: Env; Variables: Variables }>;

export type CallBillingWorkerInit = {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  timeoutMs?: number;
};

/**
 * Forward a request to billing-worker. On HTTPS targets the caller's Clerk
 * Authorization header is preserved so billing-worker re-verifies the JWT
 * (not M2M). Cleartext local URLs never receive the bearer token.
 *
 * `path` is the full worker path, e.g. `/api/billing/phone/subscription`.
 */
export async function callBillingWorker(
  c: AppContext,
  path: string,
  init: CallBillingWorkerInit = {},
): Promise<Response> {
  return fetchBillingWorker(c.env, path, {
    method: init.method,
    body: init.body,
    authorization: c.req.header('Authorization'),
    timeoutMs: init.timeoutMs,
  });
}
