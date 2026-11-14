/**
 * From what a person types ("weldsuite.example.com", "https://Weld.Example.com/app")
 * to a server origin ("https://weldsuite.example.com").
 *
 * Only HTTPS: production builds block cleartext traffic, and a self-hosted
 * server must have a certificate the phone trusts. Development builds may
 * pass `allowInsecure` to reach a server on the local network.
 */

export type AddressResult =
  | { ok: true; origin: string }
  | { ok: false; reason: 'empty' | 'invalid' | 'insecure' };

const SCHEME = /^([a-z][a-z0-9+.-]*):\/\//i;
const IPV6 = /^\[[0-9a-f:.]+\]$/i;
const LABEL = /^[a-z0-9-]{1,63}$/i;
const PORT = /^\d{1,5}$/;

interface Authority {
  host: string;
  port: string | undefined;
}

/** `[v6 address]` or `[v6 address]:port`. */
function splitBracketed(authority: string): Authority | null {
  const close = authority.indexOf(']');
  if (close < 0) return null;
  const host = authority.slice(0, close + 1);
  const rest = authority.slice(close + 1);
  if (!IPV6.test(host)) return null;
  if (!rest) return { host, port: undefined };
  return rest.startsWith(':') ? { host, port: rest.slice(1) } : null;
}

/** `name` or `name:port`, a DNS name or an IPv4 address. */
function splitPlain(authority: string): Authority | null {
  const colon = authority.lastIndexOf(':');
  const host = colon >= 0 ? authority.slice(0, colon) : authority;
  const port = colon >= 0 ? authority.slice(colon + 1) : undefined;
  const validLabel = (label: string) => LABEL.test(label) && !label.startsWith('-') && !label.endsWith('-');
  return host.split('.').every(validLabel) ? { host, port } : null;
}

function isValidPort(port: string | undefined): boolean {
  if (port === undefined) return true;
  return PORT.test(port) && Number(port) >= 1 && Number(port) <= 65535;
}

/** `host[:port]`: a DNS name or IPv4 address, or a bracketed IPv6 address. Null when invalid. */
function splitAuthority(authority: string): Authority | null {
  const parts = authority.startsWith('[') ? splitBracketed(authority) : splitPlain(authority);
  return parts && isValidPort(parts.port) ? parts : null;
}

export function normaliseServerAddress(
  input: string,
  options: { allowInsecure?: boolean } = {},
): AddressResult {
  const trimmed = input.trim();
  if (!trimmed) return { ok: false, reason: 'empty' };

  const withScheme = SCHEME.test(trimmed) ? trimmed : `https://${trimmed}`;
  const scheme = SCHEME.exec(withScheme)?.[1]?.toLowerCase();
  if (scheme !== 'https' && scheme !== 'http') return { ok: false, reason: 'invalid' };
  if (scheme === 'http' && !options.allowInsecure) return { ok: false, reason: 'insecure' };

  const rest = withScheme.slice(withScheme.indexOf('://') + 3);
  // The authority ends at the first path, query or fragment character.
  const authority = rest.split(/[/?#]/, 1)[0] ?? '';
  if (authority.includes('@')) return { ok: false, reason: 'invalid' };
  if (!splitAuthority(authority)) return { ok: false, reason: 'invalid' };

  let host = authority.toLowerCase();
  // Drop the scheme's default port.
  if ((scheme === 'https' && host.endsWith(':443')) || (scheme === 'http' && host.endsWith(':80'))) {
    host = host.slice(0, host.lastIndexOf(':'));
  }
  return { ok: true, origin: `${scheme}://${host}` };
}

/** The host part of an origin, for display ("weldsuite.example.com"). */
export function hostOf(origin: string): string {
  return origin.replace(SCHEME, '');
}
