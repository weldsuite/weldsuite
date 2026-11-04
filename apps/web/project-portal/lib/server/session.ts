import { deleteCookie, getRequest, setCookie } from '@tanstack/react-start/server'

/**
 * The portal session, kept in an httpOnly cookie so the token never reaches
 * browser JavaScript. One cookie per workspace (`pp_session_<slug>`): a
 * contact can have access in several workspaces and each keeps its own
 * session. The token is flow-api's opaque session token; every call to
 * flow-api sends it as `Authorization: Bearer`, and flow-api checks access
 * again on every request.
 *
 * Thirty days, like the session in KV, and set again whenever the portal
 * checks the session (flow-api slides its own expiry the same way).
 */
const COOKIE_PREFIX = 'pp_session_'
const MAX_AGE_SECONDS = 60 * 60 * 24 * 30

export function sessionCookieName(slug: string): string {
  return `${COOKIE_PREFIX}${slug}`
}

function isHttps(request: Request): boolean {
  return new URL(request.url).protocol === 'https:'
}

function baseOptions(request: Request) {
  return { path: '/', httpOnly: true, sameSite: 'lax' as const, secure: isHttps(request) }
}

/** The session token of a workspace, from the request's cookies; undefined when signed out. */
export function readSessionToken(slug: string, request: Request = getRequest()): string | undefined {
  const name = sessionCookieName(slug)
  for (const part of (request.headers.get('cookie') ?? '').split(';')) {
    const [key, ...value] = part.trim().split('=')
    if (key === name) return decodeURIComponent(value.join('=')) || undefined
  }
  return undefined
}

/** Put the session in the cookie (inside a server function). */
export function storeSession(slug: string, token: string): void {
  setCookie(sessionCookieName(slug), token, { ...baseOptions(getRequest()), maxAge: MAX_AGE_SECONDS })
}

/** Remove the cookie (inside a server function). */
export function clearSession(slug: string): void {
  deleteCookie(sessionCookieName(slug), baseOptions(getRequest()))
}

/** The `Set-Cookie` value that removes the cookie, for a plain route handler's response. */
export function clearedSessionCookie(slug: string, request: Request): string {
  return [
    `${sessionCookieName(slug)}=`,
    'Path=/',
    'Max-Age=0',
    'HttpOnly',
    'SameSite=Lax',
    ...(isHttps(request) ? ['Secure'] : []),
  ].join('; ')
}

/**
 * State-changing calls only come from the portal's own pages. Browsers send
 * `Sec-Fetch-Site`; otherwise the `Origin` must name this host. A request
 * with neither is refused. (SameSite=Lax already keeps the cookie off
 * cross-site POSTs; this is the second line.)
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
