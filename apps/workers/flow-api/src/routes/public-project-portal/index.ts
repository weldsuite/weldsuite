/**
 * /public/project-portal: the client portal API (sign-in with an email code, the
 * project view, approvals addressed to a contact; FLOW-020).
 *
 * Unlike every other flow-api router it is mounted outside `/api/*` in
 * ../../index.ts, so `apiAuth()` (Clerk) does not run: the workspace comes from
 * a slug (sign-in) or from the session (everything after), the caller from a
 * hashed session token in KV, like the commerce portal (COM-007). Rust mirrors
 * it in rust/modules/flow/src/public_project_portal.rs.
 *
 *   POST /auth/request-code      email a code; always 204
 *   POST /auth/verify            code -> session token
 *   POST /auth/sign-out          end the session
 *   GET  /me                     the contact and the workspace
 *   GET  /projects               the contact's projects
 *   GET  /projects/:id           progress, milestones, next milestone, latest report
 *   GET  /projects/:id/reports   published, client visible reports
 *   GET  /projects/:id/files     client visible files           (+ /:fileId/download)
 *   GET  /projects/:id/documents client visible documents       (+ /:documentId/download)
 *   GET  /projects/:id/messages  the client visible thread
 *   POST /projects/:id/messages  write to the project team
 *   GET  /approvals              reviews waiting for the contact
 *   POST /approvals/:id/decide   answer one
 *
 * The checks run in a fixed order so every backend answers alike: the session
 * (401), then the object (404, also for one the contact may not see), then the
 * body (400), then the rules. Every shape is an allowlist (flow-domain
 * `project-portal`); costs, rates, RAID items, internal notes and members'
 * emails are never in it.
 */

import { Hono } from 'hono';
import type { z } from 'zod';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import {
  decidePortalApprovalSchema,
  postPortalMessageSchema,
  requestPortalCodeSchema,
  verifyPortalCodeSchema,
  type PortalDecisionResult,
  type PortalSignIn,
} from '@weldsuite/app-api-client/schemas/project-portal';
import {
  consumeRateLimit,
  kvDelete,
  kvGetJson,
  kvPutJson,
  randomOtp,
  randomToken,
  releaseRateLimit,
} from '@weldsuite/commerce-domain/portal-tokens';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { decideApproval, type DecideApprovalError, type DecideApprovalResult } from '@weldsuite/flow-domain/approvals';
import {
  PORTAL_CODE_TTL_SECONDS,
  PORTAL_MAX_VERIFY_ATTEMPTS,
  PORTAL_MESSAGES,
  PORTAL_REQUEST_LIMIT_EMAIL,
  PORTAL_REQUEST_LIMIT_WORKSPACE,
  PORTAL_REQUEST_WINDOW_SECONDS,
  PORTAL_VERIFY_LIMIT_EMAIL,
  PORTAL_VERIFY_LIMIT_WORKSPACE,
  attachmentDisposition,
  isPortalApprovalSubject,
  normalizePortalEmail,
  portalCodeHash,
  portalCodeKey,
  portalMessageMetadata,
  sessionExpiresAt,
  type PortalChallenge,
  type PortalSessionRecord,
} from '@weldsuite/flow-domain/project-portal';
import { generateId } from '@weldsuite/worker-kit/id';
import { schema } from '@weldsuite/worker-kit/db';
import { cursorPagination, error, list, noContent, success } from '@weldsuite/worker-kit/response';
import { getStoredObject, isWorkspaceObjectKey } from '@weldsuite/worker-kit/storage';
import { endSession, openWorkspaceBySlug, portalSession, storeSession, type PortalContext, type PortalVariables } from '../../lib/portal-session';
import { parseLimit } from '../../lib/query-params';
import {
  contactsOfSession,
  contactsWithAccess,
  findPortalDocument,
  findPortalFile,
  getPortalProject,
  listPortalDocuments,
  listPortalFiles,
  listPortalMessages,
  listPortalProjects,
  listPortalReports,
  pendingReviews,
  portalProjectRows,
  presentReviews,
  presentSentMessage,
  type Page,
  type PortalProjectRow,
} from '../../services/project-portal';
import { sendPortalCodeEmail } from '../../services/project-portal-mail';
import type { Env } from '../../types';

