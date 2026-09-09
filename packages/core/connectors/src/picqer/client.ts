/**
 * Picqer REST API client (v1).
 *
 * Auth: HTTP Basic with the API key as username (password ignored).
 * Base URL: https://{subdomain}.picqer.com/api/v1/
 * Pagination: offset + 100-item pages.
 * Webhooks: POST /hooks with X-Picqer-Signature (HMAC-SHA256 Base64).
 */

import type { ConnectorSyncDef, ConnectorSyncSettingKey } from '../catalog';
import type { ConnectorListPage, ConnectorProviderClient, ConnectorWebhookCreated } from '../provider-client';
import type { ConnectorWebhookTopic } from '../webhooks';
import {
  bindFetch,
  classifyStatus,
  ConnectorApiError,
  parseRetryAfter,
  type ExternalProductRef,
  type OutboundCatalogProduct,
} from '../types';

export const PICQER_USER_AGENT = 'WeldSuite Picqer Connector (weldsuite.com)';
const DEFAULT_LIMIT = 100;
const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_RETRIES = 2;

export interface PicqerCredentials {
  subdomain: string;
  apiKey: string;
}

export interface PicqerListOptions {
  offset?: number;
  limit?: number;
  /** Picqer filter — ISO-ish datetime string where supported. */
  updatedAfter?: string;
  sinceid?: string;
  sincedate?: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function normalizePicqerSubdomain(subdomain: string): string {
  const trimmed = subdomain
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\.picqer\.com.*$/i, '')
    .replace(/\/+$/, '')
    .toLowerCase();
  if (!trimmed) {
    throw new ConnectorApiError({ message: 'Picqer subdomain is required', status: 400, kind: 'permanent' });
  }
  if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/.test(trimmed)) {
    throw new ConnectorApiError({ message: 'Picqer subdomain is not valid', status: 400, kind: 'permanent' });
  }
  return trimmed;
}

/** Expand product.stock[] rows into inventory sync records. */
export function expandPicqerProductStock(
  product: Record<string, unknown>,
): Array<Record<string, unknown>> {
  const idproduct = product.idproduct ?? product.id;
  if (idproduct === undefined || idproduct === null) return [];
  const stock = Array.isArray(product.stock) ? (product.stock as Array<Record<string, unknown>>) : [];
  return stock.map((row) => {
    const idwarehouse = row.idwarehouse;
    return {
      id: `${idproduct}:${idwarehouse ?? '0'}`,
      idproduct,
      idwarehouse,
      stock: row.stock ?? 0,
      reserved: row.reserved ?? 0,
      freestock: row.freestock ?? row.stock ?? 0,
      freepickablestock: row.freepickablestock ?? row.freestock ?? 0,
      productcode: product.productcode,
      name: product.name,
      barcode: product.barcode,
    };
  });
}

