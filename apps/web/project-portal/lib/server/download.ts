import { parseWorkspaceSlug } from '@/lib/slug'
import { PortalApiError, portalApi } from '@/lib/server/flow-api'
import { clearedSessionCookie, readSessionToken } from '@/lib/server/session'

/**
 * Server-only: a file or document download for the signed-in contact.
 *
 * The browser asks this app (a plain link, so the session cookie goes along);
 * the app asks flow-api with the session as a bearer and hands the answer back
 * as it came: the bytes are streamed, not buffered, and the headers that make
 * it a download (type, size, `Content-Disposition: attachment`) are kept. The
 * session token never reaches the browser.
 */

/** The headers of flow-api's answer worth passing on; hop-by-hop and cache headers are not. */
const PASSED_HEADERS = ['content-type', 'content-length', 'content-disposition', 'x-content-type-options'] as const

function text(status: number, body: string): Response {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'private, no-store' },
  })
}

/** A dead session: clear the cookie and send the reader to sign in. */
function toSignIn(slug: string, request: Request, reason: 'expired' | 'revoked'): Response {
  return new Response(null, {
    status: 302,
    headers: {
      Location: `/${slug}?reason=${reason}`,
      'Set-Cookie': clearedSessionCookie(slug, request),
      'Cache-Control': 'private, no-store',
    },
  })
}

function downloadHeaders(upstream: Response): Headers {
  const headers = new Headers({ 'Cache-Control': 'private, no-store' })
  for (const name of PASSED_HEADERS) {
    const value = upstream.headers.get(name)
    if (value) headers.set(name, value)
  }
  // A download is never shown by the browser.
  if (!headers.has('content-disposition')) headers.set('Content-Disposition', 'attachment')
  return headers
}

/** The answer for a failed download; null when the failure is not one flow-api describes. */
function apiErrorResponse(err: PortalApiError, slug: string, request: Request): Response | null {
  if (err.status === 401) return toSignIn(slug, request, err.message === 'Access revoked' ? 'revoked' : 'expired')
  if (err.status === 404) return text(404, 'Not found')
  if (err.status === 503) return text(503, 'The portal is temporarily unavailable')
  return null
}

export async function downloadResponse(
  request: Request,
  params: { workspace: string; projectId: string; kind: string; itemId: string },
): Promise<Response> {
  const slug = parseWorkspaceSlug(params.workspace)
  const { projectId, itemId } = params
  if (!slug || (params.kind !== 'files' && params.kind !== 'documents') || !projectId || !itemId) {
    return text(404, 'Not found')
  }

  const token = readSessionToken(slug, request)
  if (!token) return toSignIn(slug, request, 'expired')

  try {
    const api = portalApi(token)
    const upstream =
      params.kind === 'files' ? await api.downloadFile(projectId, itemId) : await api.downloadDocument(projectId, itemId)
    return new Response(upstream.body, { status: 200, headers: downloadHeaders(upstream) })
  } catch (err) {
    const answer = err instanceof PortalApiError ? apiErrorResponse(err, slug, request) : null
    if (answer) return answer
    console.error('[project-portal] download failed:', err)
    return text(502, 'The file could not be downloaded')
  }
}
