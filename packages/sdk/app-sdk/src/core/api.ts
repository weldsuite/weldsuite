import type { WeldAppBridge } from './bridge';
import type {
  AppRecord,
  CreateProductInput,
  KvClient,
  ListResponse,
  PeopleClient,
  PersonSummary,
  ProductListOptions,
  ProductSummary,
  ProductsClient,
  RecordListOptions,
  RecordsClient,
  ResourceListOptions,
  SingleResponse,
  TicketSummary,
  TicketsClient,
  UpdateProductInput,
} from './types';

interface ApiErrorBody {
  error?: {
    code?: string;
    message?: string;
    details?: unknown;
  };
}

/** Error thrown for non-2xx responses from the WeldSuite API. */
export class WeldApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'WeldApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function joinUrl(base: string, path: string): string {
  const trimmedBase = base.replace(/\/+$/, '');
  const trimmedPath = path.startsWith('/') ? path : `/${path}`;
  return `${trimmedBase}${trimmedPath}`;
}

function withQuery(path: string, options: ResourceListOptions & { status?: string }): string {
  const params = new URLSearchParams();
  if (options.limit !== undefined) params.set('limit', String(options.limit));
  if (options.cursor !== undefined) params.set('cursor', options.cursor);
  if (options.search !== undefined) params.set('search', options.search);
  if (options.status !== undefined) params.set('status', options.status);
  const query = params.toString();
  return query ? `${path}?${query}` : path;
}

async function toApiError(response: Response): Promise<WeldApiError> {
  let body: ApiErrorBody | null = null;
  try {
    body = (await response.json()) as ApiErrorBody;
  } catch {
    // Non-JSON error body — fall through to the generic message.
  }
  return new WeldApiError(
    response.status,
    body?.error?.code ?? 'http_error',
    body?.error?.message ?? `Request failed with HTTP ${response.status}`,
    body?.error?.details,
  );
}

/**
 * Workspace-scoped API client bound to a {@link WeldAppBridge}.
 *
 * Against a protocol 2 host every request is handed to the host, which calls
 * the API with the member's platform session outside the sandbox — the app
 * never holds a token. Against a legacy host, requests go straight to
 * `apiBaseUrl` with the bridge-managed `wsat_` token as a Bearer header, and a
 * 401 triggers one forced token refresh + retry.
 *
 * In local preview (`bridge.isLocalDev`), app-storage (records + kv) and
 * `/v1/products` are backed by an in-memory store. Other `/v1/*` routes throw
 * a clear error instead of hitting the network with a fake token.
 */
export class WeldApi {
  private readonly bridge: WeldAppBridge;

  constructor(bridge: WeldAppBridge) {
    this.bridge = bridge;
  }

  /**
   * Raw fetch against the WeldSuite API. `path` is relative to the
   * workspace's API base URL (e.g. `/v1/crm/contacts`).
   *
   * Note: on a 401 the request is retried once after a token refresh, so a
   * streaming request body would be consumed — pass string/Blob bodies.
   */
  async fetch(path: string, init: RequestInit = {}): Promise<Response> {
    if (this.bridge.isLocalDev) {
      throw new WeldApiError(
        503,
        'local_preview',
        'Local preview has no WeldSuite API connection. App-storage (records / kv) and products ' +
          'work in memory; other routes need the platform host (`weld app dev --tunnel` or installed app).',
      );
    }
    await this.bridge.connect();
    if (this.bridge.hostProxiesRequests) {
      // The host owns the session (and its refresh), so no retry here.
      return this.bridge.hostFetch(path, init);
    }
    const first = await this.send(path, init, false);
    if (first.status !== 401) {
      return first;
    }
    return this.send(path, init, true);
  }

  async get<T>(path: string): Promise<T> {
    return this.json<T>('GET', path);
  }

  async post<T>(path: string, body?: unknown): Promise<T> {
    return this.json<T>('POST', path, body);
  }

  async patch<T>(path: string, body?: unknown): Promise<T> {
    return this.json<T>('PATCH', path, body);
  }

  async delete<T = void>(path: string): Promise<T> {
    return this.json<T>('DELETE', path);
  }

