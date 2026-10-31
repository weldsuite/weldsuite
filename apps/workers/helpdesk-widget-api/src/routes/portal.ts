/**
 * The signed-in help center: /api/portal/*
 *
 * Called by the help center's server (apps/web/helpcenter), never by a
 * browser directly. Tenant from `?domain=` (helpcenterDomainMiddleware); the
 * reader's session, after sign-in, in `x-portal-session`. Only served while
 * the help center and its "sign-in and requests" switch are on.
 *
 *   GET  /config                      is sign-in on here?
 *   POST /auth/request                email a sign-in code
 *   POST /auth/verify                 code → session
 *   POST /auth/sign-out
 *   GET  /me
 *   GET  /request-types               the request form (customer ticket types)
 *   GET  /requests                    my requests
 *   POST /requests                    submit one
 *   GET  /requests/:id                one request, public thread only
 *   POST /requests/:id/messages       reply (reopens a resolved request)
 *
 * "My requests" are the reader's conversations on every channel, under the
 * same rule as the widget (canAccessDeskConversation): the email they proved
 * is the key, so a request started in the widget by an identified user shows
 * here too.
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import {
  appendDeskMessage,
  getDeskConversation,
  DeskConversationNotFoundError,
  type DeskConversation,
  type DeskMessage,
} from '@weldsuite/db/lib/desk';
import {
  canAccessDeskConversation,
  createDeskPortalRequest,
  deskPrincipalOf,
  deskTicketTypesById,
  findOrCreateVerifiedDeskVisitor,
  getDeskPortalRequestFields,
  listDeskConversationsForPrincipal,
  listDeskPortalRequestTypes,
  normalizeDeskEmail,
  toDeskPortalSummary,
  DeskPortalRequestRejectedError,
} from '@weldsuite/db/lib/desk-portal';
import {
  deskPortalAuthRequestSchema,
  deskPortalAuthVerifySchema,
  deskPortalCreateRequestSchema,
  deskPortalListRequestsQuerySchema,
  deskPortalReplySchema,
  type DeskPortalMessage,
  type DeskPortalRequestDetail,
} from '@weldsuite/app-api-client/schemas/desk-portal';
import type { Env, Variables } from '../index';
import { schema, type Database } from '../db';
import { error, success } from '../lib/response';
import { generateId } from '../lib/id';
import {
  autoAssignConversation,
  isPublicMessage,
  notifyTeamOfVisitorMessage,
  publishVisitorMessage,
  resolveAuthors,
  toPublicMessage,
  visitorDisplayName,
} from '../lib/desk-live';
import { helpcenterDomainMiddleware } from '../middleware/helpcenter-domain';
import {
  checkChallenge,
  createSession,
  endSession,
  hitLimit,
  issueChallenge,
  readSession,
  releaseLimit,
  REQUEST_LIMIT_EMAIL,
  REQUEST_LIMIT_WORKSPACE,
  VERIFY_LIMIT_EMAIL,
  VERIFY_LIMIT_WORKSPACE,
} from '../lib/portal-auth';
import { sendPortalCodeEmail } from '../lib/portal-mail';

type PortalContext = Context<{ Bindings: Env; Variables: Variables }>;

export const PORTAL_SESSION_HEADER = 'x-portal-session';

export const portalRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();
portalRoutes.use('*', helpcenterDomainMiddleware());

async function loadHelpcenter(db: Database) {
  const s = schema.helpcenterSettings;
  const [row] = await db
    .select({
      isEnabled: s.isEnabled,
      portalEnabled: s.portalEnabled,
      siteName: s.siteName,
      logo: s.logo,
      primaryColor: s.primaryColor,
    })
    .from(s)
    .where(isNull(s.deletedAt))
    .limit(1);
  return row ?? null;
}

function isPortalOn(row: Awaited<ReturnType<typeof loadHelpcenter>>): boolean {
  return row?.isEnabled === 1 && row.portalEnabled === 1;
}

function notEnabled(c: PortalContext) {
  return error.notFound(c, 'Sign-in on this help center');
}

/** The over-limit / counter-down answers for the sign-in routes. Fail closed when the counter is down. */
function limitRefusal(c: PortalContext, outcome: 'allowed' | 'limited' | 'unavailable') {
  if (outcome === 'limited') return error.tooManyRequests(c);
  if (outcome === 'unavailable') return error.unavailable(c, 'Sign-in is temporarily unavailable, try again shortly');
  return null;
}

