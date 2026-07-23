/**
 * WeldDesk v2 conversation-core routes — /api/desk/conversations/*.
 *
 * Intercom-model conversation + parts (see .claude/welddesk-intercom-plan.md
 * Phase 1). Every mutation flows through the `appendPart` service
 * (services/desk/parts.ts), the single choke point that keeps state,
 * waitingSince, and the statistics rollup consistent.
 *
 * Permissions: reuses the existing `conversations:*` object (read for GETs,
 * create for POST /, update for every other mutation) — no new permission
 * object was introduced for the v2 schema; `conversations` already covers
 * the helpdesk conversation surface end to end.
 *
 * Entity events: `desk_conversation` (created/updated/state_changed/snoozed/
 * unsnoozed/assigned/rated) and `desk_conversation_part` (created), both
 * already in the HELPDESK_ENTITY_EVENTS catalog (packages/entity-events).
 * publishEntityEvent's REALTIME sink fans these out to the WorkspaceHub DO
 * under the `desk_conversation` / `desk_conversation_part` topics — no
 * separate realtime call is needed (see packages/core/entity-events/src/publisher.ts).
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { eq } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import {
  createConversationSchema,
  listConversationsQuerySchema,
  getConversationQuerySchema,
  replyToConversationSchema,
  manageConversationSchema,
  addConversationTagSchema,
  updateConversationAttributesSchema,
  rateConversationSchema,
} from '@weldsuite/core-api-client/schemas/desk-conversations';
import { applyMacroSchema } from '@weldsuite/core-api-client/schemas/desk-macros';
import type { Env, Variables } from '../../types';
import { cursorPagination, error, list, noContent, success } from '../../lib/response';
import { schema } from '../../db';
import {
  createConversation,
  getConversation,
  listConversations,
} from '../../services/desk/conversations';
import { appendPart, appendReplyPart, DeskConversationNotFoundError } from '../../services/desk/parts';
import { applyMacro, DeskMacroNotFoundError } from '../../services/desk/macros';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
const conversations = schema.deskConversations;

// ---------------------------------------------------------------------------
// List / Create / Get
// ---------------------------------------------------------------------------

app.get('/', requirePermission('conversations:read'), zValidator('query', listConversationsQuerySchema), async (c) => {
  const db = c.get('tenantDb');
  const query = c.req.valid('query');
  try {
    const result = await listConversations(db, query);
    return list(c, result.data, cursorPagination(result.totalCount, result.hasMore, result.cursor));
  } catch (err) {
    console.error('[app-api/desk-conversations] list failed:', err);
    return error.internal(c, 'Failed to list conversations');
  }
});

app.post('/', requirePermission('conversations:create'), zValidator('json', createConversationSchema), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const data = c.req.valid('json');
  try {
    const { conversation, part } = await createConversation(db, { ...data, authorUserId: userId });
    publishEntityEvent({
      c,
      entityType: 'desk_conversation',
      action: 'created',
      entityId: conversation.id,
      data: conversation as unknown as Record<string, unknown>,
    });
    publishEntityEvent({
      c,
      entityType: 'desk_conversation_part',
      action: 'created',
      entityId: part.id,
      data: part as unknown as Record<string, unknown>,
    });
    return success(c, conversation, 201);
  } catch (err) {
    console.error('[app-api/desk-conversations] create failed:', err);
    return error.internal(c, 'Failed to create conversation');
  }
});

app.get('/:id', requirePermission('conversations:read'), zValidator('query', getConversationQuerySchema), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const { include } = c.req.valid('query');
  try {
    const result = await getConversation(db, id, { includeParts: include === 'parts' });
    if (!result) return error.notFound(c, 'Conversation', id);
    return success(c, result.parts ? { ...result.conversation, parts: result.parts } : result.conversation);
  } catch (err) {
    console.error('[app-api/desk-conversations] get failed:', err);
    return error.internal(c, 'Failed to fetch conversation');
  }
});

// ---------------------------------------------------------------------------
// Reply — comment | note
// ---------------------------------------------------------------------------

app.post('/:id/reply', requirePermission('conversations:update'), zValidator('json', replyToConversationSchema), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const id = c.req.param('id');
  const data = c.req.valid('json');
  try {
    const { conversation, part } = await appendReplyPart(db, {
      conversationId: id,
      messageType: data.messageType,
      authorType: 'admin',
      authorId: userId,
      body: data.body,
      blocks: data.blocks as never,
      attachments: data.attachments,
      // mentionUserIds only makes sense on notes (comments go to the customer).
      metadata:
        data.messageType === 'note' && data.mentionUserIds && data.mentionUserIds.length > 0
          ? { mentionUserIds: data.mentionUserIds }
          : undefined,
    });
    publishEntityEvent({
      c,
      entityType: 'desk_conversation',
      action: 'updated',
      entityId: conversation.id,
      data: conversation as unknown as Record<string, unknown>,
    });
    publishEntityEvent({
      c,
      entityType: 'desk_conversation_part',
      action: 'created',
      entityId: part.id,
      data: part as unknown as Record<string, unknown>,
    });
    return success(c, { conversation, part }, 201);
  } catch (err) {
    if (err instanceof DeskConversationNotFoundError) return error.notFound(c, 'Conversation', id);
    console.error('[app-api/desk-conversations] reply failed:', err);
    return error.internal(c, 'Failed to reply to conversation');
  }
});

// ---------------------------------------------------------------------------
// Manage — close | open | snooze | assign
// ---------------------------------------------------------------------------

app.post('/:id/manage', requirePermission('conversations:update'), zValidator('json', manageConversationSchema), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const id = c.req.param('id');
  const data = c.req.valid('json');

  try {
    const [current] = await db.select().from(conversations).where(eq(conversations.id, id)).limit(1);
    if (!current) return error.notFound(c, 'Conversation', id);

    const result = await (async () => {
      switch (data.action) {
        case 'close':
          return appendPart(db, { conversationId: id, partType: 'close', authorType: 'admin', authorId: userId });
        case 'open':
          return appendPart(db, { conversationId: id, partType: 'open', authorType: 'admin', authorId: userId });
        case 'snooze':
          return appendPart(db, {
            conversationId: id,
            partType: 'snoozed',
            authorType: 'admin',
            authorId: userId,
            snoozedUntil: new Date(data.snoozedUntil),
          });
        case 'assign': {
          const assigneeId = data.assigneeId ?? null;
          // Snoozed + assignment by someone else also unsnoozes
          // (assign_and_unsnooze). Assigning while open/closed is a plain
          // assignment part.
          const partType = current.state === 'snoozed' ? 'assign_and_unsnooze' : 'assignment';
          return appendPart(db, {
            conversationId: id,
            partType,
            authorType: 'admin',
            authorId: userId,
            assignedToType: data.assigneeType,
            assignedToId: assigneeId,
          });
        }
      }
    })();

    publishEntityEvent({
      c,
      entityType: 'desk_conversation',
      action:
        data.action === 'close'
          ? 'state_changed'
          : data.action === 'open'
            ? 'state_changed'
            : data.action === 'snooze'
              ? 'snoozed'
              : 'assigned',
      entityId: result.conversation.id,
      data: result.conversation as unknown as Record<string, unknown>,
    });
    publishEntityEvent({
      c,
      entityType: 'desk_conversation_part',
      action: 'created',
      entityId: result.part.id,
      data: result.part as unknown as Record<string, unknown>,
    });
    return success(c, result.conversation);
  } catch (err) {
    if (err instanceof DeskConversationNotFoundError) return error.notFound(c, 'Conversation', id);
    console.error('[app-api/desk-conversations] manage failed:', err);
    return error.internal(c, 'Failed to update conversation');
  }
});

// ---------------------------------------------------------------------------
// Tags
// ---------------------------------------------------------------------------

app.post('/:id/tags', requirePermission('conversations:update'), zValidator('json', addConversationTagSchema), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const { tag } = c.req.valid('json');
  try {
    const [current] = await db.select().from(conversations).where(eq(conversations.id, id)).limit(1);
    if (!current) return error.notFound(c, 'Conversation', id);
    const tags = new Set(current.tags ?? []);
    tags.add(tag);
    await db.update(conversations).set({ tags: Array.from(tags), updatedAt: new Date() }).where(eq(conversations.id, id));
    const [updated] = await db.select().from(conversations).where(eq(conversations.id, id)).limit(1);
    publishEntityEvent({
      c,
      entityType: 'desk_conversation',
      action: 'updated',
      entityId: id,
      data: updated as unknown as Record<string, unknown>,
    });
    return success(c, updated);
  } catch (err) {
    console.error('[app-api/desk-conversations] add tag failed:', err);
    return error.internal(c, 'Failed to add tag');
  }
});

app.delete('/:id/tags/:tag', requirePermission('conversations:update'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const tag = decodeURIComponent(c.req.param('tag'));
  try {
    const [current] = await db.select().from(conversations).where(eq(conversations.id, id)).limit(1);
    if (!current) return error.notFound(c, 'Conversation', id);
    const tags = (current.tags ?? []).filter((t) => t !== tag);
    await db.update(conversations).set({ tags, updatedAt: new Date() }).where(eq(conversations.id, id));
    const [updated] = await db.select().from(conversations).where(eq(conversations.id, id)).limit(1);
    publishEntityEvent({
      c,
      entityType: 'desk_conversation',
      action: 'updated',
      entityId: id,
      data: updated as unknown as Record<string, unknown>,
    });
    return noContent(c);
  } catch (err) {
    console.error('[app-api/desk-conversations] remove tag failed:', err);
    return error.internal(c, 'Failed to remove tag');
  }
});

// ---------------------------------------------------------------------------
// Attributes — title / priority / read / customAttributes
// ---------------------------------------------------------------------------

app.patch('/:id/attributes', requirePermission('conversations:update'), zValidator('json', updateConversationAttributesSchema), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const data = c.req.valid('json');
  try {
    const [current] = await db.select().from(conversations).where(eq(conversations.id, id)).limit(1);
    if (!current) return error.notFound(c, 'Conversation', id);

    const patch: Record<string, unknown> = { updatedAt: new Date() };
    if (data.title !== undefined) patch.title = data.title;
    if (data.priority !== undefined) patch.priority = data.priority;
    if (data.read !== undefined) patch.read = data.read;
    if (data.customAttributes !== undefined) {
      patch.customAttributes = { ...(current.customAttributes ?? {}), ...data.customAttributes };
    }

    await db.update(conversations).set(patch).where(eq(conversations.id, id));
    const [updated] = await db.select().from(conversations).where(eq(conversations.id, id)).limit(1);
    publishEntityEvent({
      c,
      entityType: 'desk_conversation',
      action: 'updated',
      entityId: id,
      data: updated as unknown as Record<string, unknown>,
    });
    return success(c, updated);
  } catch (err) {
    console.error('[app-api/desk-conversations] update attributes failed:', err);
    return error.internal(c, 'Failed to update conversation attributes');
  }
});

// ---------------------------------------------------------------------------
// Rating
// ---------------------------------------------------------------------------

app.post('/:id/rating', requirePermission('conversations:update'), zValidator('json', rateConversationSchema), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const id = c.req.param('id');
  const data = c.req.valid('json');
  try {
    const result = await appendPart(db, {
      conversationId: id,
      partType: 'conversation_rating_changed',
      authorType: 'admin',
      authorId: userId,
      rating: {
        rating: data.rating,
        remark: data.remark,
        createdAt: new Date().toISOString(),
        teammateId: userId,
      },
    });
    publishEntityEvent({
      c,
      entityType: 'desk_conversation',
      action: 'rated',
      entityId: result.conversation.id,
      data: result.conversation as unknown as Record<string, unknown>,
    });
    publishEntityEvent({
      c,
      entityType: 'desk_conversation_part',
      action: 'created',
      entityId: result.part.id,
      data: result.part as unknown as Record<string, unknown>,
    });
    return success(c, result.conversation);
  } catch (err) {
    if (err instanceof DeskConversationNotFoundError) return error.notFound(c, 'Conversation', id);
    console.error('[app-api/desk-conversations] rate failed:', err);
    return error.internal(c, 'Failed to rate conversation');
  }
});

// ---------------------------------------------------------------------------
// Apply macro — executes a macro's actions against this conversation
// ---------------------------------------------------------------------------

app.post(
  '/:id/apply-macro',
  requirePermission('conversations:update'),
  zValidator('json', applyMacroSchema),
  async (c) => {
    const db = c.get('tenantDb');
    const userId = c.get('userId');
    const id = c.req.param('id');
    const { macroId } = c.req.valid('json');
    try {
      const result = await applyMacro(db, id, macroId, userId);

      publishEntityEvent({
        c,
        entityType: 'desk_conversation',
        action: 'updated',
        entityId: result.conversation.id,
        data: result.conversation as unknown as Record<string, unknown>,
      });
      for (const part of result.parts) {
        publishEntityEvent({
          c,
          entityType: 'desk_conversation_part',
          action: 'created',
          entityId: part.id,
          data: part as unknown as Record<string, unknown>,
        });
      }

      return success(c, {
        conversation: result.conversation,
        composerPrefill: result.composerPrefill,
        skipped: result.skipped,
      });
    } catch (err) {
      if (err instanceof DeskConversationNotFoundError) return error.notFound(c, 'Conversation', id);
      if (err instanceof DeskMacroNotFoundError) return error.notFound(c, 'Macro', macroId);
      console.error('[app-api/desk-conversations] apply-macro failed:', err);
      return error.internal(c, 'Failed to apply macro');
    }
  },
);

export const deskConversationsRoutes = app;
