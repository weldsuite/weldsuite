/**
 * Chat message routes — flat /api/chat-messages/* surface backed by `chatMessages`.
 *
 * Permissions: reads/creates gate on channels:read | channels:create; message
 * mutations (update, delete) and message-scoped actions (reactions, pins,
 * upload) gate on the dedicated messages:* object, matching both the sibling
 * chat routes (chat-dm, chat-search) and the legacy api-worker gates.
 *
 * The messages:* gates on PATCH/DELETE are load-bearing: the MEMBER system role
 * holds weldchat:messages:{update,delete} but NOT channels:{update,delete}
 * (packages/core/permissions/src/catalog.ts), so gating those on channels:* would
 * 403 every non-admin user editing or deleting their own message. The
 * author/moderator checks inside each handler are the real authorization —
 * requirePermission only establishes that the caller may act on messages.
 *
 * Ported reactions/pins/threads/upload behaviour from
 * apps/api-worker/src/routes/chat/messages.ts and
 * apps/mobile-api-worker/src/routes/v1/chat/index.ts.
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import {
  createChatMessageSchema,
  updateChatMessageSchema,
  chatReactionSchema,
} from '@weldsuite/core-api-client/schemas/chat-messages';
import type { Env, Variables } from '../../types';
import { cursorPagination, error, list, noContent, success } from '@weldsuite/worker-kit/response';
import { schema } from '@weldsuite/worker-kit/db';
import type { Database } from '@weldsuite/worker-kit/db';
import { addReaction, removeReaction } from '../../services/chat/reactions';
import { pinMessage, unpinMessage, listPinnedMessages } from '../../services/chat/pins';
import { postPinNotice } from '../../services/chat/pin-notice';
import { uploadChatFile } from '../../services/chat/upload';
import { ChatFeatureError, postChatMessage } from '../../services/chat/post-message';
import {
  canAccessChannel,
  canAccessMessage,
  isChannelModerator,
} from '../../services/chat/channel-access';
import { getChannelFeatureFlags } from '../../services/chat/channel-features';
import { consumeChatRateLimit } from '../../services/chat/rate-limit';
import {
  publishChatMessageDeleted,
  publishChatMessageUpdated,
} from '@weldsuite/chat-domain/realtime/weldchat-publisher';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
const t = schema.chatMessages;

/** Columns an author may change when editing their own message. */
const EDITABLE_MESSAGE_FIELDS = ['content', 'htmlContent'] as const;

/** Max chat attachment size (50 MB) — covers voice/video messages. */
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

/**
 * Active-content MIME types that must never be stored and served from the
 * public R2 URL (stored-XSS vector). Matched case-insensitively against the
 * declared `file.type`.
 */
const DANGEROUS_UPLOAD_TYPES = new Set([
  'text/html',
  'application/xhtml+xml',
  'image/svg+xml',
  'application/xml',
  'text/xml',
  'application/javascript',
  'text/javascript',
  'application/x-msdownload',
  'application/x-sh',
]);

function isDangerousUploadType(mime: string): boolean {
  return DANGEROUS_UPLOAD_TYPES.has((mime || '').toLowerCase().split(';')[0].trim());
}

/** Sniff magic bytes so a renamed .html/.svg cannot sneak past MIME spoofing. */
async function looksLikeDangerousBytes(file: File): Promise<boolean> {
  const head = new Uint8Array(await file.slice(0, 512).arrayBuffer());
  if (head.length === 0) return false;
  const text = new TextDecoder('utf-8', { fatal: false, ignoreBOM: true })
    .decode(head)
    .trimStart()
    .toLowerCase();
  if (text.startsWith('<!doctype html') || text.startsWith('<html') || text.startsWith('<svg')) {
    return true;
  }
  if (text.startsWith('<?xml') && (text.includes('<svg') || text.includes('<html'))) {
    return true;
  }
  // PE executable
  if (head[0] === 0x4d && head[1] === 0x5a) return true;
  return false;
}

type ChatContext = Context<{ Bindings: Env; Variables: Variables }>;

/** Filters shared by the list query and its total count (everything but the cursor). */
function listFilterConditions(q: Record<string, string>): SQL[] {
  const conditions: SQL[] = [isNull(t.deletedAt), eq(t.channelId, q.channelId)];
  if (q.authorId) conditions.push(eq(t.authorId, q.authorId));
  // Thread support: when `parentId` is provided return only the replies to
  // that message; otherwise return top-level messages (parentId IS NULL).
  conditions.push(q.parentId ? eq(t.parentId, q.parentId) : isNull(t.parentId));
  return conditions;
}

