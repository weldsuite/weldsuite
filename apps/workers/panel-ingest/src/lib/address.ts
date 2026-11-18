/**
 * Who sent a browser request, and from where, when it may have come through a
 * reverse proxy on the customer's own domain (Next.js or Vercel rewrites, a
 * Cloudflare Worker, nginx: the recipes in `@weldsuite/panel-sdk/install`).
 *
 * - The client IP is the first `X-Forwarded-For` hop when the header is there,
 *   else `CF-Connecting-IP`. It feeds the cookieless hash, the project's IP
 *   filters and the per-IP rate limit, and is never stored. A browser can send
 *   its own `X-Forwarded-For`; what it gains is a different cookieless id and a
 *   different rate-limit key, which is why `POST /e` keeps a second, much
 *   higher ceiling per connecting IP.
 * - Geo comes from the proxy's `X-WeldPanel-Country` / `-Region` / `-City`, or
 *   Vercel's `x-vercel-ip-country` / `-country-region` / `-city`, when the
 *   country header of that family is there; else from Cloudflare's
 *   `request.cf`. Values may be percent-encoded (Vercel's city is).
 *
 * The Rust collector does the same (rust/modules/panel/src/collector/proxy.rs),
 * without `request.cf`.
 */

export interface RequestAddresses {
  /** The visitor's address as far as we can tell. */
  client: string;
  /** The address that opened the connection to us (the proxy, when there is one). */
  connecting: string;
}

export interface RequestGeo {
  country: string | null;
  region: string | null;
  city: string | null;
}

export function requestAddresses(headers: Headers): RequestAddresses {
  const connecting = headers.get('CF-Connecting-IP') ?? '';
  const firstHop = (headers.get('X-Forwarded-For') ?? '')
    .split(',')
    .map((hop) => hop.trim())
    .find((hop) => hop !== '');
  return { client: firstHop ?? connecting, connecting };
}

const MAX_GEO_VALUE = 100;

/** A header value as stored: percent-decoded when it decodes, trimmed, at most 100 characters; null when empty. */
function geoValue(raw: string | null): string | null {
  if (raw === null) return null;
  let value = raw;
  if (value.includes('%')) {
    try {
      value = decodeURIComponent(value);
    } catch {
      // Not valid percent-encoding: keep it as sent.
    }
  }
  const cleaned = value.trim().slice(0, MAX_GEO_VALUE);
  return cleaned === '' ? null : cleaned;
}

/** ISO 3166-1 alpha-2, upper case; `XX` (unknown) and anything else is null. */
function countryCode(raw: string | null): string | null {
  const value = geoValue(raw)?.toUpperCase() ?? null;
  return value && /^[A-Z]{2}$/.test(value) && value !== 'XX' ? value : null;
}

const HEADER_FAMILIES = [
  ['X-WeldPanel-Country', 'X-WeldPanel-Region', 'X-WeldPanel-City'],
  ['x-vercel-ip-country', 'x-vercel-ip-country-region', 'x-vercel-ip-city'],
] as const;

const cfValue = (value: string | undefined): string | null => (value && value !== 'XX' ? value : null);

/** Geo of the request: a proxy's headers when it sent them, else Cloudflare's. */
export function requestGeo(headers: Headers, cf: { country?: string; region?: string; city?: string } | undefined): RequestGeo {
  for (const [country, region, city] of HEADER_FAMILIES) {
    const sent = headers.get(country);
    if (sent !== null && sent.trim() !== '') {
      return { country: countryCode(sent), region: geoValue(headers.get(region)), city: geoValue(headers.get(city)) };
    }
  }
  return { country: cfValue(cf?.country), region: cfValue(cf?.region), city: cfValue(cf?.city) };
}
