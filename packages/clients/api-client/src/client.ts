/**
 * Framework-agnostic API client.
 *
 * Extracted from apps/web/platform/lib/api/client-api.ts — takes getToken + baseUrl
 * as constructor args so both Next.js and Vite apps can use it.
 */

import type { ClientApi, ClientApiOptions } from './types.js';

/**
 * Thrown when a request never reaches the server — the device is offline, the
 * DNS lookup failed, or the connection dropped mid-flight. `fetch` surfaces all
 * of these as a generic `TypeError` ("Network request failed"), which callers
 * can't distinguish from a server-side failure. Wrapping it lets the UI tell
 * "you're offline" apart from "the server rejected this" (e.g. to queue the
 * action for retry instead of showing a hard error).
 */
export class NetworkError extends Error {
  /** Discriminator so consumers can `if (err instanceof NetworkError)` or check the flag across bundle boundaries. */
  readonly isNetworkError = true;

  constructor(message = 'Network request failed', readonly cause?: unknown) {
    super(message);
    this.name = 'NetworkError';
  }
}

/** True for any error that means the request never got a response from the server. */
export function isNetworkError(err: unknown): err is NetworkError {
  return err instanceof NetworkError || (typeof err === 'object' && err !== null && (err as { isNetworkError?: boolean }).isNetworkError === true);
}

/**
 * Thrown when the server *did* respond but with a non-2xx status. Carries the
 * HTTP `status` so callers can branch on it — e.g. treat 404 as "genuinely
 * gone" but 5xx / 401 as transient-and-retryable — instead of guessing from a
 * flattened message string. Extends `Error`, so existing `catch (e)` sites that
 * only read `e.message` keep working unchanged.
 */
export class ApiError extends Error {
  /** Discriminator so consumers can check across bundle boundaries. */
  readonly isApiError = true;

  constructor(
    message: string,
    readonly status: number,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** True for an error carrying an HTTP status (a server error *response*). */
export function isApiError(err: unknown): err is ApiError {
  return err instanceof ApiError || (typeof err === 'object' && err !== null && (err as { isApiError?: boolean }).isApiError === true);
}

/**
 * `fetch` that converts connectivity failures (the generic `TypeError` the
 * platform throws when a request can't reach the server) into a typed
 * {@link NetworkError}. HTTP error *responses* (4xx/5xx) are not touched here —
 * those still resolve and are handled by the per-method response handlers.
 */
async function safeFetch(input: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(input, init);
  } catch (err) {
    // A rejected fetch means no response was received at all (offline, DNS,
    // reset, CORS). Re-wrap so callers get a stable, typed signal.
    throw new NetworkError(err instanceof Error ? err.message : 'Network request failed', err);
  }
}

function formatErrorMessage(error: Record<string, unknown>, status: number): string {
  const errorValue = (error.error ?? error.message) as unknown;
  if (errorValue === null || errorValue === undefined) {
    return `Request failed with status ${status}`;
  }
  if (typeof errorValue === 'string') {
    return errorValue;
  }
  if (typeof errorValue === 'object' && errorValue !== null) {
    const obj = errorValue as Record<string, unknown>;
    if (typeof obj.message === 'string') {
      return obj.message;
    }
    return JSON.stringify(errorValue);
  }
  return `Request failed with status ${status}`;
}

export function createClientApi(options: ClientApiOptions): ClientApi {
  const { getToken, baseUrl, apiPrefix = '/api' } = options;

  async function getAuthHeaders(): Promise<Record<string, string>> {
    const token = await getToken();
    if (!token) {
      throw new Error('Authentication required');
    }
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    };
  }

  /**
   * Auth headers WITHOUT a Content-Type, so that `fetch` can set the
   * multipart/form-data boundary automatically when sending a FormData body.
   */
  async function getAuthHeadersNoContentType(): Promise<Record<string, string>> {
    const token = await getToken();
    if (!token) {
      throw new Error('Authentication required');
    }
    return {
      Authorization: `Bearer ${token}`,
    };
  }

  async function handleResponse<T>(response: Response): Promise<T> {
    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: 'Request failed' }));
      throw new ApiError(formatErrorMessage(error, response.status), response.status, error);
    }
    if (response.status === 204) {
      return {} as T;
    }
    return response.json();
  }

  const url = (path: string) => `${baseUrl}${apiPrefix}${path}`;

  return {
    async get<T>(path: string): Promise<T> {
      const headers = await getAuthHeaders();
      const response = await safeFetch(url(path), { method: 'GET', headers });
      return handleResponse<T>(response);
    },

    async getRaw(path: string): Promise<Response> {
      const headers = await getAuthHeaders();
      const response = await safeFetch(url(path), { method: 'GET', headers });
      if (!response.ok) {
        const error = await response.json().catch(() => ({ error: 'Request failed' }));
        throw new ApiError(formatErrorMessage(error, response.status), response.status, error);
      }
      return response;
    },

    async post<T>(path: string, data?: unknown): Promise<T> {
      const headers = await getAuthHeaders();
      const response = await safeFetch(url(path), {
        method: 'POST',
        headers,
        body: data ? JSON.stringify(data) : undefined,
      });
      return handleResponse<T>(response);
    },

    async put<T>(path: string, data?: unknown): Promise<T> {
      const headers = await getAuthHeaders();
      const response = await safeFetch(url(path), {
        method: 'PUT',
        headers,
        body: data ? JSON.stringify(data) : undefined,
      });
      return handleResponse<T>(response);
    },

    async patch<T>(path: string, data?: unknown): Promise<T> {
      const headers = await getAuthHeaders();
      const response = await safeFetch(url(path), {
        method: 'PATCH',
        headers,
        body: data ? JSON.stringify(data) : undefined,
      });
      return handleResponse<T>(response);
    },

    async delete<T>(path: string): Promise<T> {
      const headers = await getAuthHeaders();
      const response = await safeFetch(url(path), { method: 'DELETE', headers });
      return handleResponse<T>(response);
    },

    async postForm<T>(path: string, form: FormData): Promise<T> {
      const headers = await getAuthHeadersNoContentType();
      const response = await safeFetch(url(path), {
        method: 'POST',
        headers,
        body: form,
      });
      return handleResponse<T>(response);
    },
  };
}

/**
 * Build query string from object, omitting empty values.
 */
export function buildQueryString(params: Record<string, unknown>): string {
  const searchParams = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') {
      searchParams.set(key, String(value));
    }
  }
  const query = searchParams.toString();
  return query ? `?${query}` : '';
}
