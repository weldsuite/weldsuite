/**
 * Link helpers for the mail composers' "Insert link" popover.
 */

// Only these end up in a mail: `javascript:` / `data:` links are never inserted.
const SAFE_SCHEMES = new Set(['http:', 'https:', 'mailto:', 'tel:']);

const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i;
// `localhost:3000` and `example.com:8080` look like a scheme but are a host and port.
const HOST_WITH_PORT = /^[a-z0-9.-]+:\d/i;
const EMAIL_ADDRESS = /^[^\s@/]+@[^\s@/]+\.[^\s@/]+$/;

/**
 * Turns what the user typed into a link target: adds `https://` to a bare host,
 * `mailto:` to an email address. Resolves to null for something that is not a
 * usable http(s), mailto or tel link.
 */
export function normalizeLinkUrl(raw: string): string | null {
  const value = raw.trim();
  if (!value || /\s/.test(value)) return null;

  let candidate = value;
  if (!HAS_SCHEME.test(value) || HOST_WITH_PORT.test(value)) {
    candidate = EMAIL_ADDRESS.test(value) ? `mailto:${value}` : `https://${value}`;
  }

  try {
    const url = new URL(candidate);
    return SAFE_SCHEMES.has(url.protocol) ? candidate : null;
  } catch {
    return null;
  }
}

/** Escapes text for use inside an HTML text node or a double-quoted attribute. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** The `<a>` markup the popover inserts. */
export function buildLinkHtml(url: string, text: string): string {
  return `<a href="${escapeHtml(url)}">${escapeHtml(text || url)}</a>`;
}
