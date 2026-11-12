/**
 * The client address from an `X-Forwarded-For` header, counted from the right
 * so a value the client sent itself is never taken: `trustedProxies` is how
 * many proxies append to the header (1: the ingress controller). Null when the
 * header has fewer entries or the entry is not an address.
 */
export function forwardedClientIp(forwardedFor: string | null | undefined, trustedProxies = 1): string | null {
  if (!forwardedFor || trustedProxies < 1) return null
  const hops = forwardedFor
    .split(',')
    .map((hop) => hop.trim())
    .filter(Boolean)
  const ip = hops[hops.length - trustedProxies]
  return ip && /^[0-9A-Fa-f.:]{2,45}$/.test(ip) ? ip : null
}
