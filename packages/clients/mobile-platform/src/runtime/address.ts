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
// host: DNS name, IPv4 or bracketed IPv6; optional port.
const HOST = /^(?:\[[0-9a-f:.]+\]|[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*)(?::(\d{1,5}))?$/i;

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
  const match = HOST.exec(authority);
  if (!match) return { ok: false, reason: 'invalid' };
  const port = match[1];
  if (port !== undefined && (Number(port) < 1 || Number(port) > 65535)) {
    return { ok: false, reason: 'invalid' };
  }

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