/** Keyset condition selecting messages older than the cursor message, if it exists. */
async function cursorCondition(db: Database, cursorId: string): Promise<SQL | undefined> {
  const [cur] = await db
    .select({ createdAt: t.createdAt, id: t.id })
    .from(t).where(eq(t.id, cursorId)).limit(1);
  if (!cur?.createdAt) return undefined;
  return sql`(${t.createdAt} < ${cur.createdAt} OR (${t.createdAt} = ${cur.createdAt} AND ${t.id} < ${cur.id}))`;
}

app.get('/', requirePermission('channels:read'), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const q = c.req.query();
  const limit = Math.min(q.limit ? Number.parseInt(q.limit, 10) : 25, 100);

  // Membership boundary: messages are only ever returned for a single channel
  // the caller may actually see (public, or one they're a member of). A
  // channelId is required so we never fan a query across every channel, and a
  // non-member of a private channel gets a 403 rather than its message bodies.
  if (!q.channelId) {
    return error.badRequest(c, 'channelId query parameter is required');
  }
  if (!(await canAccessChannel(db, q.channelId, userId))) {
    return error.forbidden(c, 'You do not have access to this channel');
  }

  const filterConditions = listFilterConditions(q);
  const cursorCond = q.cursor ? await cursorCondition(db, q.cursor) : undefined;
  const where = and(...filterConditions, cursorCond);
  const countWhere = and(...filterConditions);

  try {
    const [rows, countRes] = await Promise.all([
      db.select().from(t).where(where).orderBy(desc(t.createdAt), desc(t.id)).limit(limit + 1),
      db.select({ count: sql<number>`count(*)` }).from(t).where(countWhere),
    ]);
    const hasMore = rows.length > limit;
    const data = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore && data.length > 0 ? data[data.length - 1].id : null;
    const totalCount = Number(countRes[0]?.count ?? 0);
    return list(c, data, cursorPagination(totalCount, hasMore, nextCursor));
  } catch (err) {
    console.error('[app-api/chat-messages] list failed:', err);
    return error.internal(c, 'Failed to list chat messages');
  }
});

/**
 * GET /pinned?channelId= — list pinned messages for a channel (newest pin first).
 * Mounted before `/:id` so the literal segment is matched first.
 */
app.get('/pinned', requirePermission('messages:read'), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const channelId = c.req.query('channelId');
  if (!channelId) return error.badRequest(c, 'channelId query parameter is required');
  // Membership boundary: don't leak pinned messages of a channel the caller
  // can't see.
  if (!(await canAccessChannel(db, channelId, userId))) {
    return error.forbidden(c, 'You do not have access to this channel');
  }
  try {
    const rows = await listPinnedMessages(db, channelId);
    return success(c, rows);
  } catch (err) {
    console.error('[app-api/chat-messages] list pinned failed:', err);
    return error.internal(c, 'Failed to list pinned messages');
  }
});

app.get('/:id', requirePermission('channels:read'), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const id = c.req.param('id');
  try {
    const [row] = await db.select().from(t).where(and(eq(t.id, id), isNull(t.deletedAt))).limit(1);
    if (!row) return error.notFound(c, 'Chat message', id);
    // Membership boundary: a message in a private channel/DM is only readable
    // by members. Answer 404 (not 403) so we don't confirm the message exists.
    if (!(await canAccessChannel(db, row.channelId, userId))) {
      return error.notFound(c, 'Chat message', id);
    }
    return success(c, row);
  } catch (err) {
    console.error('[app-api/chat-messages] get failed:', err);
    return error.internal(c, 'Failed to fetch chat message');
  }
});

/** Wraps `waitUntil` so a missing execution context degrades to fire-and-forget. */
function safeWaitUntil(c: ChatContext): (p: Promise<unknown>) => void {
  return (p) => {
    try {
      c.executionCtx.waitUntil(p);
    } catch {
      void p.catch(() => undefined);
    }
  };
}

/**
 * Maps a create-message body to the shared send pipeline's input. `body`
 * (mobile) and `content` (platform/tests) are both accepted for the text.
 */