  /**
   * Typed accessor for an app-storage collection
   * (`/v1/app-storage/collections/{collection}/records`).
   */
  records<T extends Record<string, unknown> = Record<string, unknown>>(collection: string): RecordsClient<T> {
    const base = `/v1/app-storage/collections/${encodeURIComponent(collection)}/records`;

    return {
      list: async (options: RecordListOptions = {}): Promise<ListResponse<AppRecord<T>>> => {
        await this.bridge.connect();
        if (this.bridge.isLocalDev && this.bridge.localStore) {
          return this.bridge.localStore.list<T>(collection, options);
        }
        const params = new URLSearchParams();
        if (options.limit !== undefined) {
          params.set('limit', String(options.limit));
        }
        if (options.cursor !== undefined) {
          params.set('cursor', options.cursor);
        }
        if (options.filter !== undefined) {
          params.set('filter', JSON.stringify(options.filter));
        }
        const query = params.toString();
        return this.get<ListResponse<AppRecord<T>>>(query ? `${base}?${query}` : base);
      },
      create: async (data: T): Promise<AppRecord<T>> => {
        await this.bridge.connect();
        if (this.bridge.isLocalDev && this.bridge.localStore) {
          return this.bridge.localStore.create(collection, data);
        }
        const response = await this.post<SingleResponse<AppRecord<T>>>(base, { data });
        return response.data;
      },
      get: async (id: string): Promise<AppRecord<T>> => {
        await this.bridge.connect();
        if (this.bridge.isLocalDev && this.bridge.localStore) {
          const record = this.bridge.localStore.get<T>(collection, id);
          if (!record) {
            throw new WeldApiError(404, 'not_found', `Record ${id} not found in collection "${collection}".`);
          }
          return record;
        }
        const response = await this.get<SingleResponse<AppRecord<T>>>(`${base}/${encodeURIComponent(id)}`);
        return response.data;
      },
      update: async (id: string, data: T): Promise<AppRecord<T>> => {
        await this.bridge.connect();
        if (this.bridge.isLocalDev && this.bridge.localStore) {
          const record = this.bridge.localStore.update(collection, id, data);
          if (!record) {
            throw new WeldApiError(404, 'not_found', `Record ${id} not found in collection "${collection}".`);
          }
          return record;
        }
        // PATCH replaces the stored document with `data`.
        const response = await this.patch<SingleResponse<AppRecord<T>>>(`${base}/${encodeURIComponent(id)}`, {
          data,
        });
        return response.data;
      },
      remove: async (id: string): Promise<void> => {
        await this.bridge.connect();
        if (this.bridge.isLocalDev && this.bridge.localStore) {
          if (!this.bridge.localStore.remove(collection, id)) {
            throw new WeldApiError(404, 'not_found', `Record ${id} not found in collection "${collection}".`);
          }
          return;
        }
        await this.delete(`${base}/${encodeURIComponent(id)}`);
      },
    };
  }

  /** Key-value store (`/v1/app-storage/kv/{key}`). `get` returns null for missing keys. */
  readonly kv: KvClient = {
    get: async <T = unknown>(key: string): Promise<T | null> => {
      await this.bridge.connect();
      if (this.bridge.isLocalDev && this.bridge.localStore) {
        return this.bridge.localStore.kvGet<T>(key);
      }
      const response = await this.fetch(`/v1/app-storage/kv/${encodeURIComponent(key)}`);
      if (response.status === 404) {
        return null;
      }
      if (!response.ok) {
        throw await toApiError(response);
      }
      const body = (await response.json()) as { data: unknown };
      const data = body.data;
      if (data !== null && typeof data === 'object' && 'value' in data) {
        return (data as { value: T }).value;
      }
      return data as T;
    },
    set: async (key: string, value: unknown): Promise<void> => {
      await this.bridge.connect();
      if (this.bridge.isLocalDev && this.bridge.localStore) {
        this.bridge.localStore.kvSet(key, value);
        return;
      }
      await this.json('PUT', `/v1/app-storage/kv/${encodeURIComponent(key)}`, { value });
    },
    delete: async (key: string): Promise<void> => {
      await this.bridge.connect();
      if (this.bridge.isLocalDev && this.bridge.localStore) {
        this.bridge.localStore.kvDelete(key);
        return;
      }
      await this.json('DELETE', `/v1/app-storage/kv/${encodeURIComponent(key)}`);
    },
  };

