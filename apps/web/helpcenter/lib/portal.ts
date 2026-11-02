/**
 * The signed-in help center ("portal"): sign-in with an email code, the
 * request form, "My requests" and replies.
 *
 * Each export is a TanStack Start server function, like lib/api-client.ts:
 * it runs in the Worker and calls helpdesk-widget-api's /api/portal/* there,
 * so neither widget-api's origin nor the session token reaches the browser.
 * The help center is always the one this host serves (`requestDomain`).
 *
 * Reads answer `{ signedIn: false }` when there is no (longer a) session, and
 * the route redirects to /sign-in. They 404 when sign-in is off here.
 * Mutations answer `{ ok: false, code }` instead of throwing, so a form can
 * show the problem inline, and refuse cross-site callers.
 */
import { notFound } from '@tanstack/react-router'
import { createServerFn } from '@tanstack/react-start'
import {
  deskPortalAuthRequestSchema,
  deskPortalAuthVerifySchema,
  deskPortalCreateRequestSchema,
  deskPortalListRequestsQuerySchema,
  deskPortalReplySchema,
  type DeskPortalMessage,
  type DeskPortalRequestDetail,
  type DeskPortalRequestSummary,
  type DeskPortalRequestType,
  type DeskPortalSession,
} from '@weldsuite/app-api-client/schemas/desk-portal'
import { requestDomain } from '@/lib/server/upstream'
import { isPortalEnabled, portalApi, type PortalApiResult } from '@/lib/server/widget-api'
import {
  clearSession,
  isSameSiteRequest,
  readSessionToken,
  storeSession,
} from '@/lib/server/portal-session'

// ============================================================================
// Result shapes
// ============================================================================

/** Why a mutation failed. `field` names the form input at fault, when there is one. */
export interface PortalFailure {
  ok: false
  code: string
  field?: string
}

export type PortalOutcome<T> = { ok: true; data: T } | PortalFailure

export type SignedInRead<T> = { signedIn: true; data: T } | { signedIn: false }

export interface RequestsPage {
  requests: DeskPortalRequestSummary[]
  hasMore: boolean
  cursor: string | null
}

const fail = (code: string, field?: string): PortalFailure => (field ? { ok: false, code, field } : { ok: false, code })

/** Upstream failure → the code a page maps to a message; clears a dead session. */
function failureOf(result: Extract<PortalApiResult<unknown>, { ok: false }>): PortalFailure {
  if (result.status === 401) {
    clearSession()
    return fail('SIGN_IN_REQUIRED')
  }
  if (result.status === 404 && result.error.code === 'NOT_FOUND') return fail('NOT_FOUND')
  const details = result.error.details as { field?: unknown } | undefined
  return fail(result.error.code, typeof details?.field === 'string' ? details.field : undefined)
}

/** The first Zod issue's top-level key, the field a form highlights. */
function zodField(error: { issues: ReadonlyArray<{ path: ReadonlyArray<string | number> }> }): string | undefined {
  const key = error.issues[0]?.path[0]
  return typeof key === 'string' ? key : undefined
}

function sameSiteDomain(): string | null {
  const domain = requestDomain()
  return domain && isSameSiteRequest() ? domain : null
}

/**
 * A signed-in GET. No session: 404 when sign-in is off here, else signed out.
 * An expired session is cleared and reads as signed out; a missing request or
 * a switched-off portal is a 404; anything else is an error page.
 */
async function signedInGet<T>(path: string, params?: Record<string, string | undefined>): Promise<SignedInRead<T>> {
  const domain = requestDomain()
  if (!domain) throw notFound()
  const session = readSessionToken()
  if (!session) {
    if (!(await isPortalEnabled(domain))) throw notFound()
    return { signedIn: false }
  }

  const result = await portalApi<T>(path, domain, { session, params })
  if (result.ok) return { signedIn: true, data: result.data }
  if (result.status === 401) {
    clearSession()
    return { signedIn: false }
  }
  if (result.status === 404) throw notFound()
  throw new Error(`Portal request failed: ${result.status} ${result.error.code}`)
}

// ============================================================================
// Pages
// ============================================================================

/** The sign-in page: 404 when sign-in is off here. */
export const getSignInPage = createServerFn({ method: 'GET' }).handler(async () => {
  const domain = requestDomain()
  if (!domain || !(await isPortalEnabled(domain))) throw notFound()
  return { signedIn: Boolean(readSessionToken()) }
})

export const getMyRequests = createServerFn({ method: 'GET' })
  .validator((input: { status?: 'open' | 'closed'; cursor?: string }) => input)
  .handler(async ({ data }): Promise<SignedInRead<RequestsPage>> => {
    const query = deskPortalListRequestsQuerySchema.safeParse({ status: data.status, cursor: data.cursor || undefined })
    const params = query.success ? query.data : {}
    return signedInGet<RequestsPage>('/requests', {
      status: params.status,
      cursor: params.cursor,
      limit: '20',
    })
  })

