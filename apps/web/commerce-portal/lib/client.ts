export async function portalGet<T>(slug: string, path: string): Promise<T> {
  const url = `/api/portal${path.startsWith('/') ? path : `/${path}`}?slug=${encodeURIComponent(slug)}`;
  const res = await fetch(url, { credentials: 'include' });
  if (res.status === 401) {
    window.location.href = `/${slug}/login`;
    throw new Error('unauthorized');
  }
  if (!res.ok) throw new Error(`request failed (${res.status})`);
  return res.json() as Promise<T>;
}

export async function portalPost<T>(slug: string, path: string, body: unknown): Promise<T> {
  const url = `/api/portal${path.startsWith('/') ? path : `/${path}`}?slug=${encodeURIComponent(slug)}`;
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
