'use client';

/**
 * Browser-side fetch helpers. Every call goes through this app's own
 * `/api/portal/[...path]` proxy (never straight to app-api), so the session
 * token stays in an httpOnly cookie the browser JS can't read.
 */

import { PortalApiError, type ApiErrorBody } from './client-errors';
import { clearPortalCache, invalidatePortal } from './query-client';

export { PortalApiError, type ApiErrorBody };

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
    clearPortalCache(slug);
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
  const result = await handle<T>(res, slug);
  // A write can change several pages at once (a leave request moves the
  // balance and the overview too), so refresh the cached reads. Only mounted
  // queries refetch; the rest are just marked stale.
  void invalidatePortal(slug);
  return result;
}
