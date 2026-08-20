/**
 * WooCommerce REST API client (v3).
 *
 * Auth is HTTP Basic with the store's consumer key/secret. Merchants grant
 * those keys through WooCommerce's `/wc-auth/v1/authorize` endpoint (store URL
 * + Connect); they can still paste a pair generated under
 * WooCommerce → Settings → Advanced → REST API.
 */

import {
  classifyStatus,
  ConnectorApiError,
  parseRetryAfter,
  type ExternalProductRef,
  type OutboundCatalogProduct,
} from '../types';

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

  private async request<T>(
    path: string,
    init?: { method?: string; search?: Record<string, string | undefined>; body?: unknown },
  ): Promise<{
    data: T;
    headers: Headers;
  }> {
    const url = new URL(`${this.storeUrl}/wp-json/wc/v3/${path.replace(/^\//, '')}`);
    if (init?.search) {
      for (const [key, value] of Object.entries(init.search)) {
        if (value) url.searchParams.set(key, value);
      }
    }
    // Some hosts strip the Authorization header; WooCommerce accepts the
    // consumer key pair as query params as a documented fallback.
    url.searchParams.set('consumer_key', this.consumerKey);
    url.searchParams.set('consumer_secret', this.consumerSecret);

    let lastError: unknown;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const method = init?.method ?? 'GET';
        const response = await this.fetchImpl(url.toString(), {
          method,
          headers: {
            Authorization: basicAuth(this.consumerKey, this.consumerSecret),
            Accept: 'application/json',
            ...(init?.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          },
          body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
          signal: controller.signal,
        });
        const body = await response.text();
        if (!response.ok) {
          const kind = classifyStatus(response.status);
          const error = new ConnectorApiError({
            message:
              response.status === 401 || response.status === 403
                ? 'WooCommerce rejected the consumer key or secret'
                : `WooCommerce request failed (${response.status})`,
            status: response.status,
            kind,
            body: body.slice(0, 500),
            retryAfterSeconds: parseRetryAfter(response.headers.get('retry-after')),
          });
          if (!error.retryable || attempt === MAX_RETRIES) throw error;
          lastError = error;
          await sleep(error.retryAfterSeconds ? error.retryAfterSeconds * 1000 : 400 * 2 ** attempt);
          continue;
        }
        return { data: (body ? JSON.parse(body) : null) as T, headers: response.headers };
      } catch (err) {
        if (err instanceof ConnectorApiError) throw err;
        lastError = err;
        if (attempt === MAX_RETRIES) {
          throw new ConnectorApiError({
            message: 'Could not reach the WooCommerce store',
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
      : new ConnectorApiError({ message: 'WooCommerce request failed', status: 503, kind: 'transient' });
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

  /**
   * Match an existing simple product by SKU so we can link instead of
   * creating a duplicate listing when the merchant already has the item.
   */
  async findProductBySku(sku: string): Promise<ExternalProductRef | null> {
    const trimmed = sku.trim();
    if (!trimmed) return null;
    const { data } = await this.request<Array<Record<string, unknown>>>('products', {
      search: { sku: trimmed, per_page: '1' },
    });
    const match = Array.isArray(data) ? data[0] : undefined;
    if (!match || match.id === undefined || match.id === null) return null;
    return {
      id: String(match.id),
      url: typeof match.permalink === 'string' ? match.permalink : null,
    };
  }

  async createProduct(product: OutboundCatalogProduct): Promise<ExternalProductRef> {
    const { data } = await this.request<Record<string, unknown>>('products', {
      method: 'POST',
      body: toWooProductBody(product),
    });
    return wooProductRef(data, this.storeUrl);
  }

  async updateProduct(id: string, product: OutboundCatalogProduct): Promise<ExternalProductRef> {
    const { data } = await this.request<Record<string, unknown>>(`products/${id}`, {
      method: 'PUT',
      body: toWooProductBody(product),
    });
    return wooProductRef(data, this.storeUrl);
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

function toWooProductBody(product: OutboundCatalogProduct): Record<string, unknown> {
  const images = (product.images ?? [])
    .filter((img) => img.url)
    .map((img) => ({ src: img.url, alt: img.altText || undefined }));
  return {
    name: product.name,
    type: 'simple',
    status: product.status === 'active' ? 'publish' : 'draft',
    description: product.description ?? '',
    short_description: product.shortDescription ?? '',
    sku: product.sku?.trim() || undefined,
    regular_price: product.price,
    slug: product.slug || undefined,
    weight: product.weight || undefined,
    dimensions:
      product.length || product.width || product.height
        ? {
            length: product.length ?? '',
            width: product.width ?? '',
            height: product.height ?? '',
          }
        : undefined,
    images: images.length ? images : undefined,
  };
}

function wooProductRef(data: Record<string, unknown>, storeUrl: string): ExternalProductRef {
  const id = data.id !== undefined && data.id !== null ? String(data.id) : '';
  const url =
    typeof data.permalink === 'string'
      ? data.permalink
      : id
        ? `${storeUrl}/?p=${id}`
        : null;
  return { id, url };
}

export function createWooCommerceClient(
  creds: WooCommerceCredentials,
  options?: { fetchImpl?: typeof fetch; timeoutMs?: number },
): WooCommerceClient {
  return new WooCommerceClient(creds, options);
}
