/**
 * The renderer's cookies, all on the shop's own host, httpOnly and
 * `SameSite=Lax`, `Secure` when the shopper came over HTTPS:
 *
 * - `wsf_cart`: the cart token (`wct_…`);
 * - `wsf_session`: the shopper's session token (`wss_…`);
 * - `wsf_checkout`: the last checkout (order id, payment id, a guest's order
 *   token), for the page Mollie sends the shopper back to;
 * - `wsf_signin`: the email a sign-in code was sent to, between the two steps;
 * - `wsf_preview`: the editor's preview token (`SameSite=None; Partitioned`,
 *   so it works in the editor's iframe);
 * - `wsf_consent`: the shopper's analytics choice. The one cookie page script
 *   writes (`granted` or `denied`), so it is not httpOnly.
 */

export const COOKIE = {
  cart: 'wsf_cart',
  session: 'wsf_session',
  checkout: 'wsf_checkout',
  signIn: 'wsf_signin',
  preview: 'wsf_preview',
  consent: 'wsf_consent',
} as const;

export const DAY = 24 * 60 * 60;

export interface CookieOptions {
  path: string;
  httpOnly: boolean;
  secure: boolean;
  sameSite: 'lax' | 'none';
  partitioned?: boolean;
  maxAge?: number;
  expires?: Date;
}

/** The options of the shop's own cookies. */
export function shopCookie(https: boolean, lifetime: { maxAge?: number; expires?: Date } = {}): CookieOptions {
  return { path: '/', httpOnly: true, secure: https, sameSite: 'lax', ...lifetime };
}

/** `localhost` and `*.localhost`: browsers treat them as secure contexts even over http. */
export function isLocalHost(host: string): boolean {
  return host === 'localhost' || host.endsWith('.localhost');
}

/**
 * The preview cookie: the editor frames the shop from another site, so the
 * cookie is `SameSite=None; Secure; Partitioned`. Over plain http that is
 * only accepted on localhost (dev); elsewhere it falls back to `Lax`, which
 * works when the preview is opened in its own tab.
 */
export function previewCookie(https: boolean, host: string): CookieOptions {
  const secure = https || isLocalHost(host);
  if (!secure) return { path: '/', httpOnly: true, secure: false, sameSite: 'lax', maxAge: DAY };
  return { path: '/', httpOnly: true, secure: true, sameSite: 'none', partitioned: true, maxAge: DAY };
}

/** The consent cookie (written by page script, read by the server too). */
export function consentCookie(https: boolean): CookieOptions {
  return { path: '/', httpOnly: false, secure: https, sameSite: 'lax', maxAge: 180 * DAY };
}

/** A `Set-Cookie` header value. */
export function serializeCookie(name: string, value: string, options: CookieOptions): string {
  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${options.path}`];
  if (options.maxAge !== undefined) parts.push(`Max-Age=${Math.max(0, Math.floor(options.maxAge))}`);
  if (options.expires) parts.push(`Expires=${options.expires.toUTCString()}`);
  if (options.httpOnly) parts.push('HttpOnly');
  if (options.secure) parts.push('Secure');
  parts.push(`SameSite=${options.sameSite === 'none' ? 'None' : 'Lax'}`);
  if (options.partitioned) parts.push('Partitioned');
  return parts.join('; ');
}

/** One cookie's value from a `Cookie` header; undefined when absent or empty. */
export function readCookie(header: string | null | undefined, name: string): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const at = part.indexOf('=');
    if (at < 0 || part.slice(0, at).trim() !== name) continue;
    const raw = part.slice(at + 1).trim();
    try {
      return decodeURIComponent(raw) || undefined;
    } catch {
      return raw || undefined;
    }
  }
  return undefined;
}
