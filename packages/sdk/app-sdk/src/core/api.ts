import type { WeldAppBridge } from './bridge';
import type {
  AppRecord,
  KvClient,
  ListResponse,
  RecordListOptions,
  RecordsClient,
  SingleResponse,
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
 * Every request goes to the external API (`apiBaseUrl` from the init
 * payload) with the bridge-managed `wsat_` token injected as a Bearer
 * header. A 401 triggers one forced token refresh + retry.
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
        const response = await this.post<SingleResponse<AppRecord<T>>>(base, { data });
        return response.data;
      },
      get: async (id: string): Promise<AppRecord<T>> => {
        const response = await this.get<SingleResponse<AppRecord<T>>>(`${base}/${encodeURIComponent(id)}`);
        return response.data;
      },
      update: async (id: string, data: T): Promise<AppRecord<T>> => {
        // PATCH replaces the stored document with `data`.
        const response = await this.patch<SingleResponse<AppRecord<T>>>(`${base}/${encodeURIComponent(id)}`, {
          data,
        });
        return response.data;
      },
      remove: async (id: string): Promise<void> => {
        await this.delete(`${base}/${encodeURIComponent(id)}`);
      },
    };
  }

  /** Key-value store (`/v1/app-storage/kv/{key}`). `get` returns null for missing keys. */
  readonly kv: KvClient = {
    get: async <T = unknown>(key: string): Promise<T | null> => {
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
      await this.json('PUT', `/v1/app-storage/kv/${encodeURIComponent(key)}`, { value });
    },
    delete: async (key: string): Promise<void> => {
      await this.json('DELETE', `/v1/app-storage/kv/${encodeURIComponent(key)}`);
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
