/**
 * HTTP actions: http_request, webhook.
 *
 * Both can optionally authenticate using a connected integration: when
 * `integrationId`/`integrationType` is supplied, an `Authorization: Bearer
 * <token>` header is injected from the integration (an explicit
 * `headers.Authorization` always wins). The token is only ever sent to that
 * integration provider's own API host (see INTEGRATION_API_HOSTS).
 *
 * `http_request` is a WeldConnect-exposed action (services/weldconnect-mvp.ts
 * on connect-api), so it can be pointed at ANY URL a user types in — hardened
 * accordingly: a bounded timeout, a capped response body, a scheme/target
 * allowlist that blocks attempts to reach the worker's own private network or
 * the platform's own hostnames, and error classification the engine's retry
 * loop can act on (a 4xx or an unresolvable host is the caller's problem and
 * won't get fixed by retrying; a 5xx or a timeout might).
 */

import type { ActionHandler, ActionContext } from '../types';
import { resolveIntegration, integrationBearerToken } from '../integrations';
import { NonRetryableStepError } from '../errors';
import { asText } from '@weldsuite/text';

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 1_000_000; // 1 MB
const MAX_TIMEOUT_MS = 120_000;

/**
 * The API host(s) each integration provider's token may be sent to, keyed by
 * integration type. An entry is an exact host (`api.github.com`) or a
 * `*.domain` wildcard that matches subdomains only (list the apex separately
 * when it is a valid target too). An integration type with no entry gets its
 * token sent nowhere: `http_request` takes an author-chosen URL, so without
 * this allowlist any workflow author could point a connected integration's
 * token at a server they control.
 */
const INTEGRATION_API_HOSTS: Record<string, readonly string[]> = {
  airtable: ['api.airtable.com'],
  asana: ['app.asana.com'],
  attio: ['api.attio.com'],
  github: ['api.github.com'],
  gmail: ['*.googleapis.com'],
  google_calendar: ['*.googleapis.com'],
  google_sheets: ['*.googleapis.com'],
  hubspot: ['api.hubapi.com', 'api.hubspot.com'],
  notion: ['api.notion.com'],
  slack: ['slack.com', '*.slack.com'],
  teams: ['graph.microsoft.com', 'outlook.office.com', '*.webhook.office.com'],
  twilio: ['api.twilio.com', '*.twilio.com'],
};

/** Lower-cased hostname without a trailing root dot. */
function normalizeHost(hostname: string): string {
  return hostname.toLowerCase().replace(/\.$/, '');
}

function hostMatches(host: string, pattern: string): boolean {
  if (pattern.startsWith('*.')) return host.endsWith(pattern.slice(1));
  return host === pattern;
}

/** True when `host` is one of the API hosts registered for `integrationType`. */
function isIntegrationApiHost(integrationType: string, host: string): boolean {
  const patterns = INTEGRATION_API_HOSTS[integrationType];
  return !!patterns && patterns.some((pattern) => hostMatches(host, pattern));
}

/**
 * Merge integration-derived auth into the caller's headers (explicit wins).
 * The integration's token is only attached when the target host is the
 * provider's own API host; anywhere else the step fails rather than silently
 * dropping the credential (or leaking it). `integrationType` is set only when
 * a token was attached, so the caller knows redirects must be guarded.
 */
async function withIntegrationAuth(
  inputs: Record<string, unknown>,
  ctx: ActionContext,
  headers: Record<string, string>,
  url: URL,
): Promise<{ headers: Record<string, string>; integrationType?: string }> {
  const integrationId = inputs.integrationId ? asText(inputs.integrationId) : undefined;
  const integrationType = inputs.integrationType ? asText(inputs.integrationType) : undefined;
  if (!integrationId && !integrationType) return { headers };

  const hasExplicitAuth = Object.keys(headers).some((k) => k.toLowerCase() === 'authorization');
  if (hasExplicitAuth) return { headers };

  const integ = await resolveIntegration(ctx.db, { integrationId, type: integrationType });
  const token = integrationBearerToken(integ);
  if (!token) return { headers };

  const host = normalizeHost(url.hostname);
  if (!isIntegrationApiHost(integ.type, host)) {
    throw new NonRetryableStepError(
      `The ${integ.type} integration's token can only be sent to its own API host, not to ${host}. ` +
        'Remove the integration from this step to call another server, or set the Authorization header yourself.',
    );
  }
  return { headers: { ...headers, Authorization: `Bearer ${token}` }, integrationType: integ.type };
}

/** IPv4 ranges that never leave the host's own network (RFC 1918 + loopback + link-local + CGNAT). */
const PRIVATE_IPV4_PATTERNS = [
  /^0\./,
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^169\.254\./,
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
];

/** Platform-owned hostnames: a workflow must not call WeldSuite's own APIs from inside the platform. */
const INTERNAL_HOST_SUFFIXES = ['weldsuite.org', 'workers.dev'];

/** Cloud metadata endpoints that are not covered by an IP or `.internal` rule. */
const METADATA_HOSTS = new Set(['metadata', 'instance-data']);

