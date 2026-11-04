/**
 * The portal's data: every export is a TanStack Start server function. It
 * runs in the Worker and calls flow-api's `/public/project-portal/*` there,
 * so neither flow-api's origin nor the session token reaches the browser.
 *
 * - Loader reads (`getAccount`, `getProjects`, `getProjectPage`) throw: a
 *   redirect to the sign-in page when there is no (longer a) session, a
 *   not-found for a project the contact cannot see, an error otherwise.
 * - Everything a click starts (sign-in, answering, messages, "load more")
 *   answers `{ ok: false, code }` instead of throwing, so the form can show
 *   the problem where it happened. Mutations also refuse cross-site callers.
 *
 * The workspace is always the one in the URL; the session token decides what
 * the contact sees, and flow-api checks their access on every call.
 */
import { notFound, redirect } from '@tanstack/react-router'
import { createServerFn } from '@tanstack/react-start'
import {
  decidePortalApprovalSchema,
  postPortalMessageSchema,
  requestPortalCodeSchema,
  verifyPortalCodeSchema,
  type PortalApproval,
  type PortalDecisionResult,
  type PortalDocument,
  type PortalFile,
  type PortalMe,
  type PortalMessage,
  type PortalProject,
  type PortalProjectSummary,
  type PortalReport,
} from '@weldsuite/app-api-client/schemas/project-portal'
import type { ProjectPortalApi } from '@weldsuite/app-api-client/domains/project-portal'
import type { ListResponse } from '@weldsuite/app-api-client/types'
import { isLocale, type Locale } from '@/lib/i18n'
import { parseWorkspaceSlug } from '@/lib/slug'
import { PortalApiError, portalApi } from '@/lib/server/flow-api'
import { clearSession, isSameSiteRequest, readSessionToken, storeSession } from '@/lib/server/session'

// ============================================================================
// Shapes
// ============================================================================

/** Why a click's call failed; the component maps it to a message. */
export type FailureCode =
  | 'invalid'
  | 'wrong_code'
  | 'rate_limited'
  | 'unavailable'
  | 'forbidden'
  | 'signed_out'
  | 'not_found'
  | 'conflict'
  | 'error'

export type Outcome<T> = { ok: true; data: T } | { ok: false; code: FailureCode }

export interface Page<T> {
  items: T[]
  hasMore: boolean
  /** Send it back to get the next page. */
  cursor: string | null
  totalCount: number
}

/** Everything the project page shows, loaded together. Lists are the first page. */
export interface ProjectPageData {
  project: PortalProject
  /** The reviews waiting for the contact on this project. */
  approvals: PortalApproval[]
  /** Newest first, as the API lists them. */
  messages: Page<PortalMessage>
  files: Page<PortalFile>
  documents: Page<PortalDocument>
}

export type { PortalApproval, PortalDecisionResult, PortalDocument, PortalFile, PortalMe }
export type { PortalMessage, PortalProject, PortalProjectSummary, PortalReport }

const MESSAGE_PAGE = 20
const LIST_PAGE = 25
const REPORT_PAGE = 5
/** flow-api's message for a contact whose portal access was switched off (PORTAL_MESSAGES.accessRevoked). */
const ACCESS_REVOKED = 'Access revoked'

const ok = <T>(data: T): Outcome<T> => ({ ok: true, data })
const fail = (code: FailureCode): Outcome<never> => ({ ok: false, code })

function toPage<T>(res: ListResponse<T>): Page<T> {
  return {
    items: res.data,
    hasMore: res.pagination.hasMore,
    cursor: res.pagination.cursor,
    totalCount: res.pagination.totalCount,
  }
}

function signInRedirect(slug: string, reason?: 'expired' | 'revoked') {
  return redirect({
    to: '/$workspace',
    params: { workspace: slug },
    search: reason ? { reason } : {},
    reloadDocument: true,
  })
}

/**
 * A signed-in read for a page. No session: to the sign-in page. A dead session
 * is cleared and sent there too; a project that is not the contact's is a 404.
 */
async function read<T>(workspace: string, run: (api: ProjectPortalApi) => Promise<T>): Promise<T> {
  const slug = parseWorkspaceSlug(workspace)
  if (!slug) throw notFound()
  const token = readSessionToken(slug)
  if (!token) throw signInRedirect(slug)
  try {
    return await run(portalApi(token))
  } catch (err) {
    if (err instanceof PortalApiError) {
      if (err.status === 401) {
        clearSession(slug)
        throw signInRedirect(slug, err.message === ACCESS_REVOKED ? 'revoked' : 'expired')
      }
      if (err.status === 404) throw notFound()
    }
    throw err
  }
}