const app = new Hono<{ Bindings: Env; Variables: PortalVariables }>();

const approvals = schema.flowApprovals;
const projectMessages = schema.projectMessages;

// ── Request helpers ─────────────────────────────────────────────────────────

type Parsed<T> = { ok: true; data: T } | { ok: false; response: Response };

/** The JSON body parsed with a Zod schema: a 400 with the issues otherwise. */
async function parseBody<S extends z.ZodTypeAny>(c: PortalContext, bodySchema: S): Promise<Parsed<z.infer<S>>> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return { ok: false, response: error.badRequest(c, 'Invalid JSON body') };
  }
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    const details = parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }));
    return { ok: false, response: error.badRequest(c, 'Invalid request body', details) };
  }
  return { ok: true, data: parsed.data };
}

/** `limit` and `cursor` of a paged list. */
function pageOptions(c: PortalContext): { limit: number; cursor?: string } {
  const cursor = c.req.query('cursor');
  return { limit: parseLimit(c.req.query('limit'), 25, 100), ...(cursor ? { cursor } : {}) };
}

function listOf<T>(c: PortalContext, result: Page<T>) {
  return list(c, result.items, cursorPagination(result.totalCount, result.hasMore, result.cursor));
}

/** The projects the session's contacts may see (read on every call), and the contact ids. */
async function accessOf(c: PortalContext) {
  const session = c.get('portalSession');
  const rows = await portalProjectRows(c.get('tenantDb'), session.contactIds);
  return { session, rows, byId: new Map(rows.map((row) => [row.id, row])) };
}

/** One of the contact's projects, or a 404 (the same for a project that does not exist and one they may not see). */
async function ownProject(c: PortalContext): Promise<{ row: PortalProjectRow } | { response: Response }> {
  const id = c.req.param('id') ?? '';
  const { byId } = await accessOf(c);
  const row = byId.get(id);
  return row ? { row } : { response: error.notFound(c, 'Project', id) };
}

// ── Sign-in ─────────────────────────────────────────────────────────────────

/**
 * The counters behind the rate limits could not be reached. Both sign-in
 * endpoints refuse rather than run without a limit (fail closed): /auth/verify
 * because an unlimited code check is a brute-force oracle, /auth/request-code
 * because an unlimited one is an email-bombing and mail-cost lever. The answer
 * is the same for every address and workspace, so it reveals nothing about who
 * has access.
 */
function signInUnavailable(c: PortalContext) {
  return error.unavailable(c, PORTAL_MESSAGES.signInUnavailable);
}

app.post('/auth/request-code', async (c) => {
  const body = await parseBody(c, requestPortalCodeSchema);
  if (!body.ok) return body.response;
  const email = normalizePortalEmail(body.data.email);

  try {
    const workspace = await openWorkspaceBySlug(c, body.data.workspace);
    // An unknown workspace looks exactly like an address with no access.
    if (!workspace) return noContent(c);

    // Per address first, so one bombarded address cannot drain the workspace's
    // budget, then per workspace across all addresses (mail cost, spraying).
    // Over a limit looks exactly like "no access": the same 204.
    const perEmail = await consumeRateLimit(
      c.env,
      workspace.workspaceId,
      `e:${email}`,
      PORTAL_REQUEST_LIMIT_EMAIL,
      PORTAL_REQUEST_WINDOW_SECONDS,
    );
    if (perEmail === 'unavailable') return signInUnavailable(c);
    if (perEmail === 'limited') return noContent(c);
    const perWorkspace = await consumeRateLimit(
      c.env,
      workspace.workspaceId,
      'request-ws',
      PORTAL_REQUEST_LIMIT_WORKSPACE,
      PORTAL_REQUEST_WINDOW_SECONDS,
    );
    if (perWorkspace === 'unavailable') return signInUnavailable(c);
    if (perWorkspace === 'limited') return noContent(c);

    const contacts = await contactsWithAccess(workspace.db, email);
    if (contacts.length === 0) return noContent(c);

    const code = randomOtp();
    const challenge: PortalChallenge = {
      codeHash: await portalCodeHash(workspace.workspaceId, email, code),
      email,
      workspaceId: workspace.workspaceId,
      contactIds: contacts.map((contact) => contact.id),
      attempts: 0,
    };
    await kvPutJson(c.env, portalCodeKey(workspace.workspaceId, email), challenge, PORTAL_CODE_TTL_SECONDS);
    await sendPortalCodeEmail(c.env, {
      to: email,
      code,
      workspaceName: workspace.name,
      locale: body.data.locale ?? 'en',
    });
    return noContent(c);
  } catch (err) {
    console.error('[flow-api/public-project-portal] request-code failed:', err);
    return noContent(c);
  }
});

