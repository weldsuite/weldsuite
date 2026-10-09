/**
 * Shared HTTP plumbing for the adapters: an injectable `fetch` (tests pass a
 * fixture; Ponto can pass a Workers mTLS binding's `fetch`), JSON/form bodies,
 * error mapping, and small guards for reading untyped provider payloads.
 */

import { FeedProviderError, type FeedErrorKind } from './errors';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type JsonRecord = Record<string, unknown>;

export function asRecord(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonRecord) : {};
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function asString(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

export function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
  return null;
}

export function defaultFetch(): FetchLike {
  return (input, init) => fetch(input, init);
}

/** Map an HTTP status to the error kind the sync loop reacts to. */
export function kindForStatus(status: number): FeedErrorKind {
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate_limit';
  if (status >= 500 || status === 408) return 'transient';
  return 'permanent';
}

export interface RequestOptions {
  provider: string;
  fetchImpl: FetchLike;
  method?: string;
  headers?: Record<string, string>;
  /** Sent as JSON. */
  json?: unknown;
  /** Sent form-encoded (Stripe). */
  form?: Array<[string, string]>;
  /** Maps a failed response to a provider-specific error; return null to fall back to the status mapping. */
  mapError?: (status: number, body: JsonRecord) => FeedProviderError | null;
}

/**
 * One JSON request. Throws `FeedProviderError`; the message never includes the
 * request body, so credentials sent in it cannot leak into logs.
 */
export async function requestJson(url: string, options: RequestOptions): Promise<JsonRecord> {
  const headers: Record<string, string> = { Accept: 'application/json', ...options.headers };
  let body: string | undefined;
  if (options.json !== undefined) {
    headers['Content-Type'] = headers['Content-Type'] ?? 'application/json';
    body = JSON.stringify(options.json);
  } else if (options.form) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    body = new URLSearchParams(options.form).toString();
  }

  let response: Response;
  try {
    response = await options.fetchImpl(url, { method: options.method ?? (body ? 'POST' : 'GET'), headers, body });
  } catch (err) {
    throw new FeedProviderError(
      options.provider,
      'transient',
      `${options.provider} request failed: ${err instanceof Error ? err.message : 'network error'}`,
    );
  }

  const text = await response.text();
  let parsed: JsonRecord = {};
  if (text) {
    try {
      parsed = asRecord(JSON.parse(text));
    } catch {
      parsed = {};
    }
  }

  if (response.ok) return parsed;

  const mapped = options.mapError?.(response.status, parsed);
  if (mapped) throw mapped;
  const retryAfter = Number(response.headers.get('retry-after'));
  throw new FeedProviderError(
    options.provider,
    kindForStatus(response.status),
    `${options.provider} responded ${response.status}`,
    { status: response.status, retryAfterSeconds: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined },
  );
}

export function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  const binary = atob(padded);
  const out = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

export function utf8(value: string): Uint8Array<ArrayBuffer> {
  const encoded = new TextEncoder().encode(value);
  const out = new Uint8Array(new ArrayBuffer(encoded.length));
  out.set(encoded);
  return out;
}

/** Flatten nested objects and arrays into Stripe's bracket form encoding (`a[b][0]=c`). */
export function formEntries(value: Record<string, unknown>, prefix = ''): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined || item === null) continue;
    const name = prefix ? `${prefix}[${key}]` : key;
    if (Array.isArray(item)) {
      item.forEach((entry, index) => {
        if (entry && typeof entry === 'object') out.push(...formEntries(entry as Record<string, unknown>, `${name}[${index}]`));
        else out.push([`${name}[${index}]`, String(entry)]);
      });
    } else if (typeof item === 'object') {
      out.push(...formEntries(item as Record<string, unknown>, name));
    } else {
      out.push([name, String(item)]);
    }
  }
  return out;
}

export function queryString(entries: Array<[string, string]>): string {
  return entries.length === 0 ? '' : `?${new URLSearchParams(entries).toString()}`;
}