  /** `/v1/people` — requires the `people:read` scope. */
  readonly people: PeopleClient = {
    list: (options: ResourceListOptions = {}) =>
      this.get<ListResponse<PersonSummary>>(withQuery('/v1/people', options)),
    get: (id: string) => this.get<SingleResponse<PersonSummary>>(`/v1/people/${encodeURIComponent(id)}`),
  };

  /** `/v1/tickets` — requires the `tickets:read` scope. */
  readonly tickets: TicketsClient = {
    list: (options: ResourceListOptions = {}) =>
      this.get<ListResponse<TicketSummary>>(withQuery('/v1/tickets', options)),
    get: (id: string) => this.get<SingleResponse<TicketSummary>>(`/v1/tickets/${encodeURIComponent(id)}`),
  };

  /**
   * `/v1/products` — requires `products:read` / `products:write`.
   * In local preview / CLI local shell, backed by the same in-memory store as app-storage.
   */
  readonly products: ProductsClient = {
    list: async (options: ProductListOptions = {}): Promise<ListResponse<ProductSummary>> => {
      await this.bridge.connect();
      if (this.bridge.isLocalDev && this.bridge.localStore) {
        return this.bridge.localStore.listProducts(options);
      }
      return this.get<ListResponse<ProductSummary>>(withQuery('/v1/products', options));
    },
    get: async (id: string): Promise<SingleResponse<ProductSummary>> => {
      await this.bridge.connect();
      if (this.bridge.isLocalDev && this.bridge.localStore) {
        const product = this.bridge.localStore.getProduct(id);
        if (!product) {
          throw new WeldApiError(404, 'not_found', `Product ${id} not found.`);
        }
        return { data: product };
      }
      return this.get<SingleResponse<ProductSummary>>(`/v1/products/${encodeURIComponent(id)}`);
    },
    create: async (input: CreateProductInput): Promise<ProductSummary> => {
      await this.bridge.connect();
      if (this.bridge.isLocalDev && this.bridge.localStore) {
        return this.bridge.localStore.createProduct(input);
      }
      const response = await this.post<SingleResponse<ProductSummary>>('/v1/products', input);
      return response.data;
    },
    update: async (id: string, input: UpdateProductInput): Promise<ProductSummary> => {
      await this.bridge.connect();
      if (this.bridge.isLocalDev && this.bridge.localStore) {
        const product = this.bridge.localStore.updateProduct(id, input);
        if (!product) {
          throw new WeldApiError(404, 'not_found', `Product ${id} not found.`);
        }
        return product;
      }
      const response = await this.patch<SingleResponse<ProductSummary>>(
        `/v1/products/${encodeURIComponent(id)}`,
        input,
      );
      return response.data;
    },
    remove: async (id: string): Promise<void> => {
      await this.bridge.connect();
      if (this.bridge.isLocalDev && this.bridge.localStore) {
        if (!this.bridge.localStore.removeProduct(id)) {
          throw new WeldApiError(404, 'not_found', `Product ${id} not found.`);
        }
        return;
      }
      await this.delete(`/v1/products/${encodeURIComponent(id)}`);
    },
  };

  private async send(path: string, init: RequestInit, forceRefresh: boolean): Promise<Response> {
    const { token, apiBaseUrl } = await this.bridge.getToken({ forceRefresh });
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${token}`);
    return fetch(joinUrl(apiBaseUrl, path), { ...init, headers });
  }

  private async json<T>(method: string, path: string, body?: unknown): Promise<T> {
    const init: RequestInit = { method };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
      init.headers = { 'Content-Type': 'application/json' };
    }
    const response = await this.fetch(path, init);
    if (!response.ok) {
      throw await toApiError(response);
    }
    if (response.status === 204) {
      return undefined as T;
    }
    return (await response.json()) as T;
  }
}