/**
 * The verify budgets, counting failed attempts only: per address, then per
 * workspace across all addresses. Each is reserved atomically up front, so
 * parallel guesses cannot all slip past a check-then-count; the caller gives
 * them back once the sign-in succeeds, so a successful sign-in uses up nothing.
 * Returns the refusal to send (holding no slot), or the reservation.
 */
async function reserveVerifyBudget(
  c: PortalContext,
  workspaceId: string,
  email: string,
): Promise<Response | { release: () => Promise<void> }> {
  const budgets = [
    { key: `verify-e:${email}`, max: PORTAL_VERIFY_LIMIT_EMAIL },
    { key: 'verify-ws', max: PORTAL_VERIFY_LIMIT_WORKSPACE },
  ];
  const reserved: string[] = [];
  const release = async () => {
    await Promise.all(reserved.map((key) => releaseRateLimit(c.env, workspaceId, key)));
  };
  for (const { key, max } of budgets) {
    const outcome = await consumeRateLimit(c.env, workspaceId, key, max, PORTAL_REQUEST_WINDOW_SECONDS);
    if (outcome === 'allowed') {
      reserved.push(key);
      continue;
    }
    await release();
    if (outcome === 'unavailable') return signInUnavailable(c);
    return c.json({ error: { code: 'RATE_LIMITED', message: PORTAL_MESSAGES.tooManyAttempts } }, 429);
  }
  return { release };
}

app.post('/auth/verify', async (c) => {
  const body = await parseBody(c, verifyPortalCodeSchema);
  if (!body.ok) return body.response;
  const email = normalizePortalEmail(body.data.email);
  const failed = () => error.unauthorized(c, PORTAL_MESSAGES.invalidCode);

  try {
    const workspace = await openWorkspaceBySlug(c, body.data.workspace);
    if (!workspace) return failed();

    const reservation = await reserveVerifyBudget(c, workspace.workspaceId, email);
    if (reservation instanceof Response) return reservation;

    const key = portalCodeKey(workspace.workspaceId, email);
    const challenge = await kvGetJson<PortalChallenge>(c.env, key);
    if (!challenge) return failed();
    if (challenge.attempts >= PORTAL_MAX_VERIFY_ATTEMPTS) {
      await kvDelete(c.env, key);
      return failed();
    }

    // `attempts` is a KV read-modify-write, so guesses sent in parallel all read
    // the same value and all get checked. This per-challenge counter is atomic
    // and is what really caps the guesses at PORTAL_MAX_VERIFY_ATTEMPTS.
    const budget = await consumeRateLimit(
      c.env,
      workspace.workspaceId,
      `verify-ch:${challenge.codeHash}`,
      PORTAL_MAX_VERIFY_ATTEMPTS,
      PORTAL_CODE_TTL_SECONDS,
    );
    if (budget === 'unavailable') {
      await reservation.release();
      return signInUnavailable(c);
    }
    if (budget === 'limited') {
      await kvDelete(c.env, key);
      return failed();
    }

    if ((await portalCodeHash(workspace.workspaceId, email, body.data.code)) !== challenge.codeHash) {
      const attempts = challenge.attempts + 1;
      if (attempts >= PORTAL_MAX_VERIFY_ATTEMPTS) await kvDelete(c.env, key);
      else await kvPutJson(c.env, key, { ...challenge, attempts }, PORTAL_CODE_TTL_SECONDS);
      return failed();
    }

    // The code was right: it is spent, and this attempt is not a failure.
    await kvDelete(c.env, key);
    await reservation.release();

    // Access is read again: it may have been switched off since the code was sent.
    const contacts = await contactsWithAccess(workspace.db, email);
    if (contacts.length === 0) return failed();

    const now = new Date().toISOString();
    const record: PortalSessionRecord = {
      workspaceId: workspace.workspaceId,
      clerkOrgId: workspace.clerkOrgId,
      workspaceSlug: workspace.slug,
      workspaceName: workspace.name,
      email,
      contactIds: contacts.map((contact) => contact.id),
      createdAt: now,
      lastSeenAt: now,
    };
    const token = randomToken();
    await storeSession(c.env, token, record);
    const first = contacts[0]!;
    const result: PortalSignIn = {
      token,
      expiresAt: sessionExpiresAt(now),
      contact: { id: first.id, name: first.name, email },
      workspace: { slug: workspace.slug, name: workspace.name },
    };
    return success(c, result);
  } catch (err) {
    console.error('[flow-api/public-project-portal] verify failed:', err);
    return error.internal(c, 'Failed to verify sign-in');
  }
});

