/**
 * Visitor-facing conversation + message routes.
 *
 * Every route that touches a conversation checks that it belongs to the
 * calling visitor. Visitors never see internal notes, and message payloads
 * carry the teammate's display name/avatar so the widget never has to guess.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import {
  appendDeskMessage,
  attachDeskVisitorContact,
  createDeskConversation,
  getDeskConversation,
  listDeskConversationsForVisitor,
  upsertDeskVisitor,
  DeskConversationNotFoundError,
  type DeskConversation,
} from '@weldsuite/db/lib/desk';
import type { Env, Variables } from '../index';
import { error, success } from '../lib/response';
import { generateId } from '../lib/id';
import {
  isPublicMessage,
  notifyTeamOfVisitorMessage,
  publishConversationUpdated,
  publishVisitorMessage,
  resolveAuthors,
  toPublicConversation,
  toPublicMessage,
  visitorDisplayName,
} from '../lib/desk-live';

export const conversationsRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

const visitorIdSchema = z.string().min(1).max(64);

const identifySchema = z.object({
  visitorId: visitorIdSchema,
  name: z.string().trim().max(255).optional(),
  email: z.string().trim().email().max(255).optional(),
});

const clientIdSchema = z.string().max(64).optional();

const startSchema = z.object({
  visitorId: visitorIdSchema,
  name: z.string().trim().max(255).optional(),
  email: z.string().trim().email().max(255).optional(),
  body: z.string().trim().min(1).max(10_000),
  clientId: clientIdSchema,
});

const sendSchema = z.object({
  visitorId: visitorIdSchema,
  body: z.string().trim().min(1).max(10_000),
  clientId: clientIdSchema,
});

const visitorQuerySchema = z.object({ visitorId: visitorIdSchema });

function ownedBy(conversation: DeskConversation, visitorId: string): boolean {
  return conversation.visitorId === visitorId;
}

/** Register / update the visitor and attach their contact details to their conversations. */
conversationsRoutes.post('/identify', zValidator('json', identifySchema), async (c) => {
  const db = c.get('tenantDb');
  const widgetId = c.get('widgetId');
  const orgId = c.get('workspaceId');
  const data = c.req.valid('json');
  try {
    const visitor = await upsertDeskVisitor(db, {
      id: data.visitorId,
      name: data.name || undefined,
      email: data.email?.toLowerCase() || undefined,
      widgetId,
    });
    const updated = await attachDeskVisitorContact(db, visitor.id, {
      name: data.name,
      email: data.email,
    });
    c.executionCtx.waitUntil(
      Promise.all(updated.map((conversation) => publishConversationUpdated(c.env, orgId, conversation))),
    );
    return success(c, {
      visitor: { id: visitor.id, name: visitor.name, email: visitor.email },
    });
  } catch (err) {
    console.error('[widget-api] identify failed:', err);
    return error.internal(c, 'Failed to identify visitor');
  }
});

/** The visitor's conversation history (messenger "Messages" tab). */
conversationsRoutes.get('/', zValidator('query', visitorQuerySchema), async (c) => {
  const db = c.get('tenantDb');
  const { visitorId } = c.req.valid('query');
  try {
    const rows = await listDeskConversationsForVisitor(db, visitorId);
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
  const widgetId = c.get('widgetId');
  const orgId = c.get('workspaceId');
  const data = c.req.valid('json');
  try {
    const visitor = await upsertDeskVisitor(db, {
      id: data.visitorId,
      name: data.name || undefined,
      email: data.email?.toLowerCase() || undefined,
      widgetId,
    });

    const { conversation, message } = await createDeskConversation(db, {
      generateId,
      visitorId: visitor.id,
      name: visitor.name,
      email: visitor.email,
      body: data.body,
      authorType: 'visitor',
      authorId: visitor.id,
      metadata: data.clientId ? { clientId: data.clientId } : undefined,
    });

    const visitorName = await visitorDisplayName(db, visitor.id, visitor);
    c.executionCtx.waitUntil(
      Promise.all([
        publishVisitorMessage(c.env, orgId, conversation, message, visitorName, 'created'),
        notifyTeamOfVisitorMessage({
          env: c.env,
          db,
          orgId,
          conversation,
          message,
          visitorName,
          isNewConversation: true,
        }),
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

conversationsRoutes.get('/:id', zValidator('query', visitorQuerySchema), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const { visitorId } = c.req.valid('query');
  try {
    const result = await getDeskConversation(db, id, { includeMessages: true });
    if (!result || !ownedBy(result.conversation, visitorId)) {
      return error.notFound(c, 'Conversation', id);
    }
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
  const orgId = c.get('workspaceId');
  const id = c.req.param('id');
  const data = c.req.valid('json');
  try {
    const existing = await getDeskConversation(db, id);
    if (!existing || !ownedBy(existing.conversation, data.visitorId)) {
      return error.notFound(c, 'Conversation', id);
    }

    const { conversation, message } = await appendDeskMessage(db, {
      generateId,
      conversationId: id,
      kind: 'message',
      authorType: 'visitor',
      authorId: data.visitorId,
      body: data.body,
      metadata: data.clientId ? { clientId: data.clientId } : undefined,
    });

    const visitorName = await visitorDisplayName(db, data.visitorId, existing.conversation);
    // The ball was already in the team's court → they've been told.
    const teamAlreadyWaiting =
      existing.conversation.state === 'open' && existing.conversation.waitingSince !== null;

    c.executionCtx.waitUntil(
      Promise.all([
        publishVisitorMessage(c.env, orgId, conversation, message, visitorName, 'updated'),
        teamAlreadyWaiting
          ? Promise.resolve()
          : notifyTeamOfVisitorMessage({
              env: c.env,
              db,
              orgId,
              conversation,
              message,
              visitorName,
              isNewConversation: false,
            }),
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
