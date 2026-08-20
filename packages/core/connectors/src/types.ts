/**
 * First-party connector framework types.
 *
 * Credentials live in the tenant database (encrypted). Each provider ships its
 * own client — there is no third-party sync host in the path.
 */

export type ConnectorErrorKind = 'auth' | 'rate_limit' | 'transient' | 'permanent';

export class ConnectorApiError extends Error {
  readonly kind: ConnectorErrorKind;
  readonly status: number;
  readonly body: string | undefined;
  readonly retryAfterSeconds: number | undefined;

  constructor(args: {
    message: string;
    status: number;
    kind: ConnectorErrorKind;
    body?: string;
    retryAfterSeconds?: number;
  }) {
    super(args.message);
    this.name = 'ConnectorApiError';
    this.status = args.status;
    this.kind = args.kind;
    this.body = args.body;
    this.retryAfterSeconds = args.retryAfterSeconds;
  }

  get retryable(): boolean {
    return this.kind === 'rate_limit' || this.kind === 'transient';
  }
}

export function classifyStatus(status: number): ConnectorErrorKind {
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate_limit';
  if (status >= 500) return 'transient';
  return 'permanent';
}

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
