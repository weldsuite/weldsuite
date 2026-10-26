/**
 * Server-only: the signer portal's operations (@weldsuite/sign-domain/portal)
 * bound to this Worker, plus the cookie that carries a signer session.
 *
 * There is no API in between (ADR FE-016): the domain code opens the master
 * and tenant DBs, R2 and the queue through this Worker's own bindings. Never
 * import this from a client component.
 */

import { env, waitUntil } from 'cloudflare:workers'
import { createSignPortal, type PortalContext } from '@weldsuite/sign-domain/portal'

export const portal = createSignPortal()

/** Header the browser sends with every portal call: the link the page was opened with. */
export const SIGN_LINK_HEADER = 'x-sign-link'

const COOKIE = 'signportal_session'

/**
 * The session cookie of one signing link. Each link gets its own cookie, so a
 * signer with two requests open in two tabs keeps both sessions apart.
 */
export async function sessionCookieName(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
  return `${COOKIE}_${hex.slice(0, 16)}`
}

/**
 * What every operation runs with. The signer's IP comes straight from
 * Cloudflare's edge (`CF-Connecting-IP`), which a browser cannot set, so the
 * evidence trail needs no shared key any more.
 */
export function portalContext(request: Request): PortalContext {
  return {
    env,
    meta: {
      ip: request.headers.get('cf-connecting-ip'),
      userAgent: request.headers.get('user-agent')?.slice(0, 500) ?? null,
    },
    waitUntil,
  }
}

/** The signer session of the link this request is for, from its httpOnly cookie. */
export async function sessionFor(request: Request): Promise<string | undefined> {
  const link = request.headers.get(SIGN_LINK_HEADER)
  if (!link) return undefined
  const name = await sessionCookieName(link)
  const cookie = request.headers.get('cookie') ?? ''
  for (const part of cookie.split(';')) {
    const [key, ...value] = part.trim().split('=')
    if (key === name) return decodeURIComponent(value.join('='))
  }
  return undefined
}

/** Signed documents and envelopes are private; never let a cache keep them. */
export function noStore(res: Response): Response {
  const out = new Response(res.body, res)
  out.headers.set('cache-control', 'private, no-store')
  return out
}