/** flow-api's status as the code a component maps to a message. */
function failureOf(err: unknown, opts: { slug?: string; signIn?: boolean } = {}): Outcome<never> {
  if (!(err instanceof PortalApiError)) {
    console.error('[project-portal] unexpected failure:', err)
    return fail('error')
  }
  switch (err.status) {
    case 400:
      return fail('invalid')
    case 401:
      if (opts.signIn) return fail('wrong_code')
      if (opts.slug) clearSession(opts.slug)
      return fail('signed_out')
    case 403:
      return fail('forbidden')
    case 404:
      return fail('not_found')
    case 409:
      return fail('conflict')
    case 429:
      return fail('rate_limited')
    case 503:
      return fail('unavailable')
    default:
      return fail('error')
  }
}

/** A signed-in call that answers an outcome. `write` also requires a same-site caller. */
async function act<T>(
  workspace: string,
  write: boolean,
  run: (api: ProjectPortalApi) => Promise<T>,
): Promise<Outcome<T>> {
  const slug = parseWorkspaceSlug(workspace)
  if (!slug || (write && !isSameSiteRequest())) return fail('forbidden')
  const token = readSessionToken(slug)
  if (!token) return fail('signed_out')
  try {
    return ok(await run(portalApi(token)))
  } catch (err) {
    return failureOf(err, { slug })
  }
}

const workspaceInput = (input: { workspace: string }) => input
const projectInput = (input: { workspace: string; projectId: string }) => input
const pageInput = (input: { workspace: string; projectId: string; cursor?: string | null }) => input

/** An id from the URL or a click, bounded before it goes into a path. */
const isId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 100

// ============================================================================
// Pages
// ============================================================================

/** Whether this browser holds a session for the workspace. Cookie only: no call to flow-api. */
export const getSessionState = createServerFn({ method: 'GET' })
  .validator(workspaceInput)
  .handler(({ data }): { signedIn: boolean } => {
    const slug = parseWorkspaceSlug(data.workspace)
    return { signedIn: slug !== null && readSessionToken(slug) !== undefined }
  })

/**
 * Who is signed in, and the workspace's name, for the header. Null when signed
 * out. It also checks the session: a dead one is cleared, a live one is kept
 * alive for another 30 days. Any other failure reads as signed out here; the
 * page's own loader shows the error.
 */
export const getAccount = createServerFn({ method: 'GET' })
  .validator(workspaceInput)
  .handler(async ({ data }): Promise<PortalMe | null> => {
    const slug = parseWorkspaceSlug(data.workspace)
    if (!slug) return null
    const token = readSessionToken(slug)
    if (!token) return null
    try {
      const me = await portalApi(token).me()
      storeSession(slug, token)
      return me.data
    } catch (err) {
      if (err instanceof PortalApiError && err.status === 401) clearSession(slug)
      return null
    }
  })

export const getProjects = createServerFn({ method: 'GET' })
  .validator(workspaceInput)
  .handler(
    ({ data }): Promise<PortalProjectSummary[]> =>
      read(data.workspace, async (api) => (await api.listProjects()).data),
  )

export const getProjectPage = createServerFn({ method: 'GET' })
  .validator(projectInput)
  .handler(({ data }): Promise<ProjectPageData> => {
    if (!isId(data.projectId)) throw notFound()
    const id = data.projectId
    return read(data.workspace, async (api) => {
      const [project, approvals, messages, files, documents] = await Promise.all([
        api.getProject(id),
        api.listApprovals(),
        api.listMessages(id, { limit: MESSAGE_PAGE }),
        api.listFiles(id, { limit: LIST_PAGE }),
        api.listDocuments(id, { limit: LIST_PAGE }),
      ])
      return {
        project: project.data,
        approvals: approvals.data.filter((approval) => approval.projectId === id),
        messages: toPage(messages),
        files: toPage(files),
        documents: toPage(documents),
      }
    })
  })

// ============================================================================
// More of a list (a click)
// ============================================================================

/** The `limit` and `cursor` of a page query (no cursor: the first page). */
const pageQuery = (limit: number, cursor: string | null | undefined) => ({
  limit,
  ...(cursor ? { cursor } : {}),
})

/** A page of the thread, newest first; no cursor is the newest page. */
export const loadMessages = createServerFn({ method: 'GET' })
  .validator(pageInput)
  .handler(({ data }): Promise<Outcome<Page<PortalMessage>>> => {
    if (!isId(data.projectId)) return Promise.resolve(fail('not_found'))
    const { projectId } = data
    return act(data.workspace, false, async (api) =>
      toPage(await api.listMessages(projectId, pageQuery(MESSAGE_PAGE, data.cursor))),
    )
  })

