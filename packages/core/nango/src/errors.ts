/**
 * Nango error classification.
 *
 * Every failure the connector layer surfaces is one of four kinds, because the
 * caller's response differs per kind:
 *   - `auth`       → the tenant must re-authorise; stop retrying, flag the UI.
 *   - `rate_limit` → back off and retry; the connection is healthy.
 *   - `transient`  → retry; network blip or Nango 5xx.
 *   - `permanent`  → a bad request on our side; retrying cannot help.
 */

export type NangoErrorKind = 'auth' | 'rate_limit' | 'transient' | 'permanent';

export class NangoApiError extends Error {
  readonly kind: NangoErrorKind;
  readonly status: number;
  readonly body: string | undefined;
  /** Seconds to wait before retrying, when the server told us. */
  readonly retryAfterSeconds: number | undefined;

  constructor(args: {
    message: string;
    status: number;
    kind: NangoErrorKind;
    body?: string;
    retryAfterSeconds?: number;
  }) {
    super(args.message);
    this.name = 'NangoApiError';
    this.status = args.status;
    this.kind = args.kind;
    this.body = args.body;
    this.retryAfterSeconds = args.retryAfterSeconds;
  }

  /** True when another attempt could plausibly succeed. */
  get retryable(): boolean {
    return this.kind === 'rate_limit' || this.kind === 'transient';
  }
}

/** Map an HTTP status onto a failure kind. */
export function classifyStatus(status: number): NangoErrorKind {
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate_limit';
  if (status >= 500) return 'transient';
  return 'permanent';
}

/**
 * Parse a `Retry-After` header. Accepts both delta-seconds and an HTTP-date;
 * returns undefined when absent or unparseable so callers fall back to the
 * exponential schedule.
 */
export function parseRetryAfter(header: string | null, now: number = Date.now()): number | undefined {
  if (!header) return undefined;
  const trimmed = header.trim();
  if (trimmed === '') return undefined;

  const asNumber = Number(trimmed);
  if (Number.isFinite(asNumber)) return asNumber < 0 ? 0 : asNumber;

  const asDate = Date.parse(trimmed);
  if (Number.isNaN(asDate)) return undefined;
  return Math.max(0, Math.ceil((asDate - now) / 1000));
}
