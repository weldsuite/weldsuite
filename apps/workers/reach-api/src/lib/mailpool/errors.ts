/**
 * Typed errors of the Mailpool client. Callers branch on `status` /
 * `isNotFound` instead of parsing messages.
 */

/** MAILPOOL_API_KEY is not set: nothing can be provisioned. */
export class MailpoolNotConfiguredError extends Error {
  constructor() {
    super('MAILPOOL_API_KEY is not configured');
    this.name = 'MailpoolNotConfiguredError';
  }
}

export interface MailpoolErrorInit {
  method: string;
  path: string;
  /** HTTP status; 0 when no response arrived (network failure, timeout). */
  status: number;
  body?: unknown;
  message?: string;
  cause?: unknown;
}

/** Mailpool answered with an error status, or could not be reached at all. */
export class MailpoolError extends Error {
  readonly method: string;
  readonly path: string;
  readonly status: number;
  readonly body: unknown;

  constructor(init: MailpoolErrorInit) {
    super(init.message ?? describeFailure(init));
    this.name = 'MailpoolError';
    this.method = init.method;
    this.path = init.path;
    this.status = init.status;
    this.body = init.body;
    if (init.cause !== undefined) this.cause = init.cause;
  }

  /** Worth retrying later: rate limited, upstream trouble, or unreachable. */
  get retryable(): boolean {
    return this.status === 0 || this.status === 429 || this.status >= 500;
  }

  get isNotFound(): boolean {
    return this.status === 404;
  }
}

function describeFailure(init: MailpoolErrorInit): string {
  const detail = extractMessage(init.body);
  const prefix = `Mailpool ${init.method} ${init.path}`;
  if (init.status === 0) return `${prefix} failed: no response`;
  return detail ? `${prefix} failed with ${init.status}: ${detail}` : `${prefix} failed with ${init.status}`;
}

/** The human-readable message of a Mailpool error body, when it has one. */
export function extractMessage(body: unknown): string | null {
  if (typeof body === 'string') return body.slice(0, 300) || null;
  if (body && typeof body === 'object') {
    const record = body as Record<string, unknown>;
    for (const key of ['message', 'error', 'detail']) {
      const value = record[key];
      if (typeof value === 'string' && value) return value.slice(0, 300);
      if (value && typeof value === 'object') {
        const nested = (value as Record<string, unknown>).message;
        if (typeof nested === 'string' && nested) return nested.slice(0, 300);
      }
    }
  }
  return null;
}

export function isMailpoolNotFound(err: unknown): boolean {
  return err instanceof MailpoolError && err.isNotFound;
}