function messageInputFromBody(data: Record<string, unknown>) {
  const content =
    typeof data.body === 'string' ? data.body : typeof data.content === 'string' ? data.content : '';
  return {
    content,
    htmlContent: typeof data.htmlContent === 'string' ? data.htmlContent : undefined,
    parentId: typeof data.parentId === 'string' ? data.parentId : null,
    attachments: Array.isArray(data.attachments)
      ? (data.attachments as Array<Record<string, unknown>>)
      : undefined,
    mentions: Array.isArray(data.mentions) ? (data.mentions as string[]) : undefined,
    metadata: data.metadata as Record<string, unknown> | undefined,
    replyToId: typeof data.replyToId === 'string' ? data.replyToId : null,
    replyMention: typeof data.replyMention === 'boolean' ? data.replyMention : undefined,
  };
}

/** Maps a send-pipeline feature error to its HTTP response. */
function chatFeatureErrorResponse(c: ChatContext, err: ChatFeatureError, channelId: string) {
  if (err.status === 404) return error.notFound(c, 'Channel', channelId);
  return error.badRequest(c, err.message);
}

app.post('/', requirePermission('channels:create'), zValidator('json', createChatMessageSchema), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const orgId = c.get('orgId');
  if (!orgId) return error.orgRequired(c);
  const data = c.req.valid('json') as Record<string, any>;

  const channelId = typeof data.channelId === 'string' ? data.channelId : '';
  if (!channelId) {
    return error.badRequest(c, 'channelId is required');
  }
  // Membership boundary: only a member (or anyone, for a public channel) may
  // post to a channel.
  if (!(await canAccessChannel(db, channelId, userId))) {
    return error.forbidden(c, 'You do not have access to this channel');
  }

  const rl = await consumeChatRateLimit(c.env, `msg:${orgId}:${userId}`, 60);
  if (!rl.ok) return error.badRequest(c, 'Too many messages — slow down and try again');

  try {
    // Delegate to the shared send pipeline so this endpoint behaves exactly like
    // the platform's /channels/:id/messages: maps the message body to `content`
    // (NOT NULL), parses @mentions, bumps thread/unread counts, broadcasts over
    // the ChatRoom DO, and fires mention / thread-reply / DM notifications. The
    // author is always the authenticated caller (no body-supplied authorId).
    const message = await postChatMessage(
      {
        db,
        env: c.env,
        orgId,
        channelId,
        authorUserId: userId,
        waitUntil: safeWaitUntil(c),
      },
      messageInputFromBody(data),
    );
    publishEntityEvent({
      c,
      entityType: 'chat_message',
      action: 'created',
      entityId: message.id,
      data: { id: message.id, channelId, authorId: userId },
    });
    return success(c, { id: message.id }, 201);
  } catch (err) {
    if (err instanceof ChatFeatureError) return chatFeatureErrorResponse(c, err, channelId);
    console.error('[app-api/chat-messages] create failed:', err);
    return error.internal(c, 'Failed to create chat message');
  }
});

app.patch('/:id', requirePermission('messages:update'), zValidator('json', updateChatMessageSchema), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const id = c.req.param('id');
  const data = c.req.valid('json') as Record<string, any>;
  try {
    const [existing] = await db.select().from(t).where(and(eq(t.id, id), isNull(t.deletedAt))).limit(1);
    if (!existing) return error.notFound(c, 'Chat message', id);
    // Hide private-channel messages behind a 404, and only the author may edit
    // their own message (editing someone else's content is never allowed).
    if (!(await canAccessChannel(db, existing.channelId, userId))) {
      return error.notFound(c, 'Chat message', id);
    }
    if (existing.authorId !== userId) {
      return error.forbidden(c, 'You can only edit your own messages');
    }
    if (existing.type === 'system') {
      return error.badRequest(c, 'System messages cannot be edited');
    }
    const update: Record<string, any> = {
      updatedAt: new Date(),
      isEdited: true,
      editedAt: new Date(),
    };
    // Only the text is editable. The body schema is a passthrough, so spreading
    // it into the update let an author rewrite `type` (forging a `system`
    // notice), `authorId`, `channelId`, pin state, reactions...
    for (const k of EDITABLE_MESSAGE_FIELDS) if (data[k] !== undefined) update[k] = data[k];
    await db.update(t).set(update).where(and(eq(t.id, id), isNull(t.deletedAt)));
    const [updated] = await db.select().from(t).where(eq(t.id, id)).limit(1);
    publishEntityEvent({
      c,
      entityType: 'chat_message',
      action: 'updated',
      entityId: id,
      data: { id, channelId: existing.channelId },
    });
    try {
      await publishChatMessageUpdated(c.env, existing.channelId, {
        id,
        content: updated?.content ?? existing.content,
        isEdited: true,
        updatedAt: updated?.updatedAt?.toISOString?.() ?? new Date().toISOString(),
      });
    } catch (e) {
      console.error('[app-api/chat-messages] message:updated publish failed:', e);
    }
    return success(c, updated ?? { id });
  } catch (err) {
    console.error('[app-api/chat-messages] update failed:', err);
    return error.internal(c, 'Failed to update chat message');
  }
});