function isPrivateIpv4(host: string): boolean {
  return PRIVATE_IPV4_PATTERNS.some((pattern) => pattern.test(host));
}

/** Decode an IPv4-mapped IPv6 address (`::ffff:a00:1` / `::ffff:10.0.0.1`) back to dotted form. */
function mappedIpv4(address: string): string | null {
  const dotted = /^(?:0{0,4}:){0,5}:?ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(address);
  if (dotted) return dotted[1];
  const hex = /^(?:0{0,4}:){0,5}:?ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(address);
  if (!hex) return null;
  const hi = parseInt(hex[1], 16);
  const lo = parseInt(hex[2], 16);
  return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
}

/** True for loopback, unspecified, unique-local (fc00::/7), link-local (fe80::/10) and mapped-private IPv6 literals. */
function isPrivateIpv6(literal: string): boolean {
  const address = literal.replace(/^\[|\]$/g, '');
  if (!address.includes(':')) return false;
  if (address === '::' || address === '::1') return true;
  const first = address.split(':')[0];
  if (/^f[cd][0-9a-f]{2}$/.test(first)) return true; // fc00::/7
  if (/^fe[89ab][0-9a-f]$/.test(first)) return true; // fe80::/10
  const mapped = mappedIpv4(address);
  return mapped !== null && isPrivateIpv4(mapped);
}