app.post('/auth/sign-out', async (c) => {
  const header = c.req.header('Authorization');
  const token = header?.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : '';
  if (token) {
    try {
      await endSession(c.env, token);
    } catch (err) {
      console.error('[flow-api/public-project-portal] sign-out failed:', err);
    }
  }
  return noContent(c);
});

// ── Everything after sign-in needs the session ──────────────────────────────

app.use('/me', portalSession);
app.use('/projects', portalSession);
app.use('/projects/*', portalSession);
app.use('/approvals', portalSession);
app.use('/approvals/*', portalSession);

app.get('/me', async (c) => {
  const session = c.get('portalSession');
  try {
    const [contact] = await contactsOfSession(c.get('tenantDb'), session.contactIds);
    return success(c, {
      contact: { id: contact?.id ?? session.contactIds[0] ?? '', name: contact?.name ?? session.email, email: session.email },
      workspace: { slug: session.workspaceSlug, name: session.workspaceName },
    });
  } catch (err) {
    console.error('[flow-api/public-project-portal] me failed:', err);
    return error.internal(c, 'Failed to load the account');
  }
});

// ── Projects ────────────────────────────────────────────────────────────────

app.get('/projects', async (c) => {
  try {
    const { session, rows } = await accessOf(c);
    const projects = await listPortalProjects(c.get('tenantDb'), rows, session.contactIds);
    return list(c, projects, cursorPagination(projects.length, false, null));
  } catch (err) {
    console.error('[flow-api/public-project-portal] projects failed:', err);
    return error.internal(c, 'Failed to list projects');
  }
});

app.get('/projects/:id', async (c) => {
  try {
    const found = await ownProject(c);
    if ('response' in found) return found.response;
    return success(c, await getPortalProject(c.get('tenantDb'), found.row, c.get('portalSession').contactIds));
  } catch (err) {
    console.error('[flow-api/public-project-portal] project failed:', err);
    return error.internal(c, 'Failed to load the project');
  }
});

app.get('/projects/:id/reports', async (c) => {
  try {
    const found = await ownProject(c);
    if ('response' in found) return found.response;
    return listOf(c, await listPortalReports(c.get('tenantDb'), found.row.id, pageOptions(c)));
  } catch (err) {
    console.error('[flow-api/public-project-portal] reports failed:', err);
    return error.internal(c, 'Failed to list reports');
  }
});

app.get('/projects/:id/files', async (c) => {
  try {
    const found = await ownProject(c);
    if ('response' in found) return found.response;
    return listOf(c, await listPortalFiles(c.get('tenantDb'), found.row.id, pageOptions(c)));
  } catch (err) {
    console.error('[flow-api/public-project-portal] files failed:', err);
    return error.internal(c, 'Failed to list files');
  }
});

/**
 * The bytes of a stored object as a download. The key is a client-supplied
 * column of the row, so it must be one of this workspace's own (TASK-620); it is
 * always an attachment, never rendered by the browser.
 */
