/**
 * Where the extension may put a saved login. Decided here, in one place, and
 * asked again at the moment of filling — never only when the list is drawn.
 *
 * Two rules:
 *   1. The page must be `https:`, or `http://localhost` for local development.
 *      A password typed into a plain-http page is readable on the wire.
 *   2. The login's host must match the page's host (`hostsMatch`, shared with
 *      the API so the extension and the server cannot disagree).
 */

import { hostOf, hostsMatch } from '@weldsuite/app-api-client/schemas/weldpass-passwords';

export type PageBlock = 'no-page' | 'unsupported-page' | 'insecure-page';
export type FillBlock = PageBlock | 'no-item-host' | 'host-mismatch';

export type PageContext =
  | { ok: true; origin: string; host: string }
  | { ok: false; reason: PageBlock };

/** Whether the extension may act on this tab at all, and its origin and host if so. */
export function pageContext(tabUrl: string | null | undefined): PageContext {
  if (!tabUrl) return { ok: false, reason: 'no-page' };

  let url: URL;
  try {
    url = new URL(tabUrl);
  } catch {
    return { ok: false, reason: 'unsupported-page' };
  }

  if (url.protocol === 'http:') {
    if (url.hostname !== 'localhost') return { ok: false, reason: 'insecure-page' };
  } else if (url.protocol !== 'https:') {
    // chrome://, about:, file:, the extension's own pages, the Web Store…
    return { ok: false, reason: 'unsupported-page' };
  }

  const host = hostOf(url.origin);
  if (!host) return { ok: false, reason: 'unsupported-page' };
  return { ok: true, origin: url.origin, host };
}

export type FillVerdict = { ok: true; origin: string } | { ok: false; reason: FillBlock };

/** Whether `item` may be filled into the page at `tabUrl`. */
export function evaluateFill(
  item: { host: string | null },
  tabUrl: string | null | undefined,
): FillVerdict {
  const page = pageContext(tabUrl);
  if (!page.ok) return page;
  if (!item.host) return { ok: false, reason: 'no-item-host' };
  if (!hostsMatch(item.host, page.host)) return { ok: false, reason: 'host-mismatch' };
  return { ok: true, origin: page.origin };
}
