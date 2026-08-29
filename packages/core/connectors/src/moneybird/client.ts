/**
 * Moneybird API v2 client.
 *
 * Auth is an OAuth access token plus an administration id. Webhooks are a
 * single registration with an `enabled_events` list; Moneybird signs deliveries
 * with a secret returned only at create time.
 *
 * @see https://developer.moneybird.com/
 */

import type { ConnectorSyncDef, ConnectorSyncSettingKey } from '../catalog';
import type { ConnectorListPage, ConnectorProviderClient, ConnectorWebhookCreated } from '../provider-client';
import {
  bindFetch,
  classifyStatus,
  ConnectorApiError,
  parseRetryAfter,
} from '../types';
import type { ConnectorWebhookTopic } from '../webhooks';
import { MONEYBIRD_API_BASE, type MoneybirdAdministration } from './auth';

export interface MoneybirdCredentials {
  accessToken: string;
  administrationId?: string | null;
  refreshToken?: string | null;
}

export interface MoneybirdListOptions {
  page?: number;
  perPage?: number;
  updatedAfter?: string;
}

const DEFAULT_PER_PAGE = 100;
const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_RETRIES = 2;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseNextPage(linkHeader: string | null, currentPage: number, itemCount: number, perPage: number): {
  done: boolean;
  nextCursor: string | null;
} {
  if (linkHeader) {
    const hasNext = linkHeader.split(',').some((part) => part.includes('rel="next"'));
    return { done: !hasNext || itemCount === 0, nextCursor: hasNext ? String(currentPage + 1) : null };
  }
  return {
    done: itemCount < perPage || itemCount === 0,
    nextCursor: itemCount < perPage ? null : String(currentPage + 1),
  };
}

/**
 * Moneybird list `filter` is comma-separated `key:value` terms. Any value we
 * send replaces the server default (`period:this_year` on invoices/documents),
 * so pass `state:all` and omit period to backfill every year. A synthetic
 * `YYYYMMDD..YYYYMMDD` spanning decades is rejected with HTTP 400.
 */
function listFilter(options: { updatedAfter?: string; extra?: string }): string | undefined {
  const parts: string[] = [];
  if (options.extra) parts.push(options.extra);
  if (options.updatedAfter) parts.push(`updated_after:${options.updatedAfter}`);
  return parts.length ? parts.join(',') : undefined;
}