export const getRequestTypes = createServerFn({ method: 'GET' }).handler(
  (): Promise<SignedInRead<DeskPortalRequestType[]>> => signedInGet<DeskPortalRequestType[]>('/request-types'),
)

export const getRequestDetail = createServerFn({ method: 'GET' })
  .validator((input: { id: string }) => input)
  .handler(async ({ data }): Promise<SignedInRead<DeskPortalRequestDetail>> => {
    const id = typeof data.id === 'string' ? data.id.trim() : ''
    if (!id || id.length > 64) throw notFound()
    return signedInGet<DeskPortalRequestDetail>(`/requests/${encodeURIComponent(id)}`)
  })

// ============================================================================
// Sign-in
// ============================================================================

const isLocale = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-z]{2}(-[A-Za-z]{2})?$/.test(value)

/** Email a sign-in code, in the reader's language. */
export const requestSignInCode = createServerFn({ method: 'POST' })
  .validator((input: { email: string; locale?: string }) => input)
  .handler(async ({ data }): Promise<PortalOutcome<null>> => {
    const domain = sameSiteDomain()
    if (!domain) return fail('FORBIDDEN')
    const parsed = deskPortalAuthRequestSchema.safeParse({ email: data.email })
    if (!parsed.success) return fail('INVALID_EMAIL', 'email')

    const result = await portalApi<{ ok: true }>('/auth/request', domain, {
      method: 'POST',
      body: { email: parsed.data.email, ...(isLocale(data.locale) ? { locale: data.locale } : {}) },
    })
    return result.ok ? { ok: true, data: null } : failureOf(result)
  })

/** Check the code; on success the session goes into the httpOnly cookie. */
export const verifySignInCode = createServerFn({ method: 'POST' })
  .validator((input: { email: string; code: string }) => input)
  .handler(async ({ data }): Promise<PortalOutcome<{ email: string }>> => {
    const domain = sameSiteDomain()
    if (!domain) return fail('FORBIDDEN')
    const parsed = deskPortalAuthVerifySchema.safeParse(data)
    if (!parsed.success) return fail(zodField(parsed.error) === 'email' ? 'INVALID_EMAIL' : 'INVALID_CODE', zodField(parsed.error))

    const result = await portalApi<DeskPortalSession>('/auth/verify', domain, { method: 'POST', body: parsed.data })
    if (!result.ok) return failureOf(result)
    storeSession(result.data.session, result.data.expiresAt, result.data.user.email)
    return { ok: true, data: { email: result.data.user.email } }
  })

export const signOut = createServerFn({ method: 'POST' }).handler(async (): Promise<PortalOutcome<null>> => {
  const domain = sameSiteDomain()
  if (!domain) return fail('FORBIDDEN')
  const session = readSessionToken()
  if (session) await portalApi<null>('/auth/sign-out', domain, { method: 'POST', session })
  clearSession()
  return { ok: true, data: null }
})

// ============================================================================
// Requests
// ============================================================================

async function signedInPost<T>(path: string, body: unknown): Promise<PortalOutcome<T>> {
  const domain = sameSiteDomain()
  if (!domain) return fail('FORBIDDEN')
  const session = readSessionToken()
  if (!session) return fail('SIGN_IN_REQUIRED')
  const result = await portalApi<T>(path, domain, { method: 'POST', session, body })
  return result.ok ? { ok: true, data: result.data } : failureOf(result)
}

export const submitRequest = createServerFn({ method: 'POST' })
  .validator(
    (input: { ticketTypeId: string; title: string; description?: string; fields?: Record<string, unknown> }) => input,
  )
  .handler(async ({ data }): Promise<PortalOutcome<{ id: string }>> => {
    const parsed = deskPortalCreateRequestSchema.safeParse(data)
    if (!parsed.success) return fail('INVALID', zodField(parsed.error))
    const result = await signedInPost<DeskPortalRequestDetail>('/requests', parsed.data)
    return result.ok ? { ok: true, data: { id: result.data.id } } : result
  })

export const replyToRequest = createServerFn({ method: 'POST' })
  .validator((input: { id: string; body: string }) => input)
  .handler(async ({ data }): Promise<PortalOutcome<DeskPortalMessage>> => {
    const id = typeof data.id === 'string' ? data.id.trim() : ''
    if (!id || id.length > 64) return fail('NOT_FOUND')
    const parsed = deskPortalReplySchema.safeParse({ body: data.body })
    if (!parsed.success) return fail('INVALID', 'body')
    return signedInPost<DeskPortalMessage>(`/requests/${encodeURIComponent(id)}/messages`, parsed.data)
  })
