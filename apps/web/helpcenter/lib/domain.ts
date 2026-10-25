/**
 * Maps a request host to the help-center domain desk-api resolves a tenant
 * from (`/public/helpcenter/*?domain=`, DESK-006):
 *
 * - `acme.localhost:3008` → `acme.welddesk.org` (local dev)
 * - `localhost:3008`, `*.workers.dev` → `fallback` (no domain in the host)
 * - anything else (`acme.welddesk.org`, `help.acme.com`) → the host itself
 *
 * Returns `''` when there is nothing to serve; callers answer that with a 404.
 */
export function domainFromHost(host: string, fallback: string): string {
  const hostname = host.replace(/:\d+$/, '').toLowerCase()

  if (hostname === 'localhost' || hostname.endsWith('.localhost')) {
    const subdomain = hostname.slice(0, -'localhost'.length).replace(/\.$/, '')
    return subdomain ? `${subdomain}.welddesk.org` : fallback
  }
  if (hostname.endsWith('.workers.dev')) return fallback

  return hostname
}