/** A page of published reports, newest first. */
export const loadReports = createServerFn({ method: 'GET' })
  .validator(pageInput)
  .handler(({ data }): Promise<Outcome<Page<PortalReport>>> => {
    if (!isId(data.projectId)) return Promise.resolve(fail('not_found'))
    const { projectId } = data
    return act(data.workspace, false, async (api) =>
      toPage(await api.listReports(projectId, pageQuery(REPORT_PAGE, data.cursor))),
    )
  })

export const loadFiles = createServerFn({ method: 'GET' })
  .validator(pageInput)
  .handler(({ data }): Promise<Outcome<Page<PortalFile>>> => {
    if (!isId(data.projectId)) return Promise.resolve(fail('not_found'))
    const { projectId } = data
    return act(data.workspace, false, async (api) =>
      toPage(await api.listFiles(projectId, pageQuery(LIST_PAGE, data.cursor))),
    )
  })

export const loadDocuments = createServerFn({ method: 'GET' })
  .validator(pageInput)
  .handler(({ data }): Promise<Outcome<Page<PortalDocument>>> => {
    if (!isId(data.projectId)) return Promise.resolve(fail('not_found'))
    const { projectId } = data
    return act(data.workspace, false, async (api) =>
      toPage(await api.listDocuments(projectId, pageQuery(LIST_PAGE, data.cursor))),
    )
  })

// ============================================================================
// Sign-in and sign-out
// ============================================================================

/** Email a sign-in code, in the portal's language. flow-api always answers 204, whoever the address is. */
export const requestCode = createServerFn({ method: 'POST' })
  .validator((input: { workspace: string; email: string; locale: Locale }) => input)
  .handler(async ({ data }): Promise<Outcome<null>> => {
    const slug = parseWorkspaceSlug(data.workspace)
    if (!slug || !isSameSiteRequest()) return fail('forbidden')
    const parsed = requestPortalCodeSchema.safeParse({
      workspace: slug,
      email: data.email,
      ...(isLocale(data.locale) ? { locale: data.locale } : {}),
    })
    if (!parsed.success) return fail('invalid')
    try {
      await portalApi().requestCode(parsed.data)
      return ok(null)
    } catch (err) {
      return failureOf(err)
    }
  })

/** Check the code; on success the session token goes into the httpOnly cookie and never to the browser. */
export const verifyCode = createServerFn({ method: 'POST' })
  .validator((input: { workspace: string; email: string; code: string }) => input)
  .handler(async ({ data }): Promise<Outcome<{ name: string }>> => {
    const slug = parseWorkspaceSlug(data.workspace)
    if (!slug || !isSameSiteRequest()) return fail('forbidden')
    const parsed = verifyPortalCodeSchema.safeParse({ workspace: slug, email: data.email, code: data.code })
    if (!parsed.success) return fail('invalid')
    try {
      const signedIn = await portalApi().verifyCode(parsed.data)
      storeSession(slug, signedIn.data.token)
      return ok({ name: signedIn.data.contact.name })
    } catch (err) {
      return failureOf(err, { signIn: true })
    }
  })

export const signOut = createServerFn({ method: 'POST' })
  .validator(workspaceInput)
  .handler(async ({ data }): Promise<Outcome<null>> => {
    const slug = parseWorkspaceSlug(data.workspace)
    if (!slug || !isSameSiteRequest()) return fail('forbidden')
    const token = readSessionToken(slug)
    if (token) {
      try {
        await portalApi(token).signOut()
      } catch (err) {
        // The session may already be gone; the cookie is removed either way.
        console.error('[project-portal] sign-out failed:', err)
      }
    }
    clearSession(slug)
    return ok(null)
  })

// ============================================================================
// Answers and messages
// ============================================================================

export const decideApproval = createServerFn({ method: 'POST' })
  .validator(
    (input: {
      workspace: string
      approvalId: string
      decision: 'approved' | 'rejected' | 'info_requested'
      note?: string | null
    }) => input,
  )
  .handler(({ data }): Promise<Outcome<PortalDecisionResult>> => {
    const note = data.note?.trim()
    const parsed = decidePortalApprovalSchema.safeParse({ decision: data.decision, note: note ? note : null })
    if (!parsed.success || !isId(data.approvalId)) return Promise.resolve(fail('invalid'))
    const { approvalId } = data
    return act(data.workspace, true, async (api) => (await api.decideApproval(approvalId, parsed.data)).data)
  })

export const sendMessage = createServerFn({ method: 'POST' })
  .validator((input: { workspace: string; projectId: string; message: string }) => input)
  .handler(({ data }): Promise<Outcome<PortalMessage>> => {
    const parsed = postPortalMessageSchema.safeParse({ message: data.message })
    if (!parsed.success || !isId(data.projectId)) return Promise.resolve(fail('invalid'))
    const { projectId } = data
    return act(data.workspace, true, async (api) => (await api.postMessage(projectId, parsed.data)).data)
  })
