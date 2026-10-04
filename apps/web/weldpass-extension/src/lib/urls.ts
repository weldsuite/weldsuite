/**
 * A saved login's URL as something safe to open in a tab. Items hold whatever
 * someone typed or imported, so anything that is not plain http(s) — a
 * `javascript:` or `data:` URL in particular — is refused.
 */
export function safeExternalUrl(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;

  // "example.com/login" and "localhost:3000" are addresses without a scheme;
  // "javascript:…" and "data:…" are schemes and must stay recognisable as such.
  const hasScheme = /^[a-z][a-z0-9+.-]*:(?!\d)/i.test(trimmed);
  try {
    const url = new URL(hasScheme ? trimmed : `https://${trimmed}`);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null;
  } catch {
    return null;
  }
}

/**
 * The address stored with a login saved from a page: origin and path only. The
 * query string and fragment are dropped because they routinely carry session
 * and reset tokens that have no business in a vault item.
 */
export function pageUrlForSaving(tabUrl: string | null | undefined): string | null {
  if (!tabUrl) return null;
  try {
    const url = new URL(tabUrl);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return `${url.origin}${url.pathname}`;
  } catch {
    return null;
  }
}
