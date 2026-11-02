import { deleteCookie, getCookie, getRequest, setCookie } from '@tanstack/react-start/server'

/**
 * The reader's help-center session, kept in httpOnly cookies so the token
 * never reaches browser JavaScript (same approach as the sign portal).
 *
 * - `hc_session`: the opaque token helpdesk-widget-api issued; sent upstream
 *   as `x-portal-session`.
 * - `hc_email`: the address it was issued for, only so the header can show
 *   who is signed in without a round trip. Never used to authorise anything;
 *   every portal call is checked upstream against the token.
 *
 * Both are cleared on sign-out and whenever widget-api says the session is gone.
 */
const SESSION_COOKIE = 'hc_session'
const EMAIL_COOKIE = 'hc_email'

function isHttps(): boolean {
  return new URL(getRequest().url).protocol === 'https:'
}

function baseOptions() {
  return { path: '/', httpOnly: true, sameSite: 'lax' as const, secure: isHttps() }
}

export function readSessionToken(): string | undefined {
  return getCookie(SESSION_COOKIE) || undefined
}

/** The signed-in reader's email, for display; null when there is no session. */
export function readSignedInEmail(): string | null {
  if (!readSessionToken()) return null
  return getCookie(EMAIL_COOKIE) || null
}

export function storeSession(token: string, expiresAt: string, email: string): void {
  const expires = new Date(expiresAt)
  const options = {
    ...baseOptions(),
    ...(Number.isNaN(expires.getTime()) ? {} : { expires }),
  }
  setCookie(SESSION_COOKIE, token, options)
  setCookie(EMAIL_COOKIE, email, options)
}

export function clearSession(): void {
  deleteCookie(SESSION_COOKIE, baseOptions())
  deleteCookie(EMAIL_COOKIE, baseOptions())
}

/**
 * State-changing calls only come from this help center's own pages. Modern
 * browsers send `Sec-Fetch-Site`; otherwise the `Origin` must name this host.
 * A request with neither is refused.
 */
export function isSameSiteRequest(request: Request = getRequest()): boolean {
  const site = request.headers.get('sec-fetch-site')
  if (site) return site === 'same-origin'

  const origin = request.headers.get('origin')
  if (!origin) return false
  try {
    const host = request.headers.get('host') ?? new URL(request.url).host
    return new URL(origin).host.toLowerCase() === host.toLowerCase()
  } catch {
    return false
  }
}
