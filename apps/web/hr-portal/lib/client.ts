'use client';

/**
 * Browser-side fetch helpers. Every call goes through this app's own
 * `/api/portal/[...path]` proxy (never straight to app-api), so the session
 * token stays in an httpOnly cookie the browser JS can't read.
 */

export interface ApiErrorBody {
  error?: { code?: string; message?: string; details?: unknown };
}

export class PortalApiError extends Error {
  code?: string;
  status: number;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = 'PortalApiError';
    this.status = status;
    this.code = code;
  }
}

function buildUrl(slug: string, path: string, query?: Record<string, string | undefined>): string {
  const url = new URL(
    `/api/portal${path.startsWith('/') ? path : `/${path}`}`,
    typeof window === 'undefined' ? 'http://localhost' : window.location.origin,
  );
  url.searchParams.set('slug', slug);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) url.searchParams.set(key, value);
    }
  }
  return `${url.pathname}${url.search}`;
}

async function handle<T>(res: Response, slug: string): Promise<T> {
  if (res.status === 401) {
    if (typeof window !== 'undefined') window.location.href = `/${slug}/login`;
    throw new PortalApiError('Session expired', 401, 'UNAUTHORIZED');
  }
  if (res.status === 204) return undefined as T;
  const json = (await res.json().catch(() => ({}))) as { data?: T } & ApiErrorBody;
  if (!res.ok) {
    throw new PortalApiError(json.error?.message || `Request failed (${res.status})`, res.status, json.error?.code);
  }
  return json.data as T;
}

export async function portalGet<T>(slug: string, path: string, query?: Record<string, string | undefined>): Promise<T> {
  const res = await fetch(buildUrl(slug, path, query), { credentials: 'include' });
  return handle<T>(res, slug);
}

export async function portalPost<T>(slug: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(buildUrl(slug, path), {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  return handle<T>(res, slug);
}
