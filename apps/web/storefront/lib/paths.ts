/** A same-shop path to go to after signing in; anything else becomes `fallback`. */
export function safePath(value: unknown, fallback = '/account'): string {
  if (typeof value !== 'string') return fallback;
  return value.startsWith('/') && !value.startsWith('//') && !value.startsWith('/\\') ? value : fallback;
}

/** A path with query parameters, leaving out empty ones. */
export function withQuery(path: string, query: Record<string, string | null | undefined>): string {
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(query)) if (value) params.set(name, value);
  const search = params.toString();
  return search ? `${path}?${search}` : path;
}

/** A route segment decoded once; left as it is when it is not valid percent-encoding. */
export function segment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
