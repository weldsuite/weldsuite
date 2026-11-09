/**
 * `/api/*`: what the browser calls. Each route is forwarded to forms-api's
 * `/public/forms/*` with the key, the respondent's IP, country and browser
 * added (lib/server/forms-api.ts). Only the routes the page uses are
 * forwarded; anything else is a 404 here, so the portal is not an open relay
 * to the backend.
 */

import { callFormsApi, errorResponse } from '@/lib/server/forms-api'

interface Route {
  method: string
  pattern: RegExp
  /** Uploads: the multipart body is passed on as a stream. */
  upload?: boolean
}

const ID = '[A-Za-z0-9_-]{1,40}'

const ROUTES: Route[] = [
  { method: 'GET', pattern: new RegExp(`^/f/${ID}$`) },
  { method: 'POST', pattern: new RegExp(`^/f/${ID}/(view|sessions|send-code|verify|report)$`) },
  { method: 'PUT', pattern: /^\/sessions\/progress$/ },
  { method: 'POST', pattern: /^\/sessions\/submit$/ },
  { method: 'POST', pattern: /^\/sessions\/uploads$/, upload: true },
  { method: 'GET', pattern: /^\/altcha\/challenge$/ },
]

/** The platform maximum for one file is 25 MB; leave room for the multipart framing. */
const MAX_UPLOAD_BYTES = 27 * 1024 * 1024
const MAX_JSON_BYTES = 2 * 1024 * 1024

/** Headers worth passing from the browser: the session, content type and length. */
function browserHeaders(request: Request): Record<string, string> {
  const out: Record<string, string> = {}
  const authorization = request.headers.get('authorization')
  if (authorization) out.Authorization = authorization
  const type = request.headers.get('content-type')
  if (type) out['Content-Type'] = type
  return out
}

/** Whether a cross-site page sent this request; an embedded form on a host page is same-origin to the portal, so this only refuses third-party forgeries. */
function isCrossSite(request: Request): boolean {
  return request.headers.get('sec-fetch-site') === 'cross-site'
}

export async function proxyToFormsApi(request: Request, rest: string): Promise<Response> {
  const path = `/${rest.replace(/^\/+/, '')}`
  const method = request.method.toUpperCase()
  const route = ROUTES.find((r) => r.method === method && r.pattern.test(path))
  if (!route) return errorResponse(404, 'NOT_FOUND', 'Not found')
  if (method !== 'GET' && isCrossSite(request)) return errorResponse(403, 'FORBIDDEN', 'Forbidden')

  const url = new URL(request.url)
  const search = path.startsWith('/f/') && method === 'GET' ? (url.searchParams.get('versionId') ? `?versionId=${encodeURIComponent(url.searchParams.get('versionId') ?? '')}` : '') : ''

  let body: BodyInit | null = null
  if (method !== 'GET') {
    const length = Number(request.headers.get('content-length') ?? '0')
    if (length > (route.upload ? MAX_UPLOAD_BYTES : MAX_JSON_BYTES)) return errorResponse(413, 'PAYLOAD_TOO_LARGE', 'The request is too large.')
    body = route.upload ? request.body : await request.text()
  }

  const res = await callFormsApi(request, `${path}${search}`, { method, body, headers: browserHeaders(request) })
  // Pass the answer through; nothing here may be cached by a shared cache (it is one respondent's).
  const headers = new Headers({ 'Content-Type': res.headers.get('content-type') ?? 'application/json', 'Cache-Control': 'no-store' })
  const retry = res.headers.get('retry-after')
  if (retry) headers.set('Retry-After', retry)
  return new Response(res.body, { status: res.status, headers })
}
