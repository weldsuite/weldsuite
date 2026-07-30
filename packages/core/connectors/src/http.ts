/**
 * Shared HTTP transport for drivers.
 *
 * Lifted from the Nango client's transport half, which was the one part of that
 * layer worth keeping: bearer auth, an abort-based timeout, `Retry-After`-aware
 * retries, and status→kind classification, all in a form that runs unmodified
 * on Workers (no Node built-ins, no axios).
 *
 * Every driver goes through this rather than calling `fetch` directly, so rate
 * limits and 5xx are absorbed in one place and a new driver cannot forget to
 * handle them.
 */

import { ConnectorApiError, classifyStatus, parseRetryAfter } from './errors';
import { withRetry, type RetryOptions } from './retry';

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_RETRIES = 3;

export interface ConnectorRequest {
  url: string;
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  /** Bearer token. Both auth modes end up here — an API token is just a bearer. */
  token?: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  headers?: Record<string, string>;
  timeoutMs?: number;
  /**
   * Retry policy, or `false` for calls that must not repeat. Anything that
   * creates or mutates provider state without an idempotency key belongs in the
   * `false` camp — a retried POST is a duplicate record at the provider.
   */
  retry?: RetryOptions | false;
  /** Included in thrown errors so a log line names the driver. */
  connectorId?: string;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
}

function buildUrl(url: string, query?: ConnectorRequest['query']): string {
  if (!query) return url;
  const parsed = new URL(url);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) parsed.searchParams.set(key, String(value));
  }
  return parsed.toString();
}

async function rawRequest<T>(request: ConnectorRequest): Promise<T> {
  const fetchImpl = request.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), request.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  try {
    const headers: Record<string, string> = {
      Accept: 'application/json',
      ...request.headers,
    };
    if (request.token) headers.Authorization = `Bearer ${request.token}`;
    if (request.body !== undefined && !headers['Content-Type']) {
      headers['Content-Type'] = 'application/json';
    }

    const response = await fetchImpl(buildUrl(request.url, request.query), {
      method: request.method ?? 'GET',
      headers,
      body: request.body === undefined ? undefined : JSON.stringify(request.body),
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => undefined);
      throw new ConnectorApiError({
        message: `${request.method ?? 'GET'} ${request.url} failed with ${response.status}`,
        status: response.status,
        kind: classifyStatus(response.status),
        body,
        retryAfterSeconds: parseRetryAfter(response.headers.get('retry-after')),
        connectorId: request.connectorId,
      });
    }

    if (response.status === 204) return undefined as T;
    const text = await response.text();
    if (!text) return undefined as T;
    return JSON.parse(text) as T;
  } finally {
    clearTimeout(timer);
  }
}

/** Perform a provider request, retrying transient failures unless disabled. */
export function connectorFetch<T>(request: ConnectorRequest): Promise<T> {
  if (request.retry === false) return rawRequest<T>(request);
  return withRetry(() => rawRequest<T>(request), {
    maxRetries: DEFAULT_MAX_RETRIES,
    ...request.retry,
  });
}

/**
 * Read a `Link: <…>; rel="next"` header, the pagination style Moneybird and
 * several other REST APIs use. Returns null when there is no next page.
 */
export function parseLinkHeaderNext(header: string | null): string | null {
  if (!header) return null;
  for (const part of header.split(',')) {
    const match = part.match(/<([^>]+)>\s*;\s*rel="?next"?/i);
    if (match?.[1]) return match[1];
  }
  return null;
}
