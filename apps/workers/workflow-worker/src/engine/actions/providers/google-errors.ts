/**
 * Shared Google API error classification for every Google provider action
 * (Sheets, Gmail, Calendar) — see "Provider pattern" in
 * docs/plans/weldconnect.md. Every Discovery-based Google API (Sheets v4,
 * Calendar v3, Gmail v1) returns the same JSON error envelope:
 * `{ error: { code, message, status, errors: [{ reason, message }] } }`.
 *
 * Classification, following the engine's general 4xx-vs-5xx convention
 * (actions/http.ts):
 *   - 401                       → the token is dead even after a refresh
 *                                 attempt (token.ts already refreshes
 *                                 proactively) — reconnect, non-retryable.
 *   - 403 "insufficient scope"  → reconnect (the connection is missing a
 *     or missing-permission      scope or lost access to the resource),
 *                                 non-retryable.
 *   - 403 rate/quota limit      → Google reports per-minute quota as 403,
 *                                 not 429, for several of these APIs — treated
 *                                 as retryable like a real 429.
 *   - 403 (anything else)       → a sharing/permission problem on the specific
 *                                 resource, non-retryable.
 *   - 404                       → resource (spreadsheet, calendar, …) not
 *                                 found, non-retryable.
 *   - 429 / 5xx                 → retryable; a 429 carries the Retry-After hint.
 *   - any other 4xx             → the request itself is the problem,
 *                                 non-retryable.
 */

import { NonRetryableStepError } from '../../errors';

export interface GoogleApiError {
  code?: number;
  message?: string;
  status?: string;
  errors?: Array<{ reason?: string; message?: string; domain?: string }>;
}

/** A retryable failure that keeps the provider's raw payload for the step row. */
export class RetryableProviderError extends Error {
  readonly details?: unknown;
  constructor(message: string, details?: unknown) {
    super(message);
    this.name = 'RetryableProviderError';
    this.details = details;
  }
}

async function parseGoogleError(response: Response): Promise<GoogleApiError | undefined> {
  try {
    const json = (await response.json()) as { error?: GoogleApiError };
    return json.error;
  } catch {
    return undefined;
  }
}

const RATE_LIMIT_REASONS = ['ratelimitexceeded', 'userratelimitexceeded', 'quotaexceeded', 'dailylimitexceeded'];
const PERMISSION_REASONS = ['insufficientpermissions', 'accessnotconfigured', 'forbidden', 'permission_denied'];

/**
 * Throws the right error type for a failed Google API response — call this
 * instead of a bare `if (!res.ok) throw new Error(...)` for every Google
 * provider action. `action` is a short label prefixed to the message (e.g.
 * "Sheets append row"). Never returns.
 */
export async function throwGoogleApiError(response: Response, action: string): Promise<never> {
  const err = await parseGoogleError(response);
  const message = err?.message || response.statusText || `HTTP ${response.status}`;
  const reason = (err?.errors?.[0]?.reason || '').toLowerCase();

  if (response.status === 401) {
    throw new NonRetryableStepError(
      `${action}: the Google connection is no longer valid. Reconnect it from WeldConnect → Integrations.`,
      err,
    );
  }

  if (response.status === 403) {
    if (RATE_LIMIT_REASONS.some((r) => reason.includes(r))) {
      throw new RetryableProviderError(`${action}: Google rate/quota limit reached — ${message}`, err);
    }
    if (PERMISSION_REASONS.some((r) => reason.includes(r)) || /insufficient|permission/i.test(message)) {
      throw new NonRetryableStepError(
        `${action}: the Google connection is missing a required permission, or can't access this resource. Reconnect it from WeldConnect → Integrations, or check sharing on the resource.`,
        err,
      );
    }
    // An unrecognised 403 is still the request's problem (most likely access
    // to the specific resource) — retrying the exact same request won't help.
    throw new NonRetryableStepError(`${action}: ${message}`, err);
  }

  if (response.status === 404) {
    throw new NonRetryableStepError(`${action}: not found — ${message}`, err);
  }

  if (response.status === 429) {
    const retryAfterSeconds = Number(response.headers.get('retry-after')) || undefined;
    throw new RetryableProviderError(
      `${action}: Google is rate-limiting this request${retryAfterSeconds ? ` — retry after ${retryAfterSeconds}s` : ''}`,
      err,
    );
  }

  if (response.status >= 500) {
    throw new RetryableProviderError(`${action}: Google returned ${response.status} — ${message}`, err);
  }

  // Any other 4xx (400 bad request, 422, ...) is the caller's problem.
  throw new NonRetryableStepError(`${action}: ${message}`, err);
}