export class PicqerClient implements ConnectorProviderClient {
  readonly subdomain: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(creds: PicqerCredentials, options?: { fetchImpl?: typeof fetch; timeoutMs?: number }) {
    this.subdomain = normalizePicqerSubdomain(creds.subdomain);
    this.apiKey = creds.apiKey.trim();
    this.fetchImpl = bindFetch(options?.fetchImpl);
    this.timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  get storeUrl(): string {
    return `https://${this.subdomain}.picqer.com`;
  }

  private get apiBase(): string {
    return `${this.storeUrl}/api/v1`;
  }

  private authHeader(): string {
    return `Basic ${btoa(`${this.apiKey}:`)}`;
  }

  async request<T>(
    path: string,
    init?: { method?: string; search?: Record<string, string | undefined>; body?: unknown },
  ): Promise<{ data: T; headers: Headers }> {
    const url = new URL(`${this.apiBase}/${path.replace(/^\//, '')}`);
    if (init?.search) {
      for (const [key, value] of Object.entries(init.search)) {
        if (value !== undefined && value !== '') url.searchParams.set(key, value);
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
            Authorization: this.authHeader(),
            Accept: 'application/json',
            'User-Agent': PICQER_USER_AGENT,
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
                ? 'Picqer rejected the API key'
                : `Picqer request failed (${response.status})`,
            status: response.status,
            kind,
            body: text.slice(0, 500),
            retryAfterSeconds: parseRetryAfter(response.headers.get('retry-after')) ?? (response.status === 429 ? 20 : undefined),
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
            message: 'Could not reach Picqer',
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
      : new ConnectorApiError({ message: 'Picqer request failed', status: 503, kind: 'transient' });
  }

  async test(): Promise<{ ok: true; storeUrl: string } | { ok: false; message: string }> {
    try {
      await this.request('products', { search: { offset: '0' } });
      return { ok: true, storeUrl: this.storeUrl };
    } catch (err) {
      const message = err instanceof ConnectorApiError ? err.message : 'Could not reach Picqer';
      return { ok: false, message };
    }
  }

  private async listOffset(
    path: string,
    options: PicqerListOptions = {},
    extraSearch?: Record<string, string | undefined>,
  ): Promise<{ items: Array<Record<string, unknown>>; nextOffset: number | null }> {
    const limit = options.limit ?? DEFAULT_LIMIT;
    const offset = options.offset ?? 0;
    const { data } = await this.request<Array<Record<string, unknown>> | Record<string, unknown>>(path, {
      search: {
        offset: String(offset),
        ...extraSearch,
        updated_after: options.updatedAfter,
        sinceid: options.sinceid,
        sincedate: options.sincedate,
      },
    });
    const items = Array.isArray(data) ? data : [];
    return {
      items,
      nextOffset: items.length >= limit ? offset + items.length : null,
    };
  }

  listProducts(options?: PicqerListOptions) {
    return this.listOffset('products', options);
  }

  listOrders(options?: PicqerListOptions) {
    return this.listOffset('orders', options);
  }

  listCustomers(options?: PicqerListOptions) {
    return this.listOffset('customers', options);
  }

  listWarehouses(options?: PicqerListOptions) {
    return this.listOffset('warehouses', options);
  }

  listLocations(options?: PicqerListOptions) {
    return this.listOffset('locations', options);
  }

  listPicklists(options?: PicqerListOptions) {
    return this.listOffset('picklists', options);
  }

  listSuppliers(options?: PicqerListOptions) {
    return this.listOffset('suppliers', options);
  }

  listPurchaseOrders(options?: PicqerListOptions) {
    return this.listOffset('purchaseorders', options);
  }

  listReturns(options?: PicqerListOptions) {
    return this.listOffset('returns', options);
  }

  listMovements(options?: PicqerListOptions) {
    return this.listOffset('movements', options);
  }

  /** Location stock counts — Picqer endpoint varies; list and tolerate empty. */
  async listStockCounts(options?: PicqerListOptions) {
    try {
      return await this.listOffset('locationstockcounts', options);
    } catch (err) {
      if (err instanceof ConnectorApiError && err.status === 404) {
        return { items: [] as Array<Record<string, unknown>>, nextOffset: null };
      }
      throw err;
    }
  }

  async listShipmentsFromPicklists(options?: PicqerListOptions): Promise<{
    items: Array<Record<string, unknown>>;
    nextOffset: number | null;
  }> {
    const page = await this.listPicklists(options);
    const shipments: Array<Record<string, unknown>> = [];
    for (const picklist of page.items) {
      const idpicklist = picklist.idpicklist ?? picklist.id;
      const nested = Array.isArray(picklist.shipments)
        ? (picklist.shipments as Array<Record<string, unknown>>)
        : [];
      for (const shipment of nested) {
        const idshipment = shipment.idshipment ?? shipment.id;
        shipments.push({
          ...shipment,
          id: idshipment !== undefined && idshipment !== null ? String(idshipment) : undefined,
          idshipment,
          idpicklist,
        });
      }
    }
    return { items: shipments, nextOffset: page.nextOffset };
  }

  async listInventory(options?: PicqerListOptions): Promise<{
    items: Array<Record<string, unknown>>;
    nextOffset: number | null;
  }> {
    const page = await this.listProducts(options);
    const items = page.items.flatMap((product) => expandPicqerProductStock(product));
    return { items, nextOffset: page.nextOffset };
  }

  async hasUpdatesSince(
    resource: ConnectorSyncSettingKey,
    since?: string,
  ): Promise<boolean> {
    const options: PicqerListOptions = { limit: 1, updatedAfter: since, sincedate: since };
    const page = await this.listForSettingKey(resource, options);
    return page.items.length > 0;
  }

  async countResource(resource: ConnectorSyncSettingKey): Promise<number> {
    // Picqer has no count endpoints — sample first page length as a fingerprint proxy.
    const page = await this.listForSettingKey(resource, { limit: DEFAULT_LIMIT, offset: 0 });
    return page.items.length;
  }

  private async listForSettingKey(
    resource: ConnectorSyncSettingKey,
    options: PicqerListOptions,
  ): Promise<{ items: Array<Record<string, unknown>>; nextOffset: number | null }> {
    switch (resource) {
      case 'products':
        return this.listProducts(options);
      case 'orders':
        return this.listOrders(options);
      case 'customers':
        return this.listCustomers(options);
      case 'inventory':
        return this.listInventory(options);
      case 'warehouses':
        return this.listWarehouses(options);
      case 'locations':
        return this.listLocations(options);
      case 'picklists':
        return this.listPicklists(options);
      case 'shipments':
        return this.listShipmentsFromPicklists(options);
      case 'suppliers':
        return this.listSuppliers(options);
      case 'purchaseOrders':
        return this.listPurchaseOrders(options);
      case 'returns':
        return this.listReturns(options);
      case 'stockCounts':
        return this.listStockCounts(options);
      case 'movements':
        return this.listMovements(options);
      default:
        return { items: [], nextOffset: null };
    }
  }

  async listSync(
    sync: ConnectorSyncDef,
    options: { page: number; cursor: string | null; limit: number; modifiedAfter?: string },
  ): Promise<ConnectorListPage> {
    const offset = options.cursor
      ? Number(options.cursor)
      : Math.max(0, (options.page - 1) * options.limit);
    const result = await this.listForSettingKey(sync.settingKey, {
      offset: Number.isFinite(offset) ? offset : 0,
      limit: options.limit,
      updatedAfter: options.cursor ? undefined : options.modifiedAfter,
      sincedate: options.cursor ? undefined : options.modifiedAfter,
    });
    return {
      items: result.items,
      done: result.nextOffset === null,
      nextCursor: result.nextOffset !== null ? String(result.nextOffset) : null,
    };
  }

  async createWebhook(
    event: string,
    address: string,
    secret: string,
  ): Promise<{ id: string; topic: string; address: string }> {
    const { data } = await this.request<Record<string, unknown>>('hooks', {
      method: 'POST',
      body: {
        name: `WeldSuite ${event}`,
        event,
        address,
        secret,
      },
    });
    const id = data.idhook ?? data.id;
    return {
      id: id !== undefined && id !== null ? String(id) : '',
      topic: event,
      address,
    };
  }

  async deleteWebhook(id: string): Promise<void> {
    await this.request(`hooks/${id}`, { method: 'DELETE' });
  }

  async registerWebhooks(args: {
    deliveryUrl: string;
    secret: string;
    topics: ConnectorWebhookTopic[];
  }): Promise<ConnectorWebhookCreated[]> {
    const registrations: ConnectorWebhookCreated[] = [];
    for (const topic of args.topics) {
      const created = await this.createWebhook(topic.topic, args.deliveryUrl, args.secret);
      if (created.id) {
        registrations.push({
          id: created.id,
          topic: created.topic,
          deliveryUrl: created.address,
        });
      }
    }
    return registrations;
  }

  async findProductBySku(sku: string): Promise<ExternalProductRef | null> {
    const trimmed = sku.trim();
    if (!trimmed) return null;
    const { data } = await this.request<Array<Record<string, unknown>>>('products', {
      search: { productcode: trimmed },
    });
    const product = Array.isArray(data) ? data[0] : null;
    if (!product) return null;
    const id = product.idproduct ?? product.id;
    if (id === undefined || id === null) return null;
    return { id: String(id), url: null };
  }

  async createProduct(product: OutboundCatalogProduct): Promise<ExternalProductRef> {
    const { data } = await this.request<Record<string, unknown>>('products', {
      method: 'POST',
      body: toPicqerProductBody(product),
    });
    const id = data.idproduct ?? data.id;
    return { id: id !== undefined && id !== null ? String(id) : '', url: null };
  }

  async updateProduct(id: string, product: OutboundCatalogProduct): Promise<ExternalProductRef> {
    const { data } = await this.request<Record<string, unknown>>(`products/${id}`, {
      method: 'PUT',
      body: toPicqerProductBody(product),
    });
    const remoteId = data.idproduct ?? data.id ?? id;
    return { id: String(remoteId), url: null };
  }

  async deleteProduct(id: string): Promise<void> {
    await this.request(`products/${id}`, { method: 'DELETE' });
  }

  async createCustomer(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const { data } = await this.request<Record<string, unknown>>('customers', {
      method: 'POST',
      body,
    });
    return data;
  }

  async updateCustomer(id: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const { data } = await this.request<Record<string, unknown>>(`customers/${id}`, {
      method: 'PUT',
      body,
    });
    return data;
  }

  async createOrder(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const { data } = await this.request<Record<string, unknown>>('orders', {
      method: 'POST',
      body,
    });
    return data;
  }

  async updateOrder(id: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const { data } = await this.request<Record<string, unknown>>(`orders/${id}`, {
      method: 'PUT',
      body,
    });
    return data;
  }

  async createSupplier(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const { data } = await this.request<Record<string, unknown>>('suppliers', {
      method: 'POST',
      body,
    });
    return data;
  }

  async updateSupplier(id: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const { data } = await this.request<Record<string, unknown>>(`suppliers/${id}`, {
      method: 'PUT',
      body,
    });
    return data;
  }

  async createPurchaseOrder(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const { data } = await this.request<Record<string, unknown>>('purchaseorders', {
      method: 'POST',
      body,
    });
    return data;
  }

  async createReturn(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const { data } = await this.request<Record<string, unknown>>('returns', {
      method: 'POST',
      body,
    });
    return data;
  }

  async createWarehouse(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const { data } = await this.request<Record<string, unknown>>('warehouses', {
      method: 'POST',
      body,
    });
    return data;
  }

  async updateWarehouse(id: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const { data } = await this.request<Record<string, unknown>>(`warehouses/${id}`, {
      method: 'PUT',
      body,
    });
    return data;
  }

  /** Change stock for a product in a warehouse (Picqer product stock change). */
  async changeProductStock(args: {
    productId: string;
    warehouseId: string;
    amount: number;
  }): Promise<void> {
    await this.request(`products/${args.productId}/stock`, {
      method: 'POST',
      body: {
        idwarehouse: Number(args.warehouseId) || args.warehouseId,
        amount: args.amount,
      },
    });
  }
}

function toPicqerProductBody(product: OutboundCatalogProduct): Record<string, unknown> {
  return {
    name: product.name,
    productcode: product.sku?.trim() || undefined,
    description: product.description ?? '',
    price: Number(product.price) || 0,
    weight: product.weight ? Number(product.weight) : undefined,
    active: product.status === 'active',
    barcode: undefined,
  };
}

export function createPicqerClient(
  creds: PicqerCredentials,
  options?: { fetchImpl?: typeof fetch; timeoutMs?: number },
): PicqerClient {
  return new PicqerClient(creds, options);
}
