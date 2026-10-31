/**
 * Visitor-facing conversation + message routes.
 *
 * The visitor comes from their visitor token (visitorAuthMiddleware), never
 * from the request. Every route that touches a conversation checks that it
 * belongs to them: their own, or, for a verified visitor, any of that email's
 * (canAccessDeskConversation). Visitors never see internal notes, and message
 * payloads carry the teammate's display name/avatar so the widget never has
 * to guess.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import {
  appendDeskMessage,
  attachDeskVisitorContact,
  createDeskConversation,
  getDeskConversation,
  rateDeskConversation,
  upsertDeskVisitor,
  DESK_RATING_MAX,
  DESK_RATING_MIN,
  DeskConversationNotFoundError,
  DeskRatingRejectedError,
  type DeskVisitor,
} from '@weldsuite/db/lib/desk';
import { canAccessDeskConversation, listDeskConversationsForPrincipal } from '@weldsuite/db/lib/desk-portal';
import type { DeskMessageAttachment } from '@weldsuite/db/schema/desk-messages';
import { MAX_MESSAGE_ATTACHMENTS, resolveVisitorAttachments } from '../lib/attachments';
import type { Database } from '../db';
import type { Env, Variables } from '../index';
import { error, success } from '../lib/response';
import { generateId } from '../lib/id';
import {
  autoAssignConversation,
  isPublicMessage,
  notifyTeamOfVisitorMessage,
  publishConversationUpdated,
  publishVisitorEvent,
  publishVisitorMessage,
  resolveAuthors,
  toPublicConversation,
  toPublicMessage,
  visitorDisplayName,
} from '../lib/desk-live';

export const conversationsRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

const identifySchema = z.object({
  name: z.string().trim().max(255).optional(),
  email: z.string().trim().email().max(255).optional(),
});

const clientIdSchema = z.string().max(64).optional();

const startSchema = z.object({
  name: z.string().trim().max(255).optional(),
  email: z.string().trim().email().max(255).optional(),
  body: z.string().trim().min(1).max(10_000),
  clientId: clientIdSchema,
});

const attachmentSchema = z.object({
  name: z.string().trim().min(1).max(255),
  url: z.string().max(2048),
  contentType: z.string().max(255),
  filesize: z.number().int().nonnegative(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
});

const sendSchema = z
  .object({
    body: z.string().trim().max(10_000).optional(),
    attachments: z.array(attachmentSchema).max(MAX_MESSAGE_ATTACHMENTS).optional(),
    clientId: clientIdSchema,
  })
  .refine((data) => Boolean(data.body) || (data.attachments?.length ?? 0) > 0, {
    message: 'A message needs text or at least one attachment',
    path: ['body'],
  });

const rateSchema = z.object({
  rating: z.number().int().min(DESK_RATING_MIN).max(DESK_RATING_MAX),
  comment: z.string().trim().max(2000).optional(),
});

/**
 * Store the name / email a visitor typed. A verified visitor's email is the
 * one that was proven, so a typed one never replaces it.
 */
function saveTypedContact(
  db: Database,
  visitor: DeskVisitor,
  typed: { name?: string; email?: string },
): Promise<DeskVisitor> {
  return upsertDeskVisitor(db, {
    id: visitor.id,
    name: typed.name || undefined,
    email: visitor.verifiedEmail ? undefined : typed.email?.toLowerCase() || undefined,
  });
}

/** A conversation the calling visitor may see (with its messages when asked), or null. */
async function accessibleConversation(
  db: Database,
  principal: Variables['principal'],
  id: string,
  includeMessages = false,
) {
  const result = await getDeskConversation(db, id, { includeMessages });
  if (!result) return null;
  return (await canAccessDeskConversation(db, result.conversation, principal)) ? result : null;
}

/** Register / update the visitor and attach their contact details to their conversations. */
conversationsRoutes.post('/identify', zValidator('json', identifySchema), async (c) => {
  const db = c.get('tenantDb');
  const orgId = c.get('clerkOrgId');
  const data = c.req.valid('json');
  try {
    const visitor = await saveTypedContact(db, c.get('visitor'), data);
    const updated = await attachDeskVisitorContact(db, visitor.id, {
      name: data.name,
      email: visitor.verifiedEmail ?? data.email,
    });
    c.executionCtx.waitUntil(
      Promise.all(updated.map((conversation) => publishConversationUpdated(c.env, orgId, conversation))),
    );
    return success(c, {
      visitor: {
        id: visitor.id,
        name: visitor.name,
        email: visitor.verifiedEmail ?? visitor.email,
        verified: Boolean(visitor.verifiedEmail),
      },
    });
  } catch (err) {
    console.error('[widget-api] identify failed:', err);
    return error.internal(c, 'Failed to identify visitor');
  }
});

/** The visitor's conversation history (messenger "Messages" tab). */
conversationsRoutes.get('/', async (c) => {
  const db = c.get('tenantDb');
  try {
    const { rows } = await listDeskConversationsForPrincipal(db, c.get('principal'), { limit: 25 });
    const authors = await resolveAuthors(db, rows.map((r) => r.assigneeId));
    return success(c, rows.map((row) => toPublicConversation(row, authors)));
  } catch (err) {
    console.error('[widget-api] list conversations failed:', err);
    return error.internal(c, 'Failed to list conversations');
  }
});

