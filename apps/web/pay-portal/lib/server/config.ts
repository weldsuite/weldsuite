/**
 * The portal's settings, from the environment (server only; the browser never
 * learns the backend's address):
 *
 * - `PAY_PORTAL_BACKEND_URL`: the WeldSuite server (`weldsuite serve`), e.g. `http://localhost:8789`;
 * - `PAY_PORTAL_PUBLIC_URL`: this portal's own origin (`https://pay.example.org`), where Mollie
 *   sends the customer back to. Optional: taken from the request's Host and
 *   `X-Forwarded-Proto` when unset.
 */

function env(name: string): string | undefined {
  const value = process.env[name]?.trim()
  return value ? value : undefined
}

/** The origin of an http(s) URL, or null. */
export function originOf(value: string): string | null {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.origin : null
  } catch {
    return null
  }
}

/** The value without trailing slashes (a linear scan: a `/\/+$/` regex backtracks quadratically on a long run of slashes). */
function stripTrailingSlashes(value: string): string {
  let end = value.length
  while (end > 0 && value.charCodeAt(end - 1) === 47) end--
  return value.slice(0, end)
}

/** The backend's base URL without a trailing slash; null while it is not set. */
export function backendBaseUrl(): string | null {
  const value = env('PAY_PORTAL_BACKEND_URL')
  return value ? stripTrailingSlashes(value) : null
}

/** The configured public origin, or null. */
export function configuredPublicOrigin(): string | null {
  const value = env('PAY_PORTAL_PUBLIC_URL')
  return value ? originOf(value) : null
}

/** The scheme to assume without `X-Forwarded-Proto`: plain http for localhost, https otherwise. */
function defaultProto(host: string): 'http' | 'https' {
  return /^localhost(:\d+)?$/.test(host) ? 'http' : 'https'
}

/** The origin the customer used: the configured one, else the request's (behind the ingress). */
export function publicOrigin(headers: Headers): string {
  const configured = configuredPublicOrigin()
  if (configured) return configured
  const host = headers.get('x-forwarded-host') ?? headers.get('host') ?? 'localhost'
  const forwarded = headers.get('x-forwarded-proto')
  const proto = forwarded === 'http' || forwarded === 'https' ? forwarded : defaultProto(host)
  return originOf(`${proto}://${host}`) ?? 'http://localhost'
}