portalRoutes.get('/config', async (c) => {
  try {
    return success(c, { enabled: isPortalOn(await loadHelpcenter(c.get('tenantDb'))) });
  } catch (err) {
    console.error('[widget-api/portal] config failed:', err);
    return error.internal(c, 'Failed to load the help center');
  }
});

const authRequestBody = deskPortalAuthRequestSchema.extend({ locale: z.string().max(10).optional() });

portalRoutes.post('/auth/request', zValidator('json', authRequestBody), async (c) => {
  const db = c.get('tenantDb');
  const workspaceId = c.get('workspaceId');
  const { email: rawEmail, locale } = c.req.valid('json');
  const email = normalizeDeskEmail(rawEmail);
  try {
    const helpcenter = await loadHelpcenter(db);
    if (!isPortalOn(helpcenter)) return notEnabled(c);

    // Per address first, so one bombarded inbox can't drain the workspace's
    // budget, then per workspace (mail cost). Not per IP: every reader arrives
    // through the help center's server.
    const perEmail = limitRefusal(c, await hitLimit(c.env, workspaceId, `request:e:${email}`, REQUEST_LIMIT_EMAIL));
    if (perEmail) return perEmail;
    const perWorkspace = limitRefusal(c, await hitLimit(c.env, workspaceId, 'request:ws', REQUEST_LIMIT_WORKSPACE));
    if (perWorkspace) return perWorkspace;

    const code = await issueChallenge(c.env, workspaceId, email);
    const sent = await sendPortalCodeEmail(c.env, { to: email, code, brand: helpcenter!, locale });
    if (!sent) {
      if (c.env.ENVIRONMENT === 'development') console.info(`[widget-api/portal] dev sign-in code for ${email}: ${code}`);
      else return error.unavailable(c, 'The sign-in email could not be sent, try again shortly');
    }
    return success(c, { ok: true });
  } catch (err) {
    console.error('[widget-api/portal] auth request failed:', err);
    return error.internal(c, 'Failed to send a sign-in code');
  }
});

portalRoutes.post('/auth/verify', zValidator('json', deskPortalAuthVerifySchema), async (c) => {
  const db = c.get('tenantDb');
  const workspaceId = c.get('workspaceId');
  const data = c.req.valid('json');
  const email = normalizeDeskEmail(data.email);
  try {
    if (!isPortalOn(await loadHelpcenter(db))) return notEnabled(c);

    // Take a slot before checking, give it back on success: only failures count.
    const emailKey = `verify:e:${email}`;
    const perEmail = limitRefusal(c, await hitLimit(c.env, workspaceId, emailKey, VERIFY_LIMIT_EMAIL));
    if (perEmail) return perEmail;
    const perWorkspace = limitRefusal(c, await hitLimit(c.env, workspaceId, 'verify:ws', VERIFY_LIMIT_WORKSPACE));
    if (perWorkspace) return perWorkspace;

    const check = await checkChallenge(c.env, workspaceId, email, data.code);
    if (check !== 'ok') {
      return c.json(
        {
          success: false,
          error:
            check === 'wrong'
              ? { code: 'INVALID_CODE', message: 'That code is not right' }
              : { code: 'CODE_EXPIRED', message: 'This code has expired, ask for a new one' },
        },
        400,
      );
    }
    await Promise.all([releaseLimit(c.env, workspaceId, emailKey), releaseLimit(c.env, workspaceId, 'verify:ws')]);

    const visitor = await findOrCreateVerifiedDeskVisitor(db, generateId, email);
    const { token, session } = await createSession(c.env, { workspaceId, visitorId: visitor.id, email });
    return success(c, {
      session: token,
      expiresAt: session.expiresAt,
      user: { email, name: visitor.name },
    });
  } catch (err) {
    console.error('[widget-api/portal] auth verify failed:', err);
    return error.internal(c, 'Failed to sign in');
  }
});

