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

/** Catalogue product pushed from WeldCommerce onto an external store. */
export interface OutboundCatalogProduct {
  name: string;
  description?: string | null;
  shortDescription?: string | null;
  sku?: string | null;
  slug?: string | null;
  price: string;
  status: string;
  vendor?: string | null;
  productType?: string | null;
  images?: Array<{ url: string; altText?: string }>;
  weight?: string | null;
  length?: string | null;
  width?: string | null;
  height?: string | null;
  trackInventory?: boolean;
  inventoryQuantity?: number | null;
}

/** Remote listing created or matched during an outbound product push. */
export interface ExternalProductRef {
  id: string;
  url: string | null;
}

export function parseRetryAfter(header: string | null, now: number = Date.now()): number | undefined {
  if (!header) return undefined;
  const trimmed = header.trim();
  if (trimmed === '') return undefined;

  const asNumber = Number(trimmed);
  if (Number.isFinite(asNumber)) return Math.max(0, asNumber);

  const asDate = Date.parse(trimmed);
  if (Number.isNaN(asDate)) return undefined;
  return Math.max(0, Math.ceil((asDate - now) / 1000));
}

/**
 * Workers' global `fetch` is a method. Storing it on a class and calling
 * `this.fetchImpl(...)` throws Illegal invocation (wrong `this`). Wrap so
 * method-style calls stay safe; bind the default to `globalThis`.
 *
 * @see https://developers.cloudflare.com/workers/observability/errors/#illegal-invocation-errors
 */
export function bindFetch(fetchImpl?: typeof fetch): typeof fetch {
  const impl = fetchImpl ?? globalThis.fetch.bind(globalThis);
  return ((input: RequestInfo | URL, init?: RequestInit) => impl(input, init)) as typeof fetch;
}

/** Result of one HTTP attempt: a value, or a classified error that may be retried. */
export type ConnectorAttemptOutcome<T> = { ok: true; value: T } | { ok: false; error: ConnectorApiError };

/** Delay before the next retry: honour `Retry-After`, else exponential backoff. */
export function retryDelayMs(error: ConnectorApiError, attempt: number): number {
  return error.retryAfterSeconds ? error.retryAfterSeconds * 1000 : 400 * 2 ** attempt;
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Runs `attemptOnce` with a per-attempt timeout, retrying retryable HTTP errors
 * and network failures up to `maxRetries` times. `attemptOnce` resolves to a
 * value, or to an error outcome that is retried when `error.retryable`.
 */
export async function runWithRetries<T>(args: {
  maxRetries: number;
  timeoutMs: number;
  unreachableMessage: string;
  failureMessage: string;
  attemptOnce: (signal: AbortSignal) => Promise<ConnectorAttemptOutcome<T>>;
}): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= args.maxRetries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), args.timeoutMs);
    try {
      const outcome = await args.attemptOnce(controller.signal);
      if (outcome.ok) return outcome.value;
      const { error } = outcome;
      if (!error.retryable || attempt === args.maxRetries) throw error;
      lastError = error;
      await sleepMs(retryDelayMs(error, attempt));
    } catch (err) {
      if (err instanceof ConnectorApiError) throw err;
      lastError = err;
      if (attempt === args.maxRetries) {
        throw new ConnectorApiError({ message: args.unreachableMessage, status: 503, kind: 'transient' });
      }
      await sleepMs(400 * 2 ** attempt);
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new ConnectorApiError({ message: args.failureMessage, status: 503, kind: 'transient' });
}
