/**
 * WooCommerce REST API client (v3).
 *
 * Auth is HTTP Basic with the store's consumer key/secret. Merchants grant
 * those keys through WooCommerce's `/wc-auth/v1/authorize` endpoint (store URL
 * + Connect); they can still paste a pair generated under
 * WooCommerce → Settings → Advanced → REST API.
 *
 * Do not send Basic Auth and `consumer_key`/`consumer_secret` query params on
 * the same request. Many WAFs (ModSecurity, Wordfence) treat that as credential
 * smuggling and reset the TCP connection — which we used to surface as
 * "Could not reach the WooCommerce store". Query-string auth is a fallback for
 * hosts that strip the Authorization header.
 */

import { classifyStatus, ConnectorApiError, parseRetryAfter } from '../types';

export interface WooCommerceCredentials {
  storeUrl: string;
  consumerKey: string;
  consumerSecret: string;
}

export interface WooListOptions {
  page?: number;
  perPage?: number;
  /** ISO timestamp — products and orders honour `modified_after`. */
  modifiedAfter?: string;
}

export interface WooListResult<T> {
  items: T[];
  page: number;
  totalPages: number;
  total: number;
}

const DEFAULT_PER_PAGE = 100;
const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_RETRIES = 2;
const MAX_REDIRECTS = 5;
const USER_AGENT = 'WeldSuite-WooCommerce/1.0 (+https://weldsuite.org)';

type ApiStyle = 'pretty' | 'rest_route';
type AuthMode = 'basic' | 'query';

export function normalizeStoreUrl(url: string): string {
  const trimmed = url.trim();
  if (!trimmed) throw new ConnectorApiError({ message: 'Store URL is required', status: 400, kind: 'permanent' });
  const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let parsed: URL;
  try {
    parsed = new URL(withProtocol);
  } catch {
    throw new ConnectorApiError({ message: 'Store URL is not a valid URL', status: 400, kind: 'permanent' });
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new ConnectorApiError({ message: 'Store URL must be http or https', status: 400, kind: 'permanent' });
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/, '') || '';
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString().replace(/\/+$/, '');
}