portalRoutes.post('/auth/sign-out', async (c) => {
  const token = c.req.header(PORTAL_SESSION_HEADER);
  if (token) await endSession(c.env, token);
  return c.body(null, 204);
});

// ── signed-in routes ───────────────────────────────────────────────────────

const signedIn = new Hono<{ Bindings: Env; Variables: Variables }>();

signedIn.use('*', async (c, next) => {
  const token = c.req.header(PORTAL_SESSION_HEADER);
  if (!token) return error.unauthorized(c, 'Sign in first', 'SIGN_IN_REQUIRED');
  const db = c.get('tenantDb');
  if (!isPortalOn(await loadHelpcenter(db))) return notEnabled(c);
  const session = await readSession(c.env, c.get('workspaceId'), token);
  if (!session) return error.unauthorized(c, 'Your session has ended, sign in again', 'SIGN_IN_REQUIRED');
  const [visitor] = await db
    .select()
    .from(schema.deskVisitors)
    .where(and(eq(schema.deskVisitors.id, session.visitorId)))
    .limit(1);
  // The visitor must still be verified for the address the session proved.
  if (!visitor?.verifiedEmail || normalizeDeskEmail(visitor.verifiedEmail) !== session.email) {
    return error.unauthorized(c, 'Your session has ended, sign in again', 'SIGN_IN_REQUIRED');
  }
  c.set('visitor', visitor);
  c.set('principal', deskPrincipalOf(visitor));
  await next();
});

signedIn.get('/me', (c) => {
  const visitor = c.get('visitor');
  return success(c, { email: visitor.verifiedEmail, name: visitor.name });
});

signedIn.get('/request-types', async (c) => {
  try {
    return success(c, await listDeskPortalRequestTypes(c.get('tenantDb')));
  } catch (err) {
    console.error('[widget-api/portal] request types failed:', err);
    return error.internal(c, 'Failed to load the request form');
  }
});

signedIn.get('/requests', zValidator('query', deskPortalListRequestsQuerySchema), async (c) => {
  const db = c.get('tenantDb');
  const query = c.req.valid('query');
  try {
    const page = await listDeskConversationsForPrincipal(db, c.get('principal'), {
      state: query.status,
      cursor: query.cursor,
      limit: query.limit ?? 20,
    });
    const types = await deskTicketTypesById(db, page.rows.map((r) => r.ticketTypeId));
    return success(c, {
      requests: page.rows.map((row) => toDeskPortalSummary(row, row.ticketTypeId ? types.get(row.ticketTypeId) : undefined)),
      hasMore: page.hasMore,
      cursor: page.cursor,
    });
  } catch (err) {
    console.error('[widget-api/portal] list requests failed:', err);
    return error.internal(c, 'Failed to load your requests');
  }
});

function toPortalMessage(message: ReturnType<typeof toPublicMessage>): DeskPortalMessage {
  return {
    id: message.id,
    kind: message.kind,
    body: message.body,
    authorType: message.authorType,
    authorName: message.authorName,
    authorAvatar: message.authorAvatar,
    attachments: message.attachments?.map((a) => ({ name: a.name, url: a.url, contentType: a.contentType, filesize: a.filesize })) ?? null,
    eventType: message.eventType,
    createdAt: message.createdAt,
  };
}

async function requestDetail(
  db: Database,
  conversation: DeskConversation,
  messages: DeskMessage[],
): Promise<DeskPortalRequestDetail> {
  const types = await deskTicketTypesById(db, [conversation.ticketTypeId]);
  const type = conversation.ticketTypeId ? types.get(conversation.ticketTypeId) : undefined;
  const visible = messages.filter(isPublicMessage);
  const authors = await resolveAuthors(db, visible.filter((m) => m.authorType === 'agent').map((m) => m.authorId));
  return {
    ...toDeskPortalSummary(conversation, type),
    fields: await getDeskPortalRequestFields(db, conversation, type),
    messages: visible.map((m) => toPortalMessage(toPublicMessage(m, authors))),
  };
}

