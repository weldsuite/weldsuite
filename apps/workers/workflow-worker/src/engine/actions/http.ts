/**
 * HTTP actions: http_request, webhook.
 *
 * Both can optionally authenticate using a connected integration: when
 * `integrationId`/`integrationType` is supplied, an `Authorization: Bearer
 * <token>` header is injected from the integration (an explicit
 * `headers.Authorization` always wins).
 *
 * `http_request` is a WeldConnect-exposed action (services/weldconnect-mvp.ts
 * on connect-api), so it can be pointed at ANY URL a user types in — hardened
 * accordingly: a bounded timeout, a capped response body, a scheme/target
 * allowlist that blocks obvious attempts to reach the worker's own private
 * network, and error classification the engine's retry loop can act on (a 4xx
 * is the caller's problem and won't get fixed by retrying; a 5xx or network
 * failure might).
 */

import type { ActionHandler, ActionContext } from '../types';
import { resolveIntegration, integrationBearerToken } from '../integrations';
import { NonRetryableStepError } from '../errors';

/** Merge integration-derived auth into the caller's headers (explicit wins). */
async function withIntegrationAuth(
  inputs: Record<string, unknown>,
  ctx: ActionContext,
  headers: Record<string, string>,
): Promise<Record<string, string>> {
  const integrationId = inputs.integrationId ? String(inputs.integrationId) : undefined;
  const integrationType = inputs.integrationType ? String(inputs.integrationType) : undefined;
  if (!integrationId && !integrationType) return headers;

  const hasExplicitAuth = Object.keys(headers).some((k) => k.toLowerCase() === 'authorization');
  if (hasExplicitAuth) return headers;

  const integ = await resolveIntegration(ctx.db, { integrationId, type: integrationType });
  const token = integrationBearerToken(integ);
  if (token) return { ...headers, Authorization: `Bearer ${token}` };
  return headers;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 1_000_000; // 1 MB
const MAX_TIMEOUT_MS = 120_000;

/** IPv4 ranges that never leave the host's own network (RFC 1918 + loopback + link-local). */
const PRIVATE_IPV4_PATTERNS = [
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^169\.254\./,
  /^0\.0\.0\.0$/,
];

/** True when `hostname` obviously targets this host's own network rather than the public internet. */
function isBlockedTarget(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal')) return true;
  if (host === '::1' || host === '[::1]') return true;
  if (PRIVATE_IPV4_PATTERNS.some((pattern) => pattern.test(host))) return true;
  return false;
}

/** Parse + validate a user-supplied URL: http(s) only, not an internal target. Throws NonRetryableStepError otherwise. */
function parseRequestUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new NonRetryableStepError(`Invalid URL: ${raw}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new NonRetryableStepError(`Unsupported URL scheme: ${url.protocol}`);
  }
  if (isBlockedTarget(url.hostname)) {
    throw new NonRetryableStepError(`URL targets a disallowed host: ${url.hostname}`);
  }
  return url;
}

/** Read a response body up to `MAX_RESPONSE_BYTES`, truncating (not failing) past the cap. */
async function readCappedBody(response: Response): Promise<{ text: string; truncated: boolean }> {
  const reader = response.body?.getReader();
  if (!reader) return { text: await response.text(), truncated: false };

  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    if (total + value.length > MAX_RESPONSE_BYTES) {
      chunks.push(value.slice(0, Math.max(0, MAX_RESPONSE_BYTES - total)));
      total = MAX_RESPONSE_BYTES;
      truncated = true;
      await reader.cancel().catch(() => undefined);
      break;
    }
    chunks.push(value);
    total += value.length;
  }
  const text = new TextDecoder().decode(
    chunks.reduce((acc, chunk) => {
      const merged = new Uint8Array(acc.length + chunk.length);
      merged.set(acc, 0);
      merged.set(chunk, acc.length);
      return merged;
    }, new Uint8Array(0)),
  );
  return { text, truncated };
}

/** Parse a response body as JSON when the content-type says so; raw text otherwise (and on a parse failure). */
function parseResponseBody(text: string, contentType: string | null): unknown {
  const looksJson = (contentType ?? '').includes('application/json') || (contentType ?? '').includes('+json');
  if (!looksJson) return text;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export const handleHttpRequest: ActionHandler = async (inputs, ctx) => {
  const rawUrl = String(inputs.url || '');
  if (!rawUrl) throw new NonRetryableStepError('URL is required');
  const url = parseRequestUrl(rawUrl);

  const method = String(inputs.method || 'GET').toUpperCase();
  const baseHeaders = (inputs.headers as Record<string, string>) || {};
  const body = inputs.body;
  const timeout = Math.min(Number(inputs.timeout) || DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);

  const headers = await withIntegrationAuth(inputs, ctx, baseHeaders);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  let response: Response;
  try {
    response = await fetch(url.toString(), {
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      // Timeouts are retryable — a slow upstream may answer on a later attempt.
      throw new Error(`Request timed out after ${timeout}ms`);
    }
    // Network failures (DNS, connection refused, TLS) are retryable too.
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }

  const { text: responseText } = await readCappedBody(response);
  const parsedBody = parseResponseBody(responseText, response.headers.get('content-type'));
  const responseHeaders = Object.fromEntries(response.headers.entries());

  if (response.status >= 400 && response.status < 500) {
    // A 4xx is the request's problem (bad input, auth, not found) — retrying
    // the exact same request will not fix it.
    throw new NonRetryableStepError(
      `HTTP request failed: ${response.status} ${response.statusText}`,
      { status: response.status, headers: responseHeaders, body: parsedBody },
    );
  }
  if (response.status >= 500) {
    // 5xx is the upstream's problem and may well succeed on retry.
    throw new Error(`HTTP request failed: ${response.status} ${response.statusText}`);
  }

  return {
    status: response.status,
    ok: response.ok,
    headers: responseHeaders,
    body: parsedBody,
  };
};

export const handleWebhook: ActionHandler = async (inputs, ctx) => {
  const rawUrl = String(inputs.url || inputs.webhookUrl || '');
  if (!rawUrl) throw new Error('Webhook URL is required');
  const url = parseRequestUrl(rawUrl);

  const method = String(inputs.method || 'POST').toUpperCase();
  const baseHeaders = (inputs.headers || {}) as Record<string, string>;
  const body = inputs.body || inputs.payload || inputs.data;

  const headers = await withIntegrationAuth(inputs, ctx, baseHeaders);

  const response = await fetch(url.toString(), {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });

  const { text: responseText } = await readCappedBody(response);
  let responseData: unknown;
  try {
    responseData = JSON.parse(responseText);
  } catch {
    responseData = responseText;
  }

  if (!response.ok) {
    throw new Error(`Webhook failed: ${response.status} - ${responseText.slice(0, 200)}`);
  }
  return { success: true, status: response.status, response: responseData };
};
