import 'server-only';

import type { AdminIdentity } from './auth';
import type { SnapshotState, StripeSnapshot } from './billing-types';

/**
 * Server-only client for the billing worker's admin API
 * (apps/workers/billing-worker/src/routes/admin.ts). Billing changes run in
 * the worker, which holds the Stripe and platform-Clerk keys; this console only
 * holds the shared BILLING_ADMIN_SECRET and passes the signed-in admin along,
 * so every change is attributed in the worker's audit trail.
 */

/** `details` is the worker's structured error payload (e.g. the countries of a TERRITORY_CONFLICT). */
export type WorkerResult<T> = { ok: true; data: T } | { ok: false; error: string; code?: string; details?: unknown };

const TIMEOUT_MS = 25_000;

function config(): { baseUrl: string; secret: string } | null {
  const baseUrl = process.env.BILLING_WORKER_URL?.replace(/\/+$/, '');
  const secret = process.env.BILLING_ADMIN_SECRET;
  if (!baseUrl || !secret) return null;
  return { baseUrl, secret };
}

export function isBillingWorkerConfigured(): boolean {
  return config() !== null;
}

export async function callBillingWorker<T>(
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  path: string,
  options: { identity: AdminIdentity; body?: unknown; requestId?: string },
): Promise<WorkerResult<T>> {
  const cfg = config();
  if (!cfg) {
    return { ok: false, code: 'NOT_CONFIGURED', error: 'The billing worker is not configured for this console.' };
  }

  const headers: Record<string, string> = {
    'x-admin-secret': cfg.secret,
    'x-admin-email': options.identity.email,
    'x-admin-user-id': options.identity.userId,
  };
  if (options.requestId) headers['x-request-id'] = options.requestId;
  if (options.body !== undefined) headers['content-type'] = 'application/json';

  let res: Response;
  try {
    res = await fetch(`${cfg.baseUrl}/api/internal/admin${path}`, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      cache: 'no-store',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    return {
      ok: false,
      code: 'UNREACHABLE',
      error: err instanceof Error ? err.message : 'The billing worker could not be reached.',
    };
  }

  // 204 No Content (deletes) has no body.
  if (res.status === 204) return { ok: true, data: undefined as T };

  const payload = (await res.json().catch(() => null)) as
    | { data?: T; error?: { code?: string; message?: string; details?: unknown } }
    | null;
  if (res.ok && payload && 'data' in payload) return { ok: true, data: payload.data as T };
  return {
    ok: false,
    details: payload?.error?.details,
    // No error body on a 5xx means the worker itself failed, possibly after
    // Stripe already did the work: report it as ambiguous (UPSTREAM).
    code: payload?.error?.code ?? (res.status >= 500 ? 'UPSTREAM' : undefined),
    error: payload?.error?.message ?? `The billing worker answered ${res.status}.`,
  };
}

/** Live Stripe state for the workspace screen; never throws. */
export async function loadStripeSnapshot(identity: AdminIdentity, workspaceId: string): Promise<SnapshotState> {
  if (!isBillingWorkerConfigured()) return { kind: 'not_configured' };
  const result = await callBillingWorker<StripeSnapshot>(
    'GET',
    `/workspaces/${encodeURIComponent(workspaceId)}/stripe`,
    { identity },
  );
  if (result.ok) return { kind: 'ok', snapshot: result.data };
  if (result.code === 'NOT_CONFIGURED') return { kind: 'not_configured' };
  return { kind: 'error', message: result.error };
}