/** Tell the team: realtime to the inbox, auto-assignment, then a notification. */
function announceVisitorMessage(
  c: PortalContext,
  conversation: DeskConversation,
  message: DeskMessage,
  opts: { isNew: boolean; teamAlreadyWaiting: boolean },
) {
  const db = c.get('tenantDb');
  const orgId = c.get('clerkOrgId');
  const visitor = c.get('visitor');
  c.executionCtx.waitUntil(
    visitorDisplayName(db, visitor.id, visitor).then((visitorName) =>
      Promise.all([
        publishVisitorMessage(c.env, orgId, conversation, message, visitorName, opts.isNew ? 'created' : 'updated'),
        autoAssignConversation(c.env, db, orgId, conversation).then((current) =>
          opts.teamAlreadyWaiting
            ? undefined
            : notifyTeamOfVisitorMessage({
                env: c.env,
                db,
                orgId,
                conversation: current,
                message,
                visitorName,
                isNewConversation: opts.isNew,
              }),
        ),
      ]),
    ),
  );
}

signedIn.post('/requests', zValidator('json', deskPortalCreateRequestSchema), async (c) => {
  const db = c.get('tenantDb');
  const data = c.req.valid('json');
  try {
    const { conversation, message } = await createDeskPortalRequest(db, {
      generateId,
      visitor: c.get('visitor'),
      ticketTypeId: data.ticketTypeId,
      title: data.title,
      description: data.description,
      fields: data.fields,
    });
    announceVisitorMessage(c, conversation, message, { isNew: true, teamAlreadyWaiting: false });
    return success(c, await requestDetail(db, conversation, [message]), 201);
  } catch (err) {
    if (err instanceof DeskPortalRequestRejectedError) {
      return error.badRequest(c, err.message, { field: err.field });
    }
    console.error('[widget-api/portal] create request failed:', err);
    return error.internal(c, 'Failed to submit the request');
  }
});

async function accessible(c: PortalContext, id: string, includeMessages: boolean) {
  const db = c.get('tenantDb');
  const result = await getDeskConversation(db, id, { includeMessages });
  if (!result) return null;
  return (await canAccessDeskConversation(db, result.conversation, c.get('principal'))) ? result : null;
}

signedIn.get('/requests/:id', async (c) => {
  const id = c.req.param('id');
  try {
    const result = await accessible(c, id, true);
    if (!result) return error.notFound(c, 'Request', id);
    return success(c, await requestDetail(c.get('tenantDb'), result.conversation, result.messages));
  } catch (err) {
    console.error('[widget-api/portal] get request failed:', err);
    return error.internal(c, 'Failed to load the request');
  }
});

signedIn.post('/requests/:id/messages', zValidator('json', deskPortalReplySchema), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const { body } = c.req.valid('json');
  try {
    const existing = await accessible(c, id, false);
    if (!existing) return error.notFound(c, 'Request', id);
    const { conversation, message } = await appendDeskMessage(db, {
      generateId,
      conversationId: id,
      kind: 'message',
      authorType: 'visitor',
      authorId: c.get('visitor').id,
      body,
    });
    const before = existing.conversation;
    announceVisitorMessage(c, conversation, message, {
      isNew: false,
      teamAlreadyWaiting: before.state === 'open' && before.waitingSince !== null,
    });
    return success(c, toPortalMessage(toPublicMessage(message, new Map())), 201);
  } catch (err) {
    if (err instanceof DeskConversationNotFoundError) return error.notFound(c, 'Request', id);
    console.error('[widget-api/portal] reply failed:', err);
    return error.internal(c, 'Failed to send the reply');
  }
});

portalRoutes.route('/', signedIn);
