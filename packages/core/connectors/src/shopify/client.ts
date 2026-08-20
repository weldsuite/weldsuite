/**
 * Shopify Admin REST client (2024-10).
 *
 * Auth is a custom-app Admin API access token (`shpat_…`) plus the shop
 * domain. Webhook HMAC uses the custom-app API secret (`shpss_…`).
 */

import { bindFetch, classifyStatus, ConnectorApiError, parseRetryAfter } from '../types';

export const SHOPIFY_API_VERSION = '2024-10';

export interface ShopifyCredentials {
  shopDomain: string;
  accessToken: string;
  apiSecret: string;
}

export interface ShopifyListOptions {
  pageInfo?: string;
  limit?: number;
  /** ISO timestamp — `updated_at_min`. */
  updatedAtMin?: string;
}

export interface ShopifyListResult<T> {
  items: T[];
  nextPageInfo: string | null;
}

const DEFAULT_LIMIT = 100;
const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_RETRIES = 2;

export function normalizeShopDomain(domain: string): string {
  const trimmed = domain.trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  if (!trimmed) {
    throw new ConnectorApiError({ message: 'Shop domain is required', status: 400, kind: 'permanent' });
  }
  const host = trimmed.split('/')[0]?.toLowerCase() ?? '';
  if (!host.includes('.')) {
    return `${host}.myshopify.com`;
  }
  if (!/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/.test(host)) {
    throw new ConnectorApiError({ message: 'Shop domain is not valid', status: 400, kind: 'permanent' });
  }
  return host;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseNextPageInfo(linkHeader: string | null): string | null {
  if (!linkHeader) return null;
  const match = linkHeader.split(',').find((part) => part.includes('rel="next"'));
  if (!match) return null;
  const urlMatch = match.match(/<([^>]+)>/);
  if (!urlMatch?.[1]) return null;
  try {
    return new URL(urlMatch[1]).searchParams.get('page_info');
  } catch {
    return null;
  }
}

export class ShopifyClient {
  readonly shopDomain: string;
  private readonly accessToken: string;
  readonly apiSecret: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(creds: ShopifyCredentials, options?: { fetchImpl?: typeof fetch; timeoutMs?: number }) {
    this.shopDomain = normalizeShopDomain(creds.shopDomain);
    this.accessToken = creds.accessToken.trim();
    this.apiSecret = creds.apiSecret.trim();
    this.fetchImpl = bindFetch(options?.fetchImpl);
    this.timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  get storeUrl(): string {
    return `https://${this.shopDomain}`;
  }

  private async request<T>(
    path: string,
    init?: { method?: string; search?: Record<string, string | undefined>; body?: unknown },
  ): Promise<{ data: T; headers: Headers }> {
    const url = new URL(`${this.storeUrl}/admin/api/${SHOPIFY_API_VERSION}/${path.replace(/^\//, '')}`);
    if (init?.search) {
      for (const [key, value] of Object.entries(init.search)) {
        if (value) url.searchParams.set(key, value);
      }
    }

    let lastError: unknown;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const method = init?.method ?? 'GET';
        const response = await this.fetchImpl(url.toString(), {
          method,
          headers: {
            'X-Shopify-Access-Token': this.accessToken,
            Accept: 'application/json',
            ...(init?.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          },
          body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
          signal: controller.signal,
        });
        const text = await response.text();
        if (!response.ok) {
          const kind = classifyStatus(response.status);
          const error = new ConnectorApiError({
            message:
              response.status === 401 || response.status === 403
                ? 'Shopify rejected the Admin API access token'
                : `Shopify request failed (${response.status})`,
            status: response.status,
            kind,
            body: text.slice(0, 500),
            retryAfterSeconds: parseRetryAfter(response.headers.get('retry-after')),
          });
          if (!error.retryable || attempt === MAX_RETRIES) throw error;
          lastError = error;
          await sleep(error.retryAfterSeconds ? error.retryAfterSeconds * 1000 : 400 * 2 ** attempt);
          continue;
        }
        return { data: (text ? JSON.parse(text) : null) as T, headers: response.headers };
      } catch (err) {
        if (err instanceof ConnectorApiError) throw err;
        lastError = err;
        if (attempt === MAX_RETRIES) {
          throw new ConnectorApiError({
            message: 'Could not reach the Shopify store',
            status: 503,
            kind: 'transient',
          });
        }
        await sleep(400 * 2 ** attempt);
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new ConnectorApiError({ message: 'Shopify request failed', status: 503, kind: 'transient' });
  }

  async test(): Promise<{ ok: true; storeUrl: string } | { ok: false; message: string }> {
    try {
      await this.request('products.json', { search: { limit: '1' } });
      return { ok: true, storeUrl: this.storeUrl };
    } catch (err) {
      const message = err instanceof ConnectorApiError ? err.message : 'Could not reach the Shopify store';
      return { ok: false, message };
    }
  }

  private async listResource<T>(
    path: string,
    envelope: string,
    options: ShopifyListOptions = {},
  ): Promise<ShopifyListResult<T>> {
    const { data, headers } = await this.request<Record<string, T[]>>(path, {
      search: options.pageInfo
        ? { limit: String(options.limit ?? DEFAULT_LIMIT), page_info: options.pageInfo }
        : {
            limit: String(options.limit ?? DEFAULT_LIMIT),
            updated_at_min: options.updatedAtMin,
            ...(path === 'orders.json' ? { status: 'any' } : {}),
          },
    });
    const items = Array.isArray(data?.[envelope]) ? data[envelope] : [];
    return { items, nextPageInfo: parseNextPageInfo(headers.get('link')) };
  }

  listProducts(options?: ShopifyListOptions) {
    return this.listResource<Record<string, unknown>>('products.json', 'products', options);
  }

  listOrders(options?: ShopifyListOptions) {
    return this.listResource<Record<string, unknown>>('orders.json', 'orders', options);
  }

  listCustomers(options?: ShopifyListOptions) {
    return this.listResource<Record<string, unknown>>('customers.json', 'customers', options);
  }

  async getProduct(id: string) {
    const { data } = await this.request<{ product: Record<string, unknown> }>(`products/${id}.json`);
    return data.product;
  }

  async getOrder(id: string) {
    const { data } = await this.request<{ order: Record<string, unknown> }>(`orders/${id}.json`);
    return data.order;
  }

  async getCustomer(id: string) {
    const { data } = await this.request<{ customer: Record<string, unknown> }>(`customers/${id}.json`);
    return data.customer;
  }

  async createWebhook(topic: string, address: string): Promise<{ id: string; topic: string; address: string }> {
    const { data } = await this.request<{ webhook: { id: number; topic: string; address: string } }>('webhooks.json', {
      method: 'POST',
      body: { webhook: { topic, address, format: 'json' } },
    });
    return { id: String(data.webhook.id), topic: data.webhook.topic, address: data.webhook.address };
  }

  async deleteWebhook(id: string): Promise<void> {
    await this.request(`webhooks/${id}.json`, { method: 'DELETE' });
  }
}

export function createShopifyClient(
  creds: ShopifyCredentials,
  options?: { fetchImpl?: typeof fetch; timeoutMs?: number },
): ShopifyClient {
  return new ShopifyClient(creds, options);
}