/** True when `hostname` obviously targets this host's own network, the platform itself, or a metadata service. */
function isBlockedTarget(hostname: string): boolean {
  const host = normalizeHost(hostname);
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host.endsWith('.internal') || host.endsWith('.local')) return true;
  if (METADATA_HOSTS.has(host)) return true;
  if (INTERNAL_HOST_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`))) return true;
  if (isPrivateIpv6(host)) return true;
  return isPrivateIpv4(host);
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

/** Response headers safe to hand to later steps: cookies set by the remote server are dropped. */
function safeResponseHeaders(response: Response): Record<string, string> {
  const headers = Object.fromEntries(response.headers.entries());
  delete headers['set-cookie'];
  delete headers['set-cookie2'];
  return headers;
}

/** HTTP/2 responses carry no reason phrase; fall back to the standard one so a message never ends in a bare status code. */
const STATUS_TEXT: Record<number, string> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  408: 'Request Timeout',
  409: 'Conflict',
  410: 'Gone',
  413: 'Payload Too Large',
  415: 'Unsupported Media Type',
  422: 'Unprocessable Content',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  501: 'Not Implemented',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
  504: 'Gateway Timeout',
  520: 'Unknown Error (Cloudflare)',
  521: 'Web Server Is Down (Cloudflare)',
  522: 'Connection Timed Out (Cloudflare)',
  523: 'Origin Is Unreachable (Cloudflare)',
  524: 'A Timeout Occurred (Cloudflare)',
  530: 'Origin DNS Error (Cloudflare)',
};

function statusLabel(response: Response): string {
  const text = response.statusText || STATUS_TEXT[response.status];
  return text ? `${response.status} ${text}` : String(response.status);
}

/**
 * Cloudflare answers an outbound fetch to a host it cannot resolve (or reach)
 * with a 530 response instead of throwing. Retrying cannot fix a name that
 * does not exist, so it is surfaced as a non-retryable failure with a message
 * a workflow author can act on.
 */
function assertHostReachable(response: Response, responseText: string, host: string): void {
  if (response.status !== 530) return;
  const code = /\b(1\d{3})\b/.exec(responseText)?.[1];
  if (!code || code === '1016') {
    throw new NonRetryableStepError(`Could not resolve host ${host}`, { status: response.status });
  }
  throw new NonRetryableStepError(`Could not reach ${host}: Cloudflare error ${code}`, {
    status: response.status,
  });
}

/** Most redirects followed by hand for a request that carries an integration token. */
const MAX_INTEGRATION_REDIRECTS = 5;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * The request for the next hop of a redirect, matching fetch semantics: a 303
 * (and a 301/302 after a POST) becomes a body-less GET; 307/308 repeat the
 * request as it was.
 */
function nextRedirectInit(init: RequestInit, status: number): RequestInit {
  const method = (init.method ?? 'GET').toUpperCase();
  const toGet =
    status === 303 ? method !== 'GET' && method !== 'HEAD' : (status === 301 || status === 302) && method === 'POST';
  if (!toGet) return init;
  const headers = Object.fromEntries(
    Object.entries((init.headers ?? {}) as Record<string, string>).filter(
      ([key]) => key.toLowerCase() !== 'content-type',
    ),
  );
  return { ...init, method: 'GET', body: undefined, headers };
}

/**
 * `fetch` + capped body read under one timeout. A timeout stays retryable (a
 * slow upstream may answer on a later attempt); a thrown network error (DNS
 * failure, connection refused, TLS) will not fix itself and is not.
 *
 * With `integrationType` set the request carries that integration's token, so
 * redirects are followed here rather than by `fetch`: every hop goes through
 * the same target checks and keeps the token only while it stays on the
 * provider's own API host (otherwise the step fails before the second host is
 * called). Without it, `fetch` follows redirects as usual.
 */
async function fetchWithTimeout(
  url: URL,
  init: RequestInit,
  timeoutMs: number,
  integrationType?: string,
): Promise<{ response: Response; text: string; url: URL }> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  let current = url;
  try {
    let requestInit = init;
    for (let hops = 0; ; hops++) {
      const response = await fetch(current.toString(), {
        ...requestInit,
        signal: controller.signal,
        ...(integrationType ? { redirect: 'manual' as const } : {}),
      });
      const location = response.headers.get('location');
      if (!integrationType || !REDIRECT_STATUSES.has(response.status) || !location) {
        const { text } = await readCappedBody(response);
        return { response, text, url: current };
      }

      await response.body?.cancel().catch(() => undefined);
      if (hops >= MAX_INTEGRATION_REDIRECTS) {
        throw new NonRetryableStepError(
          `Too many redirects (more than ${MAX_INTEGRATION_REDIRECTS}) calling ${url.hostname}`,
        );
      }
      let target: string;
      try {
        target = new URL(location, current).toString();
      } catch {
        throw new NonRetryableStepError(`${current.hostname} redirected to an invalid URL`);
      }
      const next = parseRequestUrl(target);
      if (!isIntegrationApiHost(integrationType, normalizeHost(next.hostname))) {
        throw new NonRetryableStepError(
          `${current.hostname} redirected to ${next.hostname}, which is not the ${integrationType} API host; the integration token was not sent`,
        );
      }
      requestInit = nextRedirectInit(requestInit, response.status);
      current = next;
    }
  } catch (err) {
    if (err instanceof NonRetryableStepError) throw err;
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(`Request timed out after ${timeoutMs}ms`);
    }
    const reason = err instanceof Error && err.message ? err.message : String(err);
    throw new NonRetryableStepError(`Could not connect to ${current.hostname}: ${reason}`);
  } finally {
    clearTimeout(timeoutId);
  }
}

function resolveTimeout(inputs: Record<string, unknown>): number {
  return Math.min(Number(inputs.timeout) || DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
}

export const handleHttpRequest: ActionHandler = async (inputs, ctx) => {
  const rawUrl = asText(inputs.url || '');
  if (!rawUrl) throw new NonRetryableStepError('URL is required');
  const url = parseRequestUrl(rawUrl);

  const method = asText(inputs.method || 'GET').toUpperCase();
  const baseHeaders = (inputs.headers as Record<string, string>) || {};
  const body = inputs.body;
  const timeout = resolveTimeout(inputs);

  const { headers, integrationType } = await withIntegrationAuth(inputs, ctx, baseHeaders, url);

  const { response, text: responseText, url: finalUrl } = await fetchWithTimeout(
    url,
    {
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    },
    timeout,
    integrationType,
  );

  assertHostReachable(response, responseText, finalUrl.hostname);

  const parsedBody = parseResponseBody(responseText, response.headers.get('content-type'));
  const responseHeaders = safeResponseHeaders(response);

  if (response.status >= 400 && response.status < 500) {
    // A 4xx is the request's problem (bad input, auth, not found) — retrying
    // the exact same request will not fix it.
    throw new NonRetryableStepError(`HTTP request failed: ${statusLabel(response)}`, {
      status: response.status,
      headers: responseHeaders,
      body: parsedBody,
    });
  }
  if (response.status >= 500) {
    // 5xx is the upstream's problem and may well succeed on retry.
    throw new Error(`HTTP request failed: ${statusLabel(response)}`);
  }

  return {
    status: response.status,
    ok: response.ok,
    headers: responseHeaders,
    body: parsedBody,
  };
};

export const handleWebhook: ActionHandler = async (inputs, ctx) => {
  const rawUrl = asText(inputs.url || inputs.webhookUrl || '');
  if (!rawUrl) throw new Error('Webhook URL is required');
  const url = parseRequestUrl(rawUrl);

  const method = asText(inputs.method || 'POST').toUpperCase();
  const baseHeaders = (inputs.headers || {}) as Record<string, string>;
  const body = inputs.body || inputs.payload || inputs.data;
  const timeout = resolveTimeout(inputs);

  const { headers, integrationType } = await withIntegrationAuth(inputs, ctx, baseHeaders, url);

  const { response, text: responseText, url: finalUrl } = await fetchWithTimeout(
    url,
    {
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
      body: body ? JSON.stringify(body) : undefined,
    },
    timeout,
    integrationType,
  );

  assertHostReachable(response, responseText, finalUrl.hostname);

  let responseData: unknown;
  try {
    responseData = JSON.parse(responseText);
  } catch {
    responseData = responseText;
  }

  if (!response.ok) {
    throw new Error(`Webhook failed: ${statusLabel(response)} - ${responseText.slice(0, 200)}`);
  }
  return { success: true, status: response.status, response: responseData };
};
