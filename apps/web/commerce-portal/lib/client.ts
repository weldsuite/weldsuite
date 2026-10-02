function portalUrl(slug: string, path: string): string {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return `/api/portal${normalizedPath}?slug=${encodeURIComponent(slug)}`;
}

export async function portalGet<T>(slug: string, path: string): Promise<T> {
  const url = portalUrl(slug, path);
  const res = await fetch(url, { credentials: 'include' });
  if (res.status === 401) {
    window.location.href = `/${slug}/login`;
    throw new Error('unauthorized');
  }
  if (!res.ok) throw new Error(`request failed (${res.status})`);
  return res.json() as Promise<T>;
}

export async function portalPost<T>(slug: string, path: string, body: unknown): Promise<T> {
  const url = portalUrl(slug, path);
  const res = await fetch(url, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (res.status === 401) {
    window.location.href = `/${slug}/login`;
    throw new Error('unauthorized');
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as { error?: { message?: string } }).error?.message || `request failed (${res.status})`);
  }
  return res.json() as Promise<T>;
}