app.delete('/:id', requirePermission('messages:delete'), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const id = c.req.param('id');
  try {
    const [existing] = await db.select().from(t).where(and(eq(t.id, id), isNull(t.deletedAt))).limit(1);
    if (!existing) return error.notFound(c, 'Chat message', id);
    // Hide private-channel messages behind a 404. A message may be deleted by
    // its author or by a channel admin/owner (moderation) — never by an
    // arbitrary workspace member.
    if (!(await canAccessChannel(db, existing.channelId, userId))) {
      return error.notFound(c, 'Chat message', id);
    }
    if (existing.authorId !== userId && !(await isChannelModerator(db, existing.channelId, userId))) {
      return error.forbidden(c, 'You can only delete your own messages');
    }
    await db.update(t).set({ deletedAt: new Date(), updatedAt: new Date() }).where(eq(t.id, id));

    // Keep parent thread reply counts accurate after soft-delete.
    if (existing.parentId) {
      await db
        .update(t)
        .set({
          threadReplyCount: sql`GREATEST(${t.threadReplyCount} - 1, 0)`,
          updatedAt: new Date(),
        })
        .where(eq(t.id, existing.parentId));
    }

    publishEntityEvent({
      c,
      entityType: 'chat_message',
      action: 'deleted',
      entityId: id,
      data: { id, channelId: existing.channelId },
    });
    try {
      await publishChatMessageDeleted(c.env, existing.channelId, id);
    } catch (e) {
      console.error('[app-api/chat-messages] message:deleted publish failed:', e);
    }
    return noContent(c);
  } catch (err) {
    console.error('[app-api/chat-messages] delete failed:', err);
    return error.internal(c, 'Failed to delete chat message');
  }
});

// ============================================================================
// Reactions — toggle the current user in the JSONB reactions map.
// ============================================================================

/**
 * POST /:id/reactions — add the current user's reaction for an emoji.
 */
app.post(
  '/:id/reactions',
  requirePermission('messages:create'),
  zValidator('json', chatReactionSchema),
  async (c) => {
    const db = c.get('tenantDb');
    const userId = c.get('userId');
    const orgId = c.get('orgId');
    const id = c.req.param('id');
    const { emoji } = c.req.valid('json');
    // Membership boundary: can't react to messages in a channel you can't see.
    if (!(await canAccessMessage(db, id, userId))) {
      return error.notFound(c, 'Chat message', id);
    }
    const rl = await consumeChatRateLimit(c.env, `react:${orgId ?? 'x'}:${userId}`, 120);
    if (!rl.ok) return error.badRequest(c, 'Too many reactions — slow down and try again');
    try {
      const [msg] = await db
        .select({ channelId: t.channelId })
        .from(t)
        .where(and(eq(t.id, id), isNull(t.deletedAt)))
        .limit(1);
      if (!msg) return error.notFound(c, 'Chat message', id);
      const flags = await getChannelFeatureFlags(db, msg.channelId);
      if (flags && !flags.reactionsEnabled) {
        return error.badRequest(c, 'Reactions are disabled in this channel');
      }
      const result = await addReaction(db, id, emoji, userId);
      if (!result) return error.notFound(c, 'Chat message', id);
      publishEntityEvent({
        c,
        entityType: 'chat_message',
        action: 'updated',
        entityId: id,
        data: { id, channelId: result.channelId },
      });
      return success(c, result);
    } catch (err) {
      console.error('[app-api/chat-messages] add reaction failed:', err);
      return error.internal(c, 'Failed to add reaction');
    }
  },
);

