import type {
  AppRecord,
  CreateProductInput,
  InitPayload,
  ListResponse,
  ProductListOptions,
  ProductSummary,
  UpdateProductInput,
  WeldTokenInfo,
} from './types';

/** Query param that opts into local preview when the page is not iframed. */
export const LOCAL_DEV_QUERY_PARAM = 'weldLocal';

/** Window flag for non-Vite hosts: `window.__WELD_LOCAL_DEV__ = true`. */
export const LOCAL_DEV_WINDOW_FLAG = '__WELD_LOCAL_DEV__';

export interface LocalDevOptions {
  /** Override the fake app code (defaults to `local-preview`). */
  appCode?: string;
  /** Override the fake user name. */
  userName?: string;
  /** Override theme (`light` | `dark`). */
  theme?: 'light' | 'dark';
  /** Override locale. */
  locale?: string;
}

export interface WeldAppBridgeOptions {
  /**
   * Explicitly opt into local preview mode when the page is **not** embedded
   * in an iframe. Safe to pass `import.meta.env.DEV` from a Vite app: when the
   * platform host iframes the same server (`weld app dev`), the real bridge
   * is still used.
   */
  localDev?: boolean;
  /** Customize the mock init payload used in local preview. */
  local?: LocalDevOptions;
}

declare global {
  interface Window {
    [LOCAL_DEV_WINDOW_FLAG]?: boolean;
  }
}

/**
 * Whether local preview should activate.
 *
 * Production iframe security is unchanged: when `window.parent !== window`
 * (embedded in WeldSuite), this always returns `false` — even if `localDev`
 * or the query param is set.
 */
export function shouldUseLocalDev(options?: Pick<WeldAppBridgeOptions, 'localDev'>): boolean {
  if (typeof window === 'undefined') {
    return false;
  }
  // Prefer the real host whenever we are embedded.
  if (window.parent !== window) {
    return false;
  }

  if (options?.localDev === true) {
    return true;
  }

  try {
    const params = new URLSearchParams(window.location.search);
    const flag = params.get(LOCAL_DEV_QUERY_PARAM);
    if (flag === '1' || flag === 'true') {
      return true;
    }
  } catch {
    // Ignore malformed URLs.
  }

  if (window[LOCAL_DEV_WINDOW_FLAG] === true) {
    return true;
  }

  return false;
}

export function buildLocalInitPayload(local?: LocalDevOptions): InitPayload {
  const tokenExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  return {
    appCode: local?.appCode ?? 'local-preview',
    theme: local?.theme ?? 'light',
    locale: local?.locale ?? 'en',
    apiBaseUrl: 'http://localhost/local-preview',
    token: 'local_preview_token',
    tokenExpiresAt,
    user: {
      id: 'usr_local_preview',
      name: local?.userName ?? 'Local Preview',
    },
  };
}

/** True when a host (CLI local shell) opted the iframe into in-memory storage. */
export function isLocalPreviewInit(payload: InitPayload | null | undefined): boolean {
  return payload?.localPreview === true;
}

export function buildLocalTokenInfo(init: InitPayload): WeldTokenInfo {
  return {
    token: init.token,
    tokenExpiresAt: init.tokenExpiresAt,
    apiBaseUrl: init.apiBaseUrl,
  };
}

function matchesFilter(data: Record<string, unknown>, filter: Record<string, unknown>): boolean {
  for (const [key, expected] of Object.entries(filter)) {
    if (data[key] !== expected) {
      return false;
    }
  }
  return true;
}

