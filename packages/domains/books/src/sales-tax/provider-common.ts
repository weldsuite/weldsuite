/**
 * Shared plumbing of the provider engines (Stripe Tax, Avalara): HTTP with
 * error mapping, registration pre-check, tax code mapping.
 *
 * An engine failure never posts zero tax: every failure is a
 * SalesTaxEngineError the caller can retry or surface.
 */

import { SalesTaxEngineError, type TaxUse } from './types';

/** Maps a WeldBooks product tax code (and the buyer's use) to the provider's tax code. */
export type TaxCodeMapper = (code: string, use: TaxUse) => string;

export type FetchLike = typeof fetch;

export function defaultFetch(): FetchLike {
  // A wrapper keeps `this` right on Workers, where a detached `fetch` throws "Illegal invocation".
  return (input, init) => globalThis.fetch(input, init);
}

export interface ProviderCall {
  provider: string;
  fetch: FetchLike;
  url: string;
  method: 'GET' | 'POST';
  headers: Record<string, string>;
  body?: string;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 20_000;

/** Error text a provider put in its JSON body, if any. */
function errorText(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const root = body as { error?: unknown; message?: unknown };
  const error = root.error;
  if (error && typeof error === 'object') {
    const e = error as { message?: unknown; details?: unknown };
    const detail = Array.isArray(e.details)
      ? (e.details as Array<{ message?: unknown }>).find((d) => typeof d?.message === 'string')?.message
      : undefined;
    const message = typeof e.message === 'string' ? e.message : undefined;
    if (message && typeof detail === 'string' && detail !== message) return `${message} (${detail})`;
    return message;
  }
  return typeof root.message === 'string' ? root.message : undefined;
}

/** One HTTP call; throws SalesTaxEngineError on a network failure or a non-2xx answer. */
export async function callProvider<T>(call: ProviderCall): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), call.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  let response: Response;
  try {
    response = await call.fetch(call.url, {
      method: call.method,
      headers: call.headers,
      body: call.body,
      signal: controller.signal,
    });
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : 'network error';
    throw new SalesTaxEngineError(`${call.provider} is unreachable: ${reason}`, 'unreachable', true);
  } finally {
    clearTimeout(timer);
  }

  let text = '';
  try {
    text = await response.text();
  } catch {
    // A body we can't read still has a status.
  }
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = undefined;
  }

  if (response.ok) return (body ?? {}) as T;

  const detail = errorText(body);
  const suffix = detail ? `: ${detail}` : '';
  const status = response.status;
  if (status === 401 || status === 403) {
    throw new SalesTaxEngineError(`${call.provider} rejected the credentials (HTTP ${status})${suffix}`, 'auth');
  }
  if (status === 429) {
    throw new SalesTaxEngineError(`${call.provider} rate limit reached${suffix}`, 'rate_limited', true);
  }
  if (status >= 500) {
    throw new SalesTaxEngineError(`${call.provider} failed (HTTP ${status})${suffix}`, 'unreachable', true);
  }
  throw new SalesTaxEngineError(`${call.provider} refused the request (HTTP ${status})${suffix}`, 'invalid_request');
}

export function toBase64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** `application/x-www-form-urlencoded` body from key/value pairs; undefined values are left out. */
export function formEncode(fields: Array<[string, string | number | boolean | undefined]>): string {
  const params = new URLSearchParams();
  for (const [key, value] of fields) {
    if (value === undefined) continue;
    params.append(key, String(value));
  }
  return params.toString();
}