async function download(
  c: PortalContext,
  row: { id: string; fileName: string; mimeType: string; fileKey: string | null; storagePath: string },
  notFound: Response,
): Promise<Response> {
  if (!c.env.STORAGE && !c.env.PRIVATE_STORAGE) return error.internal(c, 'Storage is not configured');
  const key = row.fileKey || row.storagePath;
  const session = c.get('portalSession');
  if (!key || !isWorkspaceObjectKey(key, session.clerkOrgId, session.workspaceId)) return notFound;
  const object = await getStoredObject(c.env, key);
  if (!object) return notFound;
  return new Response(object.body, {
    headers: {
      'Content-Type': row.mimeType || object.httpMetadata?.contentType || 'application/octet-stream',
      'Content-Length': String(object.size),
      'Content-Disposition': attachmentDisposition(row.fileName, row.id),
      'Cache-Control': 'private, no-cache',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

app.get('/projects/:id/files/:fileId/download', async (c) => {
  try {
    const found = await ownProject(c);
    if ('response' in found) return found.response;
    const fileId = c.req.param('fileId') ?? '';
    const row = await findPortalFile(c.get('tenantDb'), found.row.id, fileId);
    if (!row) return error.notFound(c, 'File', fileId);
    return await download(c, row, error.notFound(c, 'File content', fileId));
  } catch (err) {
    console.error('[flow-api/public-project-portal] file download failed:', err);
    return error.internal(c, 'Failed to read the file');
  }
});

app.get('/projects/:id/documents', async (c) => {
  try {
    const found = await ownProject(c);
    if ('response' in found) return found.response;
    return listOf(c, await listPortalDocuments(c.get('tenantDb'), found.row.id, pageOptions(c)));
  } catch (err) {
    console.error('[flow-api/public-project-portal] documents failed:', err);
    return error.internal(c, 'Failed to list documents');
  }
});

app.get('/projects/:id/documents/:documentId/download', async (c) => {
  try {
    const found = await ownProject(c);
    if ('response' in found) return found.response;
    const documentId = c.req.param('documentId') ?? '';
    const row = await findPortalDocument(c.get('tenantDb'), found.row.id, documentId);
    if (!row) return error.notFound(c, 'Document', documentId);
    return await download(c, row, error.notFound(c, 'Document content', documentId));
  } catch (err) {
    console.error('[flow-api/public-project-portal] document download failed:', err);
    return error.internal(c, 'Failed to read the document');
  }
});

app.get('/projects/:id/messages', async (c) => {
  try {
    const found = await ownProject(c);
    if ('response' in found) return found.response;
    return listOf(
      c,
      await listPortalMessages(c.get('tenantDb'), found.row.id, c.get('portalSession').contactIds, pageOptions(c)),
    );
  } catch (err) {
    console.error('[flow-api/public-project-portal] messages failed:', err);
    return error.internal(c, 'Failed to list messages');
  }
});

app.post('/projects/:id/messages', async (c) => {
  const found = await ownProject(c);
  if ('response' in found) return found.response;
  const body = await parseBody(c, postPortalMessageSchema);
  if (!body.ok) return body.response;

  const db = c.get('tenantDb');
  const { row } = found;
  try {
    const [contact] = await contactsOfSession(db, [row.contactId]);
    const id = generateId('pmsg');
    const now = new Date();
    const metadata = portalMessageMetadata(row.contactId, contact?.name ?? c.get('portalSession').email);
    // The thread is the project's chat (conversationId = projectId); a client's
    // message is client visible by definition and names its sender in `metadata`.
    await db.insert(projectMessages).values({
      id,
      projectId: row.id,
      conversationId: row.id,
      senderId: row.contactId,
      message: body.data.message,
      messageType: 'text',
      metadata: { ...metadata },
      clientVisible: true,
      isRead: false,
      createdAt: now,
      updatedAt: now,
    });
    c.set('userId', row.contactId);
    publishEntityEvent({
      c,
      entityType: 'project_message',
      entityId: id,
      action: 'created',
      data: { id, projectId: row.id, senderId: row.contactId },
    });
    return success(
      c,
      presentSentMessage(
        { id, projectId: row.id, senderId: row.contactId, message: body.data.message, metadata: { ...metadata }, createdAt: now },
        c.get('portalSession').contactIds,
      ),
      201,
    );
  } catch (err) {
    console.error('[flow-api/public-project-portal] post message failed:', err);
    return error.internal(c, 'Failed to send the message');
  }
});

// ── Approvals ───────────────────────────────────────────────────────────────

app.get('/approvals', async (c) => {
  try {
    const { session, byId } = await accessOf(c);
    const db = c.get('tenantDb');
    const reviews = await pendingReviews(db, session.contactIds, new Set(byId.keys()));
    const items = await presentReviews(db, reviews, byId);
    return list(c, items, cursorPagination(items.length, false, null));
  } catch (err) {
    console.error('[flow-api/public-project-portal] approvals failed:', err);
    return error.internal(c, 'Failed to list approvals');
  }
});

/** How the approvals core refuses an answer, as a response. */
function refusal(c: PortalContext, code: DecideApprovalError, message: string, id: string): Response {
  switch (code) {
    case 'not_found':
      return error.notFound(c, 'Approval', id);
    case 'not_approver':
      return error.forbidden(c, message);
    case 'already_decided':
    case 'step_not_active':
      return error.conflict(c, message);
    case 'invalid_decision':
    case 'note_required':
      return error.badRequest(c, message);
  }
}

/**
 * The events of an answer: the review's own, and, when it settled its subject,
 * the subject's (the same ones the app publishes when a member answers).
 */
function publishDecision(
  c: PortalContext,
  row: typeof approvals.$inferSelect,
  result: Extract<DecideApprovalResult, { ok: true }>,
): void {
  const answered = result.approval;
  publishEntityEvent({
    c,
    entityType: 'flow_approval',
    entityId: answered.id,
    action: 'decided',
    data: {
      id: answered.id,
      projectId: answered.projectId,
      subjectType: answered.subjectType,
      subjectId: answered.subjectId,
      approverKind: answered.approverKind,
      approverId: answered.approverId,
      decision: answered.decision,
      note: answered.note,
      outcome: result.outcome,
      resolved: result.resolved,
    },
  });
  if (!result.resolved || result.outcome === 'pending') return;
  const subject = { id: row.subjectId, projectId: row.projectId };
  if (row.subjectType === 'change_request') {
    publishEntityEvent({
      c,
      entityType: 'project_change_request',
      entityId: row.subjectId,
      action: result.outcome === 'approved' ? 'approved' : 'rejected',
      data: subject,
    });
  } else if (row.subjectType === 'deliverable') {
    publishEntityEvent({
      c,
      entityType: 'project_deliverable',
      entityId: row.subjectId,
      action: result.outcome === 'approved' ? 'accepted' : 'updated',
      data: subject,
    });
  }
}

app.post('/approvals/:id/decide', async (c) => {
  const id = c.req.param('id') ?? '';
  const db = c.get('tenantDb');
  const { session, byId } = await accessOf(c);
  try {
    // Only a review addressed to one of the session's contacts, on a project they may see.
    const [row] = await db
      .select()
      .from(approvals)
      .where(
        and(
          eq(approvals.id, id),
          eq(approvals.approverKind, 'contact'),
          inArray(approvals.approverId, [...session.contactIds]),
          isNull(approvals.deletedAt),
        ),
      )
      .limit(1);
    if (!row || !row.projectId || !byId.has(row.projectId) || !isPortalApprovalSubject(row.subjectType)) {
      return error.notFound(c, 'Approval', id);
    }

    const body = await parseBody(c, decidePortalApprovalSchema);
    if (!body.ok) return body.response;

    c.set('userId', row.approverId);
    const result = await decideApproval(db, {
      approvalId: id,
      actor: { kind: 'contact', id: row.approverId },
      decision: body.data.decision,
      note: body.data.note ?? null,
    });
    if (!result.ok) return refusal(c, result.code, result.message, id);

    publishDecision(c, row, result);
    const decided: PortalDecisionResult = {
      id: result.approval.id,
      decision: result.approval.decision,
      note: result.approval.note,
      decidedAt: result.approval.decidedAt ? result.approval.decidedAt.toISOString() : null,
      outcome: result.outcome,
      resolved: result.resolved,
    };
    return success(c, decided);
  } catch (err) {
    console.error('[flow-api/public-project-portal] decide failed:', err);
    return error.internal(c, 'Failed to record the answer');
  }
});

export const publicProjectPortalRoutes = app;
