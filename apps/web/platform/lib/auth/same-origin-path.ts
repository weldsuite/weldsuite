/**
 * Where to go after signing in, as a path on this origin: `/` for anything
 * else. Parsed, not prefix-matched: a browser reads `/\evil.example` and a
 * path that normalises to `//evil.example` as another host.
 */

/** A stand-in origin to parse against; only "same origin or not" matters. */
const BASE = 'https://same-origin.invalid';

export function sameOriginPath(value: string | null | undefined): string {
  if (!value?.startsWith('/')) return '/';
  let url: URL;
  try {
    url = new URL(value, BASE);
  } catch {
    return '/';
  }
  if (url.origin !== BASE) return '/';
  // `/a/..//evil.example` parses on this origin with the path `//evil.example`,
  // which a browser would read as a host again.
  const path = url.pathname.replace(/^\/+/, '/');
  return `${path}${url.search}${url.hash}`;
}