function basicAuth(key: string, secret: string): string {
  const bytes = new TextEncoder().encode(`${key}:${secret}`);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `Basic ${btoa(binary)}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function looksLikeHtml(body: string): boolean {
  const head = body.trimStart().slice(0, 32).toLowerCase();
  return head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<head');
}

function parseWooJson<T>(body: string): T {
  const trimmed = body.trim();
  if (!trimmed) return null as T;
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    // PHP notices/warnings often prepend the JSON payload.
    const brace = trimmed.indexOf('{');
    const bracket = trimmed.indexOf('[');
    const starts = [brace, bracket].filter((index) => index >= 0);
    if (starts.length === 0) {
      throw new SyntaxError('WooCommerce response was not JSON');
    }
    return JSON.parse(trimmed.slice(Math.min(...starts))) as T;
  }
}

function unreachableError(err: unknown): ConnectorApiError {
  const cause = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  const name = err instanceof Error ? err.name : '';
  const aborted = name === 'AbortError' || name === 'TimeoutError' || /aborted|abort/i.test(cause);
  if (aborted) {
    return new ConnectorApiError({
      message: 'WooCommerce store timed out',
      status: 504,
      kind: 'transient',
    });
  }
  const tls = /ssl|tls|certificate|cert|handshake/i.test(`${name} ${cause}`);
  const suffix = cause ? ` (${cause})` : '';
  return new ConnectorApiError({
    message: tls
      ? `Could not establish a secure connection to the WooCommerce store${suffix}`
      : `Could not reach the WooCommerce store${suffix}`,
    status: 503,
    kind: 'transient',
  });
}

function shouldTryRestRoute(err: ConnectorApiError): boolean {
  if (err.status === 404 || err.status === 405) return true;
  if (err.body && looksLikeHtml(err.body)) return true;
  return (
    err.message.includes('web page instead of JSON') || err.message.includes('was not JSON')
  );
}

function buildWooUrl(args: {
  storeUrl: string;
  path: string;
  search?: Record<string, string | undefined>;
  style: ApiStyle;
  auth: AuthMode;
  consumerKey: string;
  consumerSecret: string;
}): string {
  const resource = args.path.replace(/^\//, '');
  const url =
    args.style === 'pretty'
      ? new URL(`${args.storeUrl}/wp-json/wc/v3/${resource}`)
      : (() => {
          const parsed = new URL(args.storeUrl);
          const basePath = parsed.pathname.replace(/\/+$/, '');
          parsed.pathname = basePath === '' ? '/' : basePath;
          parsed.searchParams.set('rest_route', `/wc/v3/${resource}`);
          return parsed;
        })();

  if (args.search) {
    for (const [key, value] of Object.entries(args.search)) {
      if (value) url.searchParams.set(key, value);
    }
  }
  if (args.auth === 'query') {
    url.searchParams.set('consumer_key', args.consumerKey);
    url.searchParams.set('consumer_secret', args.consumerSecret);
  }
  return url.toString();
}

export class WooCommerceClient {
  readonly storeUrl: string;
  private readonly consumerKey: string;
  private readonly consumerSecret: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(creds: WooCommerceCredentials, options?: { fetchImpl?: typeof fetch; timeoutMs?: number }) {
    this.storeUrl = normalizeStoreUrl(creds.storeUrl);
    this.consumerKey = creds.consumerKey.trim();
    this.consumerSecret = creds.consumerSecret.trim();
    this.fetchImpl = options?.fetchImpl ?? fetch;
    this.timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  private requestHeaders(auth: AuthMode, hasBody: boolean): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'User-Agent': USER_AGENT,
    };
    if (auth === 'basic') {
      headers.Authorization = basicAuth(this.consumerKey, this.consumerSecret);
    }
    if (hasBody) headers['Content-Type'] = 'application/json';
    return headers;
  }

  /**
   * Follow redirects ourselves so Authorization survives host changes
   * (`example.com` → `www.example.com`, http → https). The Fetch spec strips
   * that header on a cross-origin redirect when `redirect: 'follow'`.
   */
  private async fetchFollow(url: string, init: RequestInit, remaining = MAX_REDIRECTS): Promise<Response> {
    const response = await this.fetchImpl(url, { ...init, redirect: 'manual' });
    const status = response.status;
    if (response.type === 'opaqueredirect' || (status === 0 && remaining === MAX_REDIRECTS)) {
      return this.fetchImpl(url, { ...init, redirect: 'follow' });
    }
    const isRedirect = status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
    if (!isRedirect || remaining <= 0) return response;
    const location = response.headers.get('Location') ?? response.headers.get('location');
    if (!location) return response;
    try {
      await response.arrayBuffer();
    } catch {
      /* drain if the runtime requires it */
    }
    const next = new URL(location, url).toString();
    const nextInit: RequestInit = { ...init };
    if (status === 303) {
      nextInit.method = 'GET';
      nextInit.body = undefined;
    }
    return this.fetchFollow(next, nextInit, remaining - 1);
  }

  private async requestWithRetries<T>(
    path: string,
    opts: {
      method: string;
      search?: Record<string, string | undefined>;
      body?: unknown;
      style: ApiStyle;
      auth: AuthMode;
    },
  ): Promise<{ data: T; headers: Headers }> {
    const url = buildWooUrl({
      storeUrl: this.storeUrl,
      path,
      search: opts.search,
      style: opts.style,
      auth: opts.auth,
      consumerKey: this.consumerKey,
      consumerSecret: this.consumerSecret,
    });
    const headers = this.requestHeaders(opts.auth, opts.body !== undefined);

    let lastError: unknown;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const response = await this.fetchFollow(url, {
          method: opts.method,
          headers,
          body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
          signal: controller.signal,
        });
        const text = await response.text();
        if (!response.ok) {
          const error = new ConnectorApiError({
            message:
              response.status === 401 || response.status === 403
                ? 'WooCommerce rejected the consumer key or secret'
                : `WooCommerce request failed (${response.status})`,
            status: response.status,
            kind: classifyStatus(response.status),
            body: text.slice(0, 500),
            retryAfterSeconds: parseRetryAfter(response.headers.get('retry-after')),
          });
          if (!error.retryable || attempt === MAX_RETRIES) throw error;
          lastError = error;
          await sleep(error.retryAfterSeconds ? error.retryAfterSeconds * 1000 : 400 * 2 ** attempt);
          continue;
        }
        if (looksLikeHtml(text)) {
          throw new ConnectorApiError({
            message:
              'WooCommerce REST API returned a web page instead of JSON. Pretty permalinks may be disabled, or a firewall is blocking /wp-json/.',
            status: 502,
            kind: 'permanent',
            body: text.slice(0, 500),
          });
        }
        try {
          return { data: parseWooJson<T>(text), headers: response.headers };
        } catch {
          throw new ConnectorApiError({
            message: 'WooCommerce REST API returned a response that was not JSON',
            status: 502,
            kind: 'permanent',
            body: text.slice(0, 500),
          });
        }
      } catch (err) {
        if (err instanceof ConnectorApiError) {
          if (!err.retryable || attempt === MAX_RETRIES) throw err;
          lastError = err;
          await sleep(err.retryAfterSeconds ? err.retryAfterSeconds * 1000 : 400 * 2 ** attempt);
          continue;
        }
        lastError = err;
        if (attempt === MAX_RETRIES) throw unreachableError(err);
        await sleep(400 * 2 ** attempt);
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastError instanceof ConnectorApiError ? lastError : unreachableError(lastError);
  }

  private async request<T>(
    path: string,
    init?: { method?: string; search?: Record<string, string | undefined>; body?: unknown },
  ): Promise<{
    data: T;
    headers: Headers;
  }> {
    const method = init?.method ?? 'GET';
    const search = init?.search;
    const body = init?.body;
    const run = (style: ApiStyle, auth: AuthMode) =>
      this.requestWithRetries<T>(path, { method, search, body, style, auth });

    try {
      return await run('pretty', 'basic');
    } catch (err) {
      if (err instanceof ConnectorApiError && err.kind === 'auth') {
        return await run('pretty', 'query');
      }
      if (err instanceof ConnectorApiError && shouldTryRestRoute(err)) {
        try {
          return await run('rest_route', 'basic');
        } catch (restErr) {
          if (restErr instanceof ConnectorApiError && restErr.kind === 'auth') {
            return await run('rest_route', 'query');
          }
          throw restErr;
        }
      }
      throw err;
    }
  }

  private async listResource<T>(resource: string, options: WooListOptions = {}): Promise<WooListResult<T>> {
    const page = options.page ?? 1;
    const perPage = options.perPage ?? DEFAULT_PER_PAGE;
    try {
      const { data, headers } = await this.request<T[]>(resource, {
        search: {
          page: String(page),
          per_page: String(perPage),
          modified_after: options.modifiedAfter,
        },
      });
      const items = Array.isArray(data) ? data : [];
      const totalPages = Number(headers.get('x-wp-totalpages') ?? 1) || 1;
      const total = Number(headers.get('x-wp-total') ?? items.length) || items.length;
      return { items, page, totalPages, total };
    } catch (err) {
      // Customers (and some older WC versions) reject `modified_after`.
      if (err instanceof ConnectorApiError && err.status === 400 && options.modifiedAfter) {
        return this.listResource(resource, { ...options, modifiedAfter: undefined });
      }
      throw err;
    }
  }

  /** Cheap read used to verify credentials before saving a connection. */
  async test(): Promise<{ ok: true; storeUrl: string } | { ok: false; message: string }> {
    try {
      await this.request('products', { search: { per_page: '1' } });
      return { ok: true, storeUrl: this.storeUrl };
    } catch (err) {
      const message =
        err instanceof ConnectorApiError ? err.message : 'Could not reach the WooCommerce store';
      return { ok: false, message };
    }
  }

  listProducts(options?: WooListOptions) {
    return this.listResource<Record<string, unknown>>('products', options);
  }

  listOrders(options?: WooListOptions) {
    return this.listResource<Record<string, unknown>>('orders', options);
  }

  listCustomers(options?: WooListOptions) {
    return this.listResource<Record<string, unknown>>('customers', options);
  }

  async getProduct(id: string) {
    const { data } = await this.request<Record<string, unknown>>(`products/${id}`);
    return data;
  }

  async getOrder(id: string) {
    const { data } = await this.request<Record<string, unknown>>(`orders/${id}`);
    return data;
  }

  async getCustomer(id: string) {
    const { data } = await this.request<Record<string, unknown>>(`customers/${id}`);
    return data;
  }

  async createWebhook(args: {
    name: string;
    topic: string;
    deliveryUrl: string;
    secret: string;
  }): Promise<{ id: string; topic: string; deliveryUrl: string }> {
    const { data } = await this.request<{ id: number; topic: string; delivery_url: string }>('webhooks', {
      method: 'POST',
      body: {
        name: args.name,
        topic: args.topic,
        delivery_url: args.deliveryUrl,
        secret: args.secret,
        status: 'active',
      },
    });
    return { id: String(data.id), topic: data.topic, deliveryUrl: data.delivery_url };
  }

  async deleteWebhook(id: string): Promise<void> {
    await this.request(`webhooks/${id}`, { method: 'DELETE', search: { force: 'true' } });
  }
}

export function createWooCommerceClient(
  creds: WooCommerceCredentials,
  options?: { fetchImpl?: typeof fetch; timeoutMs?: number },
): WooCommerceClient {
  return new WooCommerceClient(creds, options);
}