export class MoneybirdClient implements ConnectorProviderClient {
  readonly administrationId: string;
  private readonly accessToken: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(creds: MoneybirdCredentials, options?: { fetchImpl?: typeof fetch; timeoutMs?: number }) {
    this.administrationId = (creds.administrationId ?? '').trim();
    this.accessToken = creds.accessToken.trim();
    this.fetchImpl = bindFetch(options?.fetchImpl);
    this.timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  get storeUrl(): string {
    return this.administrationId
      ? `https://moneybird.com/${this.administrationId}`
      : 'https://moneybird.com';
  }

  private async request<T>(
    path: string,
    init?: { method?: string; search?: Record<string, string | undefined>; body?: unknown; skipAdmin?: boolean },
  ): Promise<{ data: T; headers: Headers }> {
    const root = init?.skipAdmin
      ? MONEYBIRD_API_BASE
      : `${MONEYBIRD_API_BASE}/${this.administrationId}`;
    if (!init?.skipAdmin && !this.administrationId) {
      throw new ConnectorApiError({
        message: 'Moneybird administration is not selected',
        status: 400,
        kind: 'permanent',
      });
    }
    const url = new URL(`${root}/${path.replace(/^\//, '')}`);
    if (!url.pathname.endsWith('.json')) url.pathname = `${url.pathname}.json`;
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
            Authorization: `Bearer ${this.accessToken}`,
            Accept: 'application/json',
            ...(init?.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          },
          body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
          signal: controller.signal,
        });
        const text = await response.text();
        if (!response.ok) {
          const kind = classifyStatus(response.status);
          const snippet = text.replace(/\s+/g, ' ').trim().slice(0, 200);
          const error = new ConnectorApiError({
            message:
              response.status === 401 || response.status === 403
                ? 'Moneybird rejected the access token'
                : snippet
                  ? `Moneybird request failed (${response.status}): ${snippet}`
                  : `Moneybird request failed (${response.status})`,
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
            message: 'Could not reach Moneybird',
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
      : new ConnectorApiError({ message: 'Moneybird request failed', status: 503, kind: 'transient' });
  }

  async test(): Promise<{ ok: true; storeUrl: string } | { ok: false; message: string }> {
    try {
      if (this.administrationId) {
        await this.request('contacts', { search: { per_page: '1' } });
      } else {
        await this.listAdministrations();
      }
      return { ok: true, storeUrl: this.storeUrl };
    } catch (err) {
      const message = err instanceof ConnectorApiError ? err.message : 'Could not reach Moneybird';
      return { ok: false, message };
    }
  }

  async listAdministrations(): Promise<MoneybirdAdministration[]> {
    const { data } = await this.request<Array<Record<string, unknown>>>('administrations', { skipAdmin: true });
    const rows = Array.isArray(data) ? data : [];
    return rows
      .map((row) => ({
        id: row.id !== undefined && row.id !== null ? String(row.id) : '',
        name: typeof row.name === 'string' ? row.name : typeof row.company_name === 'string' ? row.company_name : row.id !== undefined ? String(row.id) : '',
        language: typeof row.language === 'string' ? row.language : null,
        currency: typeof row.currency === 'string' ? row.currency : null,
      }))
      .filter((row) => row.id);
  }

  private async listPath(
    path: string,
    options: MoneybirdListOptions,
    filter?: string,
  ): Promise<ConnectorListPage> {
    const page = options.page ?? 1;
    const perPage = options.perPage ?? DEFAULT_PER_PAGE;
    const { data, headers } = await this.request<Array<Record<string, unknown>>>(path, {
      search: {
        page: String(page),
        per_page: String(perPage),
        filter,
      },
    });
    const items = Array.isArray(data) ? data : [];
    const next = parseNextPage(headers.get('link'), page, items.length, perPage);
    return { items, done: next.done, nextCursor: next.nextCursor };
  }

  listContacts(options: MoneybirdListOptions = {}) {
    return this.listPath('contacts', options, listFilter({ updatedAfter: options.updatedAfter }));
  }

  listSalesInvoices(options: MoneybirdListOptions = {}) {
    return this.listPath(
      'sales_invoices',
      options,
      listFilter({ updatedAfter: options.updatedAfter, extra: 'state:all' }),
    );
  }

  listProducts(options: MoneybirdListOptions = {}) {
    return this.listPath('products', options, listFilter({ updatedAfter: options.updatedAfter }));
  }

  listPurchaseInvoices(options: MoneybirdListOptions = {}) {
    return this.listPath(
      'documents/purchase_invoices',
      options,
      listFilter({ updatedAfter: options.updatedAfter, extra: 'state:all' }),
    );
  }

  listReceipts(options: MoneybirdListOptions = {}) {
    return this.listPath(
      'documents/receipts',
      options,
      listFilter({ updatedAfter: options.updatedAfter, extra: 'state:all' }),
    );
  }

  /**
   * Active financial accounts only (Moneybird omits archived). No pagination —
   * the endpoint returns the full set.
   */
  async listFinancialAccounts(_options: MoneybirdListOptions = {}): Promise<ConnectorListPage> {
    const { data } = await this.request<Array<Record<string, unknown>>>('financial_accounts');
    const items = Array.isArray(data) ? data : [];
    return { items, done: true, nextCursor: null };
  }

  /**
   * Financial mutations use the synchronisation API (plain list is capped at
   * 100 and rejects large result sets). Cursor is a 1-based page into the
   * filtered id list; each page POSTs up to `perPage` ids.
   */
  async listFinancialMutations(options: MoneybirdListOptions = {}): Promise<ConnectorListPage> {
    const page = options.page ?? 1;
    const perPage = options.perPage ?? DEFAULT_PER_PAGE;
    const { data: versions } = await this.request<Array<{ id?: unknown; version?: unknown }>>(
      'financial_mutations/synchronization',
    );
    const rows = Array.isArray(versions) ? versions : [];
    const sinceMs = options.updatedAfter ? Date.parse(options.updatedAfter) : NaN;
    const filtered = Number.isFinite(sinceMs)
      ? rows.filter((row) => {
          const version = typeof row.version === 'number' ? row.version : Number(row.version);
          if (!Number.isFinite(version)) return true;
          // Moneybird versions are unix seconds; tolerate ms.
          const versionMs = version > 1e12 ? version : version * 1000;
          return versionMs > sinceMs;
        })
      : rows;

    const start = (page - 1) * perPage;
    const slice = filtered.slice(start, start + perPage);
    if (slice.length === 0) {
      return { items: [], done: true, nextCursor: null };
    }

    const ids = slice
      .map((row) => (row.id !== undefined && row.id !== null ? String(row.id) : ''))
      .filter(Boolean);
    const { data } = await this.request<Array<Record<string, unknown>>>('financial_mutations/synchronization', {
      method: 'POST',
      body: { ids },
    });
    const items = Array.isArray(data) ? data : [];
    const done = start + slice.length >= filtered.length;
    return { items, done, nextCursor: done ? null : String(page + 1) };
  }

  async listSync(
    sync: ConnectorSyncDef,
    options: { page: number; cursor: string | null; limit: number; modifiedAfter?: string },
  ): Promise<ConnectorListPage> {
    const page = options.cursor ? Number(options.cursor) || options.page : options.page;
    const listOptions: MoneybirdListOptions = {
      page,
      perPage: options.limit,
      updatedAfter: options.modifiedAfter,
    };
    switch (sync.syncName) {
      case 'moneybird-contacts':
        return this.listContacts(listOptions);
      case 'moneybird-sales-invoices':
        return this.listSalesInvoices(listOptions);
      case 'moneybird-products':
        return this.listProducts(listOptions);
      case 'moneybird-purchase-invoices':
        return this.listPurchaseInvoices(listOptions);
      case 'moneybird-receipts':
        return this.listReceipts(listOptions);
      case 'moneybird-financial-accounts':
        return this.listFinancialAccounts(listOptions);
      case 'moneybird-financial-mutations':
        return this.listFinancialMutations(listOptions);
      default:
        return { items: [], done: true, nextCursor: null };
    }
  }

  async hasUpdatesSince(resource: ConnectorSyncSettingKey, since?: string): Promise<boolean> {
    const options: MoneybirdListOptions = { page: 1, perPage: 1, updatedAfter: since };
    if (resource === 'contacts') return (await this.listContacts(options)).items.length > 0;
    if (resource === 'invoices') return (await this.listSalesInvoices(options)).items.length > 0;
    if (resource === 'products') return (await this.listProducts(options)).items.length > 0;
    if (resource === 'bills') {
      const [purchases, receipts] = await Promise.all([
        this.listPurchaseInvoices(options),
        this.listReceipts(options),
      ]);
      return purchases.items.length > 0 || receipts.items.length > 0;
    }
    if (resource === 'bankAccounts') {
      const page = await this.listFinancialAccounts();
      if (!since) return page.items.length > 0;
      const sinceMs = Date.parse(since);
      if (!Number.isFinite(sinceMs)) return page.items.length > 0;
      return page.items.some((item) => {
        const updated = typeof item.updated_at === 'string' ? Date.parse(item.updated_at) : NaN;
        return Number.isFinite(updated) && updated > sinceMs;
      });
    }
    if (resource === 'bankTransactions') return (await this.listFinancialMutations(options)).items.length > 0;
    return false;
  }

  private async countPath(path: string): Promise<number> {
    const { data } = await this.request<Array<{ id?: unknown }>>(`${path}/synchronization`);
    return Array.isArray(data) ? data.length : 0;
  }

  async countResource(resource: ConnectorSyncSettingKey): Promise<number> {
    if (resource === 'contacts') return this.countPath('contacts');
    if (resource === 'invoices') return this.countPath('sales_invoices');
    if (resource === 'products') return this.countPath('products');
    if (resource === 'bills') {
      const [purchases, receipts] = await Promise.all([
        this.countPath('documents/purchase_invoices'),
        this.countPath('documents/receipts'),
      ]);
      return purchases + receipts;
    }
    if (resource === 'bankAccounts') {
      return (await this.listFinancialAccounts()).items.length;
    }
    if (resource === 'bankTransactions') return this.countPath('financial_mutations');
    return 0;
  }

  async registerWebhooks(args: {
    deliveryUrl: string;
    secret: string;
    topics: ConnectorWebhookTopic[];
  }): Promise<ConnectorWebhookCreated[]> {
    const events = [...new Set(args.topics.map((topic) => topic.topic))];
    const { data } = await this.request<{
      id?: unknown;
      url?: string;
      secret?: string;
      enabled_events?: string[];
    }>('webhooks', {
      method: 'POST',
      body: { url: args.deliveryUrl, enabled_events: events },
    });
    const id = data?.id !== undefined && data?.id !== null ? String(data.id) : '';
    return [
      {
        id,
        topic: (data?.enabled_events ?? events).join(','),
        deliveryUrl: data?.url ?? args.deliveryUrl,
        secret: typeof data?.secret === 'string' ? data.secret : undefined,
      },
    ];
  }

  async deleteWebhook(id: string): Promise<void> {
    await this.request(`webhooks/${id}`, { method: 'DELETE' });
  }
}

export function createMoneybirdClient(
  creds: MoneybirdCredentials,
  options?: { fetchImpl?: typeof fetch; timeoutMs?: number },
): MoneybirdClient {
  return new MoneybirdClient(creds, options);
}
