/**
 * Server-only access to forms-api's public routes (`/public/forms/*`).
 *
 * The portal never opens a database. Every call carries the shared key
 * (`X-Forms-Portal-Key`), the respondent's address (`X-Respondent-Ip`, read
 * from the edge or the trusted proxy, never from a header the browser can set),
 * their country and browser. Session routes also take the respondent's session
 * as `Authorization: Bearer`, which the browser sends to the portal's own
 * `/api/*` routes and the proxy passes on.
 */

import type { PublicForm } from '@weldsuite/app-api-client/schemas/weldforms'
import { backend, respondentCountry, respondentIp } from '@/lib/server/runtime'

/** The header names of `FORMS_PORTAL_HEADERS` (schemas/weldforms.ts). Kept literal so no schema code is bundled for them. */
const KEY_HEADER = 'X-Forms-Portal-Key'
const IP_HEADER = 'X-Respondent-Ip'
const COUNTRY_HEADER = 'X-Respondent-Country'

/** A JSON error in forms-api's shape, for when the portal itself cannot reach it. */
export function errorResponse(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  })
}

export interface ForwardInit {
  method?: string
  /** A string, or the browser's own body stream (uploads). */
  body?: BodyInit | null
  headers?: Record<string, string>
}

/** One call to `/public/forms<path>`. Never throws: an unreachable backend is a 503 response. */
export async function callFormsApi(request: Request, path: string, init: ForwardInit = {}): Promise<Response> {
  const api = backend()
  if (!api.secret) return errorResponse(503, 'SERVICE_UNAVAILABLE', 'The forms portal is not configured on this deployment.')

  const headers = new Headers(init.headers)
  headers.set(KEY_HEADER, api.secret)
  const ip = respondentIp(request)
  if (ip) headers.set(IP_HEADER, ip)
  const country = respondentCountry(request)
  if (country) headers.set(COUNTRY_HEADER, country)
  const agent = request.headers.get('user-agent')
  if (agent) headers.set('User-Agent', agent.slice(0, 500))
  if (!headers.has('Accept')) headers.set('Accept', 'application/json')

  const body = init.body ?? null
  try {
    return await api.send(`${api.base}${path}`, {
      method: init.method ?? 'GET',
      headers,
      body,
      // Node's fetch needs this to send a stream; Workers ignore it.
      ...(body !== null && typeof body !== 'string' ? { duplex: 'half' } : {}),
    } as RequestInit)
  } catch (err) {
    console.error('[forms-portal] forms-api unreachable:', err)
    return errorResponse(503, 'UNAVAILABLE', 'forms-api unreachable')
  }
}

export type PublicFormResult =
  | { ok: true; form: PublicForm }
  | { ok: false; status: number; code: string }

/** The published form of a public id (`GET /f/:publicId`). */
export async function fetchPublicForm(request: Request, publicId: string, versionId?: string): Promise<PublicFormResult> {
  const query = versionId ? `?versionId=${encodeURIComponent(versionId)}` : ''
  const res = await callFormsApi(request, `/f/${encodeURIComponent(publicId)}${query}`)
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: { code?: unknown } } | null
    return { ok: false, status: res.status, code: typeof body?.error?.code === 'string' ? body.error.code : 'UPSTREAM_ERROR' }
  }
  const body = (await res.json().catch(() => null)) as { data?: PublicForm } | null
  if (!body?.data) return { ok: false, status: 502, code: 'UPSTREAM_ERROR' }
  return { ok: true, form: body.data }
}
