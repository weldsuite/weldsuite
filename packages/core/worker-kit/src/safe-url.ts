/**
 * The check for a URL a workspace gives us to call from the server (an audit
 * log stream, later a webhook of the same kind): HTTPS only, no credentials in
 * the URL, and a host that does not point at a private network.
 *
 * This looks at the URL text only. It cannot see where a public name resolves
 * to, so a hostname that someone points at a private address is not caught
 * here; Cloudflare Workers cannot fetch private ranges from the edge anyway,
 * and the Kubernetes editions put an egress policy on top.
 */

export type SafeUrlResult = { ok: true; url: URL } | { ok: false; reason: string };

const BLOCKED_SUFFIXES = ['.internal', '.local', '.localhost'] as const;

type Ipv4 = [number, number, number, number];

/** `a.b.c.d` as four numbers, or null when `host` is not a dotted IPv4 literal (the WHATWG parser already turned 0x7f.1 and 2130706433 into this form). */
function parseIpv4(host: string): Ipv4 | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const parts: Ipv4 = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
  return parts.every((p) => p <= 255) ? parts : null;
}

/** CGNAT (100.64/10), link-local (169.254/16) and the private 172.16/12 and 192.168/16. */
function isPrivateRangeIpv4(a: number, b: number): boolean {
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  return a === 192 && b === 168;
}

/** 192.0.0/24, benchmarking (198.18/15) and the three documentation ranges. */
function isSpecialPurposeIpv4(a: number, b: number, c: number): boolean {
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a === 198 && b === 51 && c === 100) return true;
  return a === 203 && b === 0 && c === 113;
}

/** Loopback, private, link-local, CGNAT, benchmarking, documentation, multicast and reserved IPv4. */
function isBlockedIpv4([a, b, c]: Ipv4): boolean {
  if (a === 0 || a === 10 || a === 127) return true;
  if (isPrivateRangeIpv4(a, b)) return true;
  if (isSpecialPurposeIpv4(a, b, c)) return true;
  return a >= 224;
}

/** The IPv4 address inside a mapped (`::ffff:`) or NAT64 (`64:ff9b::`) IPv6 literal, as the URL parser prints it (two hex groups). */
function embeddedIpv4(address: string): Ipv4 | null {
  const m = /^(?:::ffff:|::|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(address);
  if (!m) return null;
  const hi = Number.parseInt(m[1], 16);
  const lo = Number.parseInt(m[2], 16);
  return [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff];
}

/** Loopback, unspecified, unique-local, link-local, multicast and IPv4-embedding IPv6 literals (brackets stripped). */
function isBlockedIpv6(address: string): boolean {
  if (address === '::' || address === '::1') return true;
  const first = address.split(':')[0];
  if (/^f[cd][0-9a-f]{2}$/.test(first)) return true; // fc00::/7
  if (/^fe[89ab][0-9a-f]$/.test(first)) return true; // fe80::/10
  if (/^ff[0-9a-f]{2}$/.test(first)) return true; // multicast
  const embedded = embeddedIpv4(address);
  return embedded !== null && isBlockedIpv4(embedded);
}

/** True when a hostname (as `URL.hostname` returns it) names a place we refuse to call. */
export function isBlockedHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  if (host === '') return true;
  if (host.startsWith('[') && host.endsWith(']')) return isBlockedIpv6(host.slice(1, -1));
  const ipv4 = parseIpv4(host);
  if (ipv4) return isBlockedIpv4(ipv4);
  if (host === 'localhost') return true;
  if (BLOCKED_SUFFIXES.some((suffix) => host.endsWith(suffix))) return true;
  // A name without a dot is an intranet name (`metadata`, `intranet`), never a public collector.
  return !host.includes('.');
}

/** Parse `raw` and say whether the server may call it; `reason` is safe to show the member. */
export function checkSafeUrl(raw: string): SafeUrlResult {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { ok: false, reason: 'The URL is not valid' };
  }
  if (url.protocol !== 'https:') return { ok: false, reason: 'The URL must start with https://' };
  if (url.username !== '' || url.password !== '') return { ok: false, reason: 'The URL must not contain credentials' };
  if (isBlockedHost(url.hostname)) return { ok: false, reason: 'The URL points at a private or local address' };
  return { ok: true, url };
}

export function isSafeUrl(raw: string): boolean {
  return checkSafeUrl(raw).ok;
}