/** Start a new conversation with the visitor's first message. */
conversationsRoutes.post('/', zValidator('json', startSchema), async (c) => {
  const db = c.get('tenantDb');
  const orgId = c.get('clerkOrgId');
  const data = c.req.valid('json');
  try {
    const visitor = await saveTypedContact(db, c.get('visitor'), data);

    const { conversation, message } = await createDeskConversation(db, {
      generateId,
      visitorId: visitor.id,
      name: visitor.name,
      email: visitor.verifiedEmail ?? visitor.email,
      body: data.body,
      authorType: 'visitor',
      authorId: visitor.id,
      metadata: data.clientId ? { clientId: data.clientId } : undefined,
    });

    const visitorName = await visitorDisplayName(db, visitor.id, visitor);
    c.executionCtx.waitUntil(
      Promise.all([
        publishVisitorMessage(c.env, orgId, conversation, message, visitorName, 'created'),
        // Assign first, so the notification goes to the new owner, not the whole team.
        autoAssignConversation(c.env, db, orgId, conversation).then((current) =>
          notifyTeamOfVisitorMessage({
            env: c.env,
            db,
            orgId,
            conversation: current,
            message,
            visitorName,
            isNewConversation: true,
          }),
        ),
      ]),
    );

    const authors = new Map();
    return success(
      c,
      {
        conversation: toPublicConversation(conversation, authors),
        messages: [toPublicMessage(message, authors)],
        message: toPublicMessage(message, authors),
      },
      201,
    );
  } catch (err) {
    console.error('[widget-api] start conversation failed:', err);
    return error.internal(c, 'Failed to start conversation');
  }
});

conversationsRoutes.get('/:id', async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const result = await accessibleConversation(db, c.get('principal'), id, true);
    if (!result) return error.notFound(c, 'Conversation', id);
    const visible = result.messages.filter(isPublicMessage);
    const authors = await resolveAuthors(db, [
      result.conversation.assigneeId,
      ...visible.filter((m) => m.authorType === 'agent').map((m) => m.authorId),
    ]);
    return success(c, {
      conversation: toPublicConversation(result.conversation, authors),
      messages: visible.map((m) => toPublicMessage(m, authors)),
    });
  } catch (err) {
    console.error('[widget-api] get conversation failed:', err);
    return error.internal(c, 'Failed to fetch conversation');
  }
});

conversationsRoutes.post('/:id/messages', zValidator('json', sendSchema), async (c) => {
  const db = c.get('tenantDb');
  const orgId = c.get('clerkOrgId');
  const id = c.req.param('id');
  const data = c.req.valid('json');
  const visitorId = c.get('visitor').id;
  try {
    const existing = await accessibleConversation(db, c.get('principal'), id);
    if (!existing) return error.notFound(c, 'Conversation', id);

    // Files must be ones this worker stored for this very conversation.
    let attachments: DeskMessageAttachment[] | undefined;
    if (data.attachments?.length) {
      const resolved = await resolveVisitorAttachments(c.env, orgId, id, data.attachments);
      if (!resolved.ok) return error.badRequest(c, resolved.message);
      attachments = resolved.attachments;
    }

    const { conversation, message } = await appendDeskMessage(db, {
      generateId,
      conversationId: id,
      kind: 'message',
      authorType: 'visitor',
      authorId: visitorId,
      body: data.body || null,
      attachments,
      metadata: data.clientId ? { clientId: data.clientId } : undefined,
    });

    const visitorName = await visitorDisplayName(db, visitorId, existing.conversation);
    // The ball was already in the team's court → they've been told.
    const teamAlreadyWaiting =
      existing.conversation.state === 'open' && existing.conversation.waitingSince !== null;

    c.executionCtx.waitUntil(
      Promise.all([
        publishVisitorMessage(c.env, orgId, conversation, message, visitorName, 'updated'),
        // An unowned thread the customer writes into (new, reopened, or nobody
        // was free last time) gets an owner before anyone is told.
        autoAssignConversation(c.env, db, orgId, conversation).then((current) =>
          teamAlreadyWaiting
            ? undefined
            : notifyTeamOfVisitorMessage({
                env: c.env,
                db,
                orgId,
                conversation: current,
                message,
                visitorName,
                isNewConversation: false,
              }),
        ),
      ]),
    );

    const authors = await resolveAuthors(db, [conversation.assigneeId]);
    return success(
      c,
      {
        conversation: toPublicConversation(conversation, authors),
        message: toPublicMessage(message, authors),
      },
      201,
    );
  } catch (err) {
    if (err instanceof DeskConversationNotFoundError) return error.notFound(c, 'Conversation', id);
    console.error('[widget-api] send message failed:', err);
    return error.internal(c, 'Failed to send message');
  }
});

/** The visitor's CSAT answer for a conversation the team closed. */
conversationsRoutes.post('/:id/rating', zValidator('json', rateSchema), async (c) => {
  const db = c.get('tenantDb');
  const orgId = c.get('clerkOrgId');
  const id = c.req.param('id');
  const data = c.req.valid('json');
  try {
    const existing = await accessibleConversation(db, c.get('principal'), id);
    if (!existing) return error.notFound(c, 'Conversation', id);

    const { conversation, message } = await rateDeskConversation(db, {
      generateId,
      conversationId: id,
      authorId: c.get('visitor').id,
      rating: data.rating,
      comment: data.comment,
    });

    const authors = await resolveAuthors(db, [conversation.assigneeId]);
    c.executionCtx.waitUntil(publishVisitorEvent(c.env, orgId, conversation, message, authors));

    return success(
      c,
      {
        conversation: toPublicConversation(conversation, authors),
        message: toPublicMessage(message, authors),
      },
      201,
    );
  } catch (err) {
    if (err instanceof DeskConversationNotFoundError) return error.notFound(c, 'Conversation', id);
    if (err instanceof DeskRatingRejectedError) return error.conflict(c, err.message);
    console.error('[widget-api] rate conversation failed:', err);
    return error.internal(c, 'Failed to save rating');
  }
});
