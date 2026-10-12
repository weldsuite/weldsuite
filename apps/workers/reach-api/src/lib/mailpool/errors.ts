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

const MESSAGE_KEYS = ['message', 'error', 'detail'] as const;
const MAX_MESSAGE_LENGTH = 300;

/** `value` cut to the message length, when it is a non-empty string. */
function messageFromString(value: unknown): string | null {
  return typeof value === 'string' && value ? value.slice(0, MAX_MESSAGE_LENGTH) : null;
}

/** The message in one field of an error body: the string itself, or the `message` of an object. */
function messageFromField(value: unknown): string | null {
  const direct = messageFromString(value);
  if (direct) return direct;
  if (value && typeof value === 'object') return messageFromString((value as Record<string, unknown>).message);
  return null;
}

/** The human-readable message of a Mailpool error body, when it has one. */
export function extractMessage(body: unknown): string | null {
  if (typeof body === 'string') return messageFromString(body);
  if (!body || typeof body !== 'object') return null;
  const record = body as Record<string, unknown>;
  for (const key of MESSAGE_KEYS) {
    const message = messageFromField(record[key]);
    if (message) return message;
  }
  return null;
}

export function isMailpoolNotFound(err: unknown): boolean {
  return err instanceof MailpoolError && err.isNotFound;
}
