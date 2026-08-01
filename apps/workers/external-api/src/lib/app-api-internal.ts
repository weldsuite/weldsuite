/**
 * Thin client for app-api's internal shared-secret surface (`/api/internal/*`).
 *
 * Used by routes whose work cannot be done locally because it depends on
 * bindings only app-api holds. The social publish/schedule routes are the
 * current callers: `publishPost` records a `pp:post:<id>` mapping in app-api's
 * WORKSPACE_CACHE KV that the PostPeer delivery webhook (which lands on app-api)
 * reads to resolve the tenant. Publishing from here directly would write that
 * mapping into a different namespace and every delivery webhook would fail to
 * reconcile, leaving posts stuck in `publishing`. Proxying keeps the PostPeer
 * key, the credit metering and the KV write in one worker.
 *
 * Auth is the same `Authorization: Bearer <INTERNAL_API_SECRET>` contract the
 * workflow-worker uses; the secret must match app-api's (ops contract).
 */

import type { Env } from '../types';

/** Production app-api origin — overridden per-env via APP_API_INTERNAL_URL. */
const DEFAULT_APP_API_URL = 'https://app-api.weldsuite.org';

export interface AppApiInternalResponse {
  status: number;
  /** Parsed JSON body, or null when the response had no/!JSON body. */
  body: { data?: unknown; error?: { code?: string; message?: string; details?: unknown } } | null;
}

/**
 * POST a JSON payload to `/api/internal<path>` on app-api.
 *
 * Never throws for HTTP-level failures — the status and parsed body are
 * returned so the caller can map them onto its own error envelope. Transport
 * failures surface as a 502 so a caller can forward something meaningful.
 */
export async function callAppApiInternal(
  env: Env,
  path: string,
  payload: Record<string, unknown>,
): Promise<AppApiInternalResponse> {
  const secret = env.INTERNAL_API_SECRET;
  if (!secret) {
    console.error('[app-api-internal] INTERNAL_API_SECRET is not configured');
    return {
      status: 503,
      body: {
        error: {
          code: 'INTERNAL_AUTH_NOT_CONFIGURED',
          message: 'Service-to-service auth is not configured',
        },
      },
    };
  }

  const base = env.APP_API_INTERNAL_URL || DEFAULT_APP_API_URL;
  const url = `${base.replace(/\/$/, '')}/api/internal${path}`;

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${secret}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error(`[app-api-internal] POST ${path} failed: ${message}`);
    return {
      status: 502,
      body: { error: { code: 'UPSTREAM_UNAVAILABLE', message: 'Upstream service unavailable' } },
    };
  }

  const text = await res.text();
  let body: AppApiInternalResponse['body'] = null;
  if (text) {
    try {
      body = JSON.parse(text) as AppApiInternalResponse['body'];
    } catch {
      console.error(
        `[app-api-internal] POST ${path} → non-JSON response (status ${res.status}): ${text.slice(0, 200)}`,
      );
    }
  }

  return { status: res.status, body };
}
