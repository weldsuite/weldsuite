/**
 * WeldBooks API client — targets the unified app-api worker.
 *
 * Successor to the legacy worker transport for all accounting calls (WeldBooks
 * was the last module on the obsolete api-worker). Module-singleton on purpose:
 * `accountingApi` in domains/weldbooks.ts is consumed outside React context,
 * so the Clerk token getter and the selected accounting entity are mirrored
 * in here by `ApiClientProvider` and `useCurrentAccountingEntity`.
 */

const APP_API_URL = import.meta.env.VITE_APP_API_URL || 'http://localhost:8789';
const API_PREFIX = '/api';

class WeldbooksApiError extends Error {
  status: number;
  body: unknown;
  code: string | null;

  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.name = 'WeldbooksApiError';
    this.status = status;
    this.body = body;
    const code =
      body && typeof body === 'object'
        ? ((body as { error?: { code?: unknown } }).error?.code ?? null)
        : null;
    this.code = typeof code === 'string' ? code : null;
  }
}

/** The currently-selected accounting entity, synced from the Jotai atom in the UI layer. */
let currentAccountingEntityId: string | null = null;
export function setWeldbooksEntityId(id: string | null) {
  currentAccountingEntityId = id;
}

let browserTokenGetter: (() => Promise<string | null>) | null = null;
export function setWeldbooksTokenGetter(getter: (() => Promise<string | null>) | null) {
  browserTokenGetter = getter;
}

/** Same pre-provider fallback as worker-client: pull the token from window.Clerk. */
async function getClerkBrowserToken(): Promise<string | null> {
  if (typeof window === 'undefined') return null;
  const start = Date.now();
  while (Date.now() - start < 5000) {
    const Clerk = (window as { Clerk?: { loaded?: boolean; session?: { getToken: () => Promise<string | null> } } }).Clerk;
    if (Clerk?.loaded) {
      try {
        return (await Clerk.session?.getToken()) ?? null;
      } catch {
        return null;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return null;
}

async function getAuthHeaders(): Promise<Record<string, string>> {
  const token = browserTokenGetter ? await browserTokenGetter() : await getClerkBrowserToken();
  return {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(currentAccountingEntityId ? { 'X-Accounting-Entity-Id': currentAccountingEntityId } : {}),
  };
}

function formatErrorMessage(body: any, status: number): string {
  const errorValue = body?.error ?? body?.message;
  if (typeof errorValue === 'string') return errorValue;
  if (errorValue && typeof errorValue === 'object' && typeof errorValue.message === 'string') {
    return errorValue.message;
  }
  return `Request failed with status ${status}`;
}

async function request<T>(method: string, path: string, data?: unknown): Promise<T> {
  const headers = await getAuthHeaders();
  const response = await fetch(`${APP_API_URL}${API_PREFIX}${path}`, {
    method,
    headers,
    cache: method === 'GET' ? 'no-store' : undefined,
    body: data !== undefined ? JSON.stringify(data) : undefined,
  });

  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: 'Request failed' }));
    throw new WeldbooksApiError(formatErrorMessage(body, response.status), response.status, body);
  }

  if (response.status === 204) return undefined as T;

  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) {
    // XML / HTML downloads (BTW-aangifte XBRL, invoice PDF-HTML)
    return (await response.text()) as unknown as T;
  }
  return response.json();
}

export const weldbooksApi = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, data?: unknown) => request<T>('POST', path, data),
  put: <T>(path: string, data?: unknown) => request<T>('PUT', path, data),
  patch: <T>(path: string, data?: unknown) => request<T>('PATCH', path, data),
  delete: <T>(path: string) => request<T>('DELETE', path),
};