/**
 * DELETE /:id/reactions/:emoji — remove the current user's reaction for an emoji.
 */
app.delete('/:id/reactions/:emoji', requirePermission('messages:update'), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const id = c.req.param('id');
  const emoji = decodeURIComponent(c.req.param('emoji'));
  if (!(await canAccessMessage(db, id, userId))) {
    return error.notFound(c, 'Chat message', id);
  }
  try {
    const result = await removeReaction(db, id, emoji, userId);
    if (!result) return error.notFound(c, 'Chat message', id);
    publishEntityEvent({
      c,
      entityType: 'chat_message',
      action: 'updated',
      entityId: id,
      data: { id, channelId: result.channelId },
    });
    return success(c, result);
  } catch (err) {
    console.error('[app-api/chat-messages] remove reaction failed:', err);
    return error.internal(c, 'Failed to remove reaction');
  }
});

// ============================================================================
// Pins
// ============================================================================

/**
 * POST /:id/pin — pin a message. Optional body { expiresAt?, silent?, notify? };
 * `notify: true` also posts a server-authored `type: 'system'` pin notice.
 */
app.post('/:id/pin', requirePermission('messages:update'), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const id = c.req.param('id');

  // Membership boundary: only members of the channel may pin within it.
  if (!(await canAccessMessage(db, id, userId))) {
    return error.notFound(c, 'Chat message', id);
  }

  // Body is optional — tolerate empty/missing bodies.
  let expiresAt: string | undefined;
  let notify = false;
  try {
    const body: unknown = await c.req.json().catch(() => undefined);
    if (body && typeof body === 'object') {
      const fields = body as { expiresAt?: unknown; notify?: unknown };
      if (typeof fields.expiresAt === 'string') expiresAt = fields.expiresAt;
      notify = fields.notify === true;
    }
  } catch {
    /* no body is fine */
  }

  try {
    const result = await pinMessage(db, id, userId, expiresAt);
    if (!result) return error.notFound(c, 'Chat message', id);

    // Schedule the auto-unpin workflow when an expiry is set (mirrors
    // api-worker routes/chat/messages.ts). Instance id = messageId so the
    // manual unpin below can look it up and abort it.
    if (expiresAt && c.env.UNPIN_EXPIRED_MESSAGE) {
      const workspaceId = c.get('workspaceId') || c.get('orgId') || '';
      try {
        await c.env.UNPIN_EXPIRED_MESSAGE.create({
          id,
          params: { workspaceId, channelId: result.channelId, messageId: id, expiresAt },
        });
      } catch (e) {
        console.error('[app-api/chat-messages] failed to create unpin workflow:', e);
      }
    }

    publishEntityEvent({
      c,
      entityType: 'chat_message',
      action: 'updated',
      entityId: id,
      data: { id, channelId: result.channelId },
    });

    // "Pin with alert": the server writes the channel notice itself (a
    // `type: 'system'` message by the pinner), never the client.
    if (notify) {
      try {
        const notice = await postPinNotice(db, c.env.REALTIME, {
          channelId: result.channelId,
          pinnedMessageId: id,
          userId,
        });
        publishEntityEvent({
          c,
          entityType: 'chat_message',
          action: 'created',
          entityId: notice.id,
          data: { id: notice.id, channelId: notice.channelId, authorId: userId },
        });
      } catch (e) {
        // The pin itself succeeded; a missing notice must not fail it.
        console.error('[app-api/chat-messages] pin notice failed:', e);
      }
    }
    return success(c, result);
  } catch (err) {
    console.error('[app-api/chat-messages] pin failed:', err);
    return error.internal(c, 'Failed to pin message');
  }
});

/**
 * DELETE /:id/pin — unpin a message.
 */
