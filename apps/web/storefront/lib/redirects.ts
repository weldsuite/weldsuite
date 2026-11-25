import { safeLink } from '@weldsuite/storefront-theme';

/**
 * Where the site's own redirects (`document.redirects`, e.g. old paths of a
 * shop that moved here) send `url`: the matching `toPath`, keeping the query
 * when `toPath` has none; null when no redirect matches (or its target is not
 * a safe link).
 */
export function redirectTarget(redirects: ReadonlyArray<{ fromPath: string; toPath: string }>, url: URL): string | null {
  const match = redirects.find((redirect) => redirect.fromPath === url.pathname);
  if (!match) return null;
  const target = safeLink(match.toPath);
  if (!target) return null;
  return target.href.includes('?') || !url.search ? target.href : `${target.href}${url.search}`;
}
