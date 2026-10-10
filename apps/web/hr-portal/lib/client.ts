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
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  const url = new URL(
    `/api/portal${normalizedPath}`,
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

/**
 * Same-origin URL of a proxied GET, for a link the browser opens itself (a
 * receipt in a new tab). The httpOnly session cookie rides along.
 */
export function portalUrl(slug: string, path: string): string {
  return buildUrl(slug, path);
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

async function portalJsonWrite<T>(method: 'POST' | 'PUT', slug: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(buildUrl(slug, path), {
    method,
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

export function portalPost<T>(slug: string, path: string, body?: unknown): Promise<T> {
  return portalJsonWrite<T>('POST', slug, path, body);
}

export function portalPut<T>(slug: string, path: string, body?: unknown): Promise<T> {
  return portalJsonWrite<T>('PUT', slug, path, body);
}

/** POST a `multipart/form-data` body (a file upload). No Content-Type header: the browser sets it with the boundary. */
export async function portalUpload<T>(slug: string, path: string, form: FormData): Promise<T> {
  const res = await fetch(buildUrl(slug, path), {
    method: 'POST',
    credentials: 'include',
    body: form,
  });
  const result = await handle<T>(res, slug);
  void invalidatePortal(slug);
  return result;
}

/** The file name in a `Content-Disposition` header, if it carries one. */
function filenameFromDisposition(header: string | null): string | null {
  if (!header) return null;
  const encoded = /filename\*=UTF-8''([^;]+)/i.exec(header);
  if (encoded?.[1]) {
    try {
      return decodeURIComponent(encoded[1].trim());
    } catch {
      // Malformed escape: fall through to the plain form.
    }
  }
  const plain = /filename="?([^";]+)"?/i.exec(header);
  return plain?.[1]?.trim() || null;
}

/**
 * GET a file through the proxy and hand it to the browser as a download (a
 * payslip PDF). Unlike a plain link this keeps an expired session or an API
 * error on the page instead of showing raw JSON in a new tab, and it resolves
 * only once the file has arrived, so the caller can refresh what the download
 * changed (a payslip is marked as read when it is fetched).
 */
export async function portalDownload(
  slug: string,
  path: string,
  options?: { query?: Record<string, string | undefined>; fallbackName?: string },
): Promise<void> {
  const res = await fetch(buildUrl(slug, path, options?.query), { credentials: 'include' });
  if (res.status === 401) {
    clearPortalCache(slug);
    if (typeof window !== 'undefined') window.location.href = `/${slug}/login`;
    throw new PortalApiError('Session expired', 401, 'UNAUTHORIZED');
  }
  if (!res.ok) {
    const json = (await res.json().catch(() => ({}))) as ApiErrorBody;
    throw new PortalApiError(json.error?.message || `Request failed (${res.status})`, res.status, json.error?.code);
  }
  const blob = await res.blob();
  const name = filenameFromDisposition(res.headers.get('content-disposition')) ?? options?.fallbackName ?? 'download';
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = objectUrl;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Give the browser a moment to start the save before the blob goes away.
  setTimeout(() => URL.revokeObjectURL(objectUrl), 10_000);
}