app.delete('/:id/pin', requirePermission('messages:update'), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const id = c.req.param('id');
  if (!(await canAccessMessage(db, id, userId))) {
    return error.notFound(c, 'Chat message', id);
  }
  try {
    const result = await unpinMessage(db, id);
    if (!result) return error.notFound(c, 'Chat message', id);

    // Cancel a pending auto-unpin workflow, if one is running (instance id =
    // messageId — see the pin endpoint above). api-worker called the
    // non-existent `.abort()` here; `terminate()` is the real instance API.
    // Even if this fails, the workflow's own isPinned guard makes the
    // eventual wake-up a no-op.
    if (c.env.UNPIN_EXPIRED_MESSAGE) {
      try {
        const instance = await c.env.UNPIN_EXPIRED_MESSAGE.get(id);
        await instance.terminate();
      } catch {
        /* no workflow to cancel */
      }
    }

    publishEntityEvent({
      c,
      entityType: 'chat_message',
      action: 'updated',
      entityId: id,
      data: { id, channelId: result.channelId },
    });
    return success(c, result);
  } catch (err) {
    console.error('[app-api/chat-messages] unpin failed:', err);
    return error.internal(c, 'Failed to unpin message');
  }
});

// ============================================================================
// File upload — multipart/form-data → R2 STORAGE bucket.
// ============================================================================

/** Checks an upload's size, storage config and (active-content) type; yields the public URL or a rejection. */
async function validateUpload(
  c: ChatContext,
  file: File,
): Promise<{ r2PublicUrl: string } | { rejection: Response }> {
  // Size cap — reject oversized uploads before buffering them into memory.
  if (file.size > MAX_UPLOAD_BYTES) {
    return { rejection: error.badRequest(c, `File exceeds the ${MAX_UPLOAD_BYTES / (1024 * 1024)}MB limit`) };
  }

  const r2PublicUrl = c.env.R2_PUBLIC_URL;
  if (!r2PublicUrl) {
    return { rejection: error.internal(c, 'File storage is not configured for this environment') };
  }

  // Block active-content types: files are served from a public R2 URL, so an
  // HTML/SVG/XML/JS attachment would be a stored-XSS vector on the storage
  // domain. Everything else (images, audio, video, pdf, docs) is allowed.
  if (isDangerousUploadType(file.type) || (await looksLikeDangerousBytes(file))) {
    return { rejection: error.badRequest(c, 'This file type is not allowed') };
  }
  return { r2PublicUrl };
}

/** Rejection when the caller may not attach files to the channel, else null. */
async function attachmentChannelRejection(
  c: ChatContext,
  channelId: string,
  userId: string,
): Promise<Response | null> {
  // Membership boundary: only post attachments to a channel you can access.
  if (!(await canAccessChannel(c.get('tenantDb'), channelId, userId))) {
    return error.forbidden(c, 'You do not have access to this channel');
  }
  const flags = await getChannelFeatureFlags(c.get('tenantDb'), channelId);
  if (flags && !flags.attachmentsEnabled) {
    return error.badRequest(c, 'Attachments are disabled in this channel');
  }
  return null;
}

/**
 * POST /upload — multipart upload of a chat attachment. Fields: `file`
 * (required), `channelId` (optional, used for the storage key namespace).
 * Returns the stored file's URL + metadata.
 */
app.post('/upload', requirePermission('messages:create'), async (c) => {
  const workspaceId = c.get('workspaceId') || c.get('orgId');
  const userId = c.get('userId');
  if (!workspaceId) return error.orgRequired(c);
  if (!c.env.STORAGE) return error.internal(c, 'Storage is not configured');

  try {
    const formData = await c.req.formData();
    const file = formData.get('file') as File | null;
    const channelIdRaw = formData.get('channelId');
    const channelId = typeof channelIdRaw === 'string' && channelIdRaw ? channelIdRaw : null;

    if (!file) {
      return error.badRequest(c, 'No file provided');
    }

    const validated = await validateUpload(c, file);
    if ('rejection' in validated) return validated.rejection;

    const channelRejection = channelId ? await attachmentChannelRejection(c, channelId, userId) : null;
    if (channelRejection) return channelRejection;

    const rl = await consumeChatRateLimit(c.env, `upload:${workspaceId}:${userId}`, 30);
    if (!rl.ok) return error.badRequest(c, 'Too many uploads — slow down and try again');

    const result = await uploadChatFile({
      storage: c.env.STORAGE,
      r2PublicUrl: validated.r2PublicUrl,
      workspaceId,
      channelId,
      file,
      requirePublicUrl: true,
    });

    return success(c, result, 201);
  } catch (err) {
    console.error('[app-api/chat-messages] upload failed:', err);
    return error.internal(c, 'Failed to upload file');
  }
});

export const chatMessagesRoutes = app;
