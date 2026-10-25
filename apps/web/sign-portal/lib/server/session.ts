import type { SignPortalSessionResponse } from '@weldsuite/app-api-client/schemas/weldsign'
import { sessionCookieName } from '@/lib/server/portal'

type SessionBody = { data?: SignPortalSessionResponse } & Record<string, unknown>

/**
 * Turns the answer of `openSession` / `verify` into the browser's response.
 * When it is `ready`, the session string goes into an httpOnly cookie (one per
 * link) and is removed from the JSON, so it never reaches browser JavaScript.
 */
export async function sessionResponse(request: Request, token: string, res: Response): Promise<Response> {
  const json = (await res.json().catch(() => ({}))) as SessionBody
  const data = json.data
  if (!res.ok || !data || data.state !== 'ready') return Response.json(json, { status: res.status })

  const { session, expiresAt, ...rest } = data
  const out = Response.json({ data: { ...rest, expiresAt } }, { status: res.status })
  const expires = new Date(expiresAt)
  const attributes = [
    `${await sessionCookieName(token)}=${encodeURIComponent(session)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    ...(new URL(request.url).protocol === 'https:' ? ['Secure'] : []),
    ...(Number.isNaN(expires.getTime()) ? [] : [`Expires=${expires.toUTCString()}`]),
  ]
  out.headers.append('Set-Cookie', attributes.join('; '))
  return out
}
