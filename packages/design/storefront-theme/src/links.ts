/**
 * Which URLs a merchant's settings and rich text may point to. Only http(s),
 * `mailto:`, `tel:` and paths of this shop (`/…`, `#…`) are links; anything
 * else (`javascript:`, `data:`, `//other.host`) is dropped, so a section never
 * renders a link it should not.
 */

export interface SafeLink {
  href: string;
  /** Leaves the shop: gets `rel="noopener noreferrer"`. */
  external: boolean;
}

const SCHEMES = new Set(['http:', 'https:', 'mailto:', 'tel:']);

/** Whitespace or a control character: inside a URL, how scheme filters get fooled. */
function hasSpaceOrControl(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x20 || code === 0x7f || /\s/.test(value[i] ?? '')) return true;
  }
  return false;
}

/** A path of this shop: `/…` (not `//…` or `/\…`, which browsers read as another host) or `#…`. */
function isShopPath(value: string): boolean {
  if (value.startsWith('#')) return true;
  return value.startsWith('/') && !value.startsWith('//') && !value.startsWith('/\\');
}

/** The link `value` makes, or null when it is not one a shop may render. */
export function safeLink(value: unknown): SafeLink | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '' || hasSpaceOrControl(trimmed)) return null;
  if (isShopPath(trimmed)) return { href: trimmed, external: false };
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (!SCHEMES.has(url.protocol)) return null;
  const external = url.protocol === 'http:' || url.protocol === 'https:';
  return { href: url.href, external };
}

/** An image source a section may load: https (http too, for local installs) or a path of this shop. */
export function safeImageSrc(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '' || hasSpaceOrControl(trimmed)) return null;
  if (trimmed.startsWith('/') && !trimmed.startsWith('//') && !trimmed.startsWith('/\\')) return trimmed;
  try {
    const url = new URL(trimmed);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
}