function generateLocalId(): string {
  return `rec_local_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function generateLocalProductId(): string {
  return `prod_local_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * In-memory stand-in for app-storage (records + kv) and `/v1/products`, used
 * only in local preview / CLI local shell. Other `/v1/*` routes still throw.
 */
export class LocalMemoryStore {
  private readonly collections = new Map<string, Map<string, AppRecord>>();
  private readonly kv = new Map<string, unknown>();
  private readonly products = new Map<string, ProductSummary>();

  list<T extends Record<string, unknown>>(
    collection: string,
    options: { limit?: number; cursor?: string; filter?: Record<string, unknown> } = {},
  ): ListResponse<AppRecord<T>> {
    const store = this.ensureCollection(collection);
    let rows = Array.from(store.values()) as AppRecord<T>[];
    if (options.filter) {
      rows = rows.filter((row) => matchesFilter(row.data, options.filter!));
    }
    // Stable newest-first by createdAt.
    rows.sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')));

    const limit = options.limit ?? 50;
    let start = 0;
    if (options.cursor) {
      const idx = rows.findIndex((row) => row.id === options.cursor);
      start = idx >= 0 ? idx + 1 : 0;
    }
    const slice = rows.slice(start, start + limit);
    const hasMore = start + limit < rows.length;
    return {
      data: slice,
      pagination: {
        totalCount: rows.length,
        hasMore,
        cursor: hasMore && slice.length > 0 ? slice[slice.length - 1]!.id : null,
      },
    };
  }

  create<T extends Record<string, unknown>>(collection: string, data: T): AppRecord<T> {
    const store = this.ensureCollection(collection);
    const now = new Date().toISOString();
    const record: AppRecord<T> = {
      id: generateLocalId(),
      data,
      createdAt: now,
      updatedAt: now,
    };
    store.set(record.id, record as AppRecord);
    return record;
  }

  get<T extends Record<string, unknown>>(collection: string, id: string): AppRecord<T> | null {
    const store = this.ensureCollection(collection);
    return (store.get(id) as AppRecord<T> | undefined) ?? null;
  }

  update<T extends Record<string, unknown>>(collection: string, id: string, data: T): AppRecord<T> | null {
    const store = this.ensureCollection(collection);
    const existing = store.get(id);
    if (!existing) {
      return null;
    }
    const updated: AppRecord<T> = {
      ...existing,
      data,
      updatedAt: new Date().toISOString(),
    } as AppRecord<T>;
    store.set(id, updated as AppRecord);
    return updated;
  }

  remove(collection: string, id: string): boolean {
    const store = this.ensureCollection(collection);
    return store.delete(id);
  }

  kvGet<T = unknown>(key: string): T | null {
    if (!this.kv.has(key)) {
      return null;
    }
    return this.kv.get(key) as T;
  }

  kvSet(key: string, value: unknown): void {
    this.kv.set(key, value);
  }

  kvDelete(key: string): void {
    this.kv.delete(key);
  }

  listProducts(options: ProductListOptions = {}): ListResponse<ProductSummary> {
    let rows = Array.from(this.products.values());
    if (options.status) {
      rows = rows.filter((row) => row.status === options.status);
    }
    if (options.search) {
      const term = options.search.trim().toLowerCase();
      rows = rows.filter((row) => {
        const haystack = [row.name, row.slug, row.sku ?? ''].join(' ').toLowerCase();
        return haystack.includes(term);
      });
    }
    rows.sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')));

    const limit = options.limit ?? 50;
    let start = 0;
    if (options.cursor) {
      const idx = rows.findIndex((row) => row.id === options.cursor);
      start = idx >= 0 ? idx + 1 : 0;
    }
    const slice = rows.slice(start, start + limit);
    const hasMore = start + limit < rows.length;
    return {
      data: slice,
      pagination: {
        totalCount: rows.length,
        hasMore,
        cursor: hasMore && slice.length > 0 ? slice[slice.length - 1]!.id : null,
      },
    };
  }

  getProduct(id: string): ProductSummary | null {
    return this.products.get(id) ?? null;
  }

  createProduct(input: CreateProductInput): ProductSummary {
    const now = new Date().toISOString();
    const product: ProductSummary = {
      id: generateLocalProductId(),
      name: input.name,
      slug: input.slug,
      description: input.description ?? null,
      sku: input.sku ?? null,
      status: input.status ?? 'draft',
      price: input.price ?? null,
      currency: input.currency ?? 'EUR',
      imageUrl: input.imageUrl ?? null,
      createdAt: now,
      updatedAt: now,
    };
    this.products.set(product.id, product);
    return product;
  }

  updateProduct(id: string, input: UpdateProductInput): ProductSummary | null {
    const existing = this.products.get(id);
    if (!existing) {
      return null;
    }
    const updated: ProductSummary = {
      ...existing,
      ...input,
      id: existing.id,
      createdAt: existing.createdAt,
      updatedAt: new Date().toISOString(),
    };
    this.products.set(id, updated);
    return updated;
  }

  removeProduct(id: string): boolean {
    return this.products.delete(id);
  }

  private ensureCollection(collection: string): Map<string, AppRecord> {
    let store = this.collections.get(collection);
    if (!store) {
      store = new Map();
      this.collections.set(collection, store);
    }
    return store;
  }
}
