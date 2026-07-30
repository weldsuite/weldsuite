/**
 * Connector error classification.
 *
 * Every failure a driver surfaces is one of four kinds, because the caller's
 * response differs per kind:
 *   - `auth`       → the tenant must re-authorise; stop retrying, flag the UI.
 *   - `rate_limit` → back off and retry; the connection is healthy.
 *   - `transient`  → retry; network blip or provider 5xx.
 *   - `permanent`  → a bad request on our side; retrying cannot help.
 *
 * Drivers must classify through here rather than throwing bare `Error`s: the
 * sync loop decides whether to advance a watermark, mark a connection
 * `auth_error`, or leave it healthy purely from `kind`.
 */

export type ConnectorErrorKind = 'auth' | 'rate_limit' | 'transient' | 'permanent';

export class ConnectorApiError extends Error {
  readonly kind: ConnectorErrorKind;
  readonly status: number;
  readonly body: string | undefined;
  /** Seconds to wait before retrying, when the server told us. */
  readonly retryAfterSeconds: number | undefined;
  /** Connector id the failure came from, for logs that span several drivers. */
  readonly connectorId: string | undefined;

  constructor(args: {
    message: string;
    status: number;
    kind: ConnectorErrorKind;
    body?: string;
    retryAfterSeconds?: number;
    connectorId?: string;
  }) {
    super(args.message);
    this.name = 'ConnectorApiError';
    this.status = args.status;
    this.kind = args.kind;
    this.body = args.body;
    this.retryAfterSeconds = args.retryAfterSeconds;
    this.connectorId = args.connectorId;
  }

  /** True when another attempt could plausibly succeed. */
  get retryable(): boolean {
    return this.kind === 'rate_limit' || this.kind === 'transient';
  }
}

/** Map an HTTP status onto a failure kind. */
export function classifyStatus(status: number): ConnectorErrorKind {
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

/** True when the failure means the tenant has to reauthorise. */
export function isAuthFailure(error: unknown): boolean {
  return error instanceof ConnectorApiError && error.kind === 'auth';
}
