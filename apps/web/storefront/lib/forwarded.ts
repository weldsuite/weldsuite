/**
 * What the storefront edge tells the renderer about the shopper's request
 * (contract "Edge → renderer"). The renderer only answers the edge, so these
 * headers are the edge's, never the browser's.
 */

const ADDRESS = /^[0-9A-Fa-f.:]{2,45}$/;

/** The shop host: `X-Storefront-Host`, lowercase, without a port. */
export function shopHost(headers: Headers): string {
  const value = (headers.get('x-storefront-host') ?? '').trim().toLowerCase();
  // Strip a port, but not the colons of a bracketed IPv6 address.
  return value.replace(/:\d+$/, '');
}

/**
 * The shopper's IP. The edge replaces `X-Forwarded-For` with one address
 * (worked out with the install's trusted proxies); if a list arrives anyway,
 * the last entry is the one the edge added.
 */
export function shopperIp(headers: Headers): string | undefined {
  const entries = (headers.get('x-forwarded-for') ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  const ip = entries[entries.length - 1];
  return ip && ADDRESS.test(ip) ? ip : undefined;
}

/** Whether the shopper came over HTTPS (`X-Forwarded-Proto`). */
export function isHttps(headers: Headers): boolean {
  return (headers.get('x-forwarded-proto') ?? '').split(',')[0]?.trim().toLowerCase() === 'https';
}

/** The published version the edge knows for this host, for the document cache. */
export function edgeVersion(headers: Headers): string | undefined {
  const value = headers.get('x-storefront-version')?.trim();
  return value || undefined;
}
