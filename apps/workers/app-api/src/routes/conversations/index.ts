/**
 * Conversation routes — flat /api/conversations/* surface backed by
 * `helpdeskConversations` + `helpdeskConversationMessages`.
 *
 * Permissions: conversations:read | conversations:create | conversations:update
 * | conversations:delete — the same tiers the legacy api-worker route gated on.
 * SYSTEM_ROLES.MEMBER resolves to conversations:read/create/update, so every
 * agent-reachable action here (reply, star, read, archive, assign, priority)
 * gates on :update and never on :delete.
 *
 * W5b: the message thread, the sub-actions and the inbox filters were ported
 * from api-worker `src/routes/helpdesk/conversations.ts` plus the (deleted)
 * mobile-api-worker `routes/v1/helpdesk/index.ts`, which owned the status
 * derivation. Before this port app-api was CRUD-only and nothing read or wrote
 * `helpdeskConversationMessages` at all.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, desc, eq, isNotNull, isNull, like, ne, or, sql } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import type { MessageBlock } from '@weldsuite/db/schema';
import { createConversationSchema, updateConversationSchema } from '@weldsuite/core-api-client/schemas/conversations';
import type { Env, Variables } from '../../types';
import { cursorPagination, error, list, noContent, success } from '../../lib/response';
import { generateId } from '../../lib/id';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { schema } from '../../db';
import { sendMessage as sendDiscordMessage, archiveThread as archiveDiscordThread } from '../../lib/discord';
import { dispatchOutbound } from '../../services/helpdesk/channel-dispatch';
import { autoAssignConversation } from '../../services/helpdesk/auto-assignment';
import { getConversationEvents } from '../../services/helpdesk/conversation-events';
import { linkConversationToTicket } from '../../services/helpdesk/conversation-to-ticket';
import {
  autoAssignOnAgentReply,
  conversationExists,
  createAgentJoinedMessage,
  createAgentMessage,
  getConversationForMessaging,
  listConversationMessages,
  recordBlockResponse,
} from '../../services/helpdesk/conversation-messages';
import {
  publishAgentAssigned,
  publishConversationClosed,
  publishMessage,
  publishMessageUpdated,
} from '../../services/realtime/helpdesk-publisher';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
const t = schema.helpdeskConversations;
const people = schema.people;

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const messageAttachmentSchema = z.object({
  id: z.string(),
  fileName: z.string(),
  fileSize: z.number(),
  mimeType: z.string(),
  url: z.string(),
});

const createMessageSchema = z.object({
  content: z.string(),
  contentHtml: z.string().optional(),
  isInternal: z.boolean().optional(),
  authorName: z.string().optional(),
  attachments: z.array(messageAttachmentSchema).optional(),
  // `MessageBlock` is a wide discriminated union (button_group / input_form /
  // rating / file_request / …); mirroring it in Zod here would fork the schema
  // from packages/db. Validated structurally and narrowed at the call site.
  blocks: z.array(z.record(z.unknown())).optional(),
});

const blockResponseSchema = z.object({
  actionId: z.string(),
  value: z.unknown(),
});

const statusSchema = z.object({ status: z.string().min(1) });
const prioritySchema = z.object({ priority: z.string().min(1) });
const readSchema = z.object({ isRead: z.boolean() });
const starSchema = z.object({ isStarred: z.boolean() });
const archiveSchema = z.object({ isArchived: z.boolean() });
const snoozeSchema = z.object({ snoozedUntil: z.string().nullable(), status: z.string().optional() });
const tagsSchema = z.object({
  tags: z.array(z.string()).optional(),
  tag: z.string().optional(),
  action: z.enum(['add', 'remove']).optional(),
});
const contactSchema = z.object({ contactId: z.string().nullable() });
const assignSchema = z.object({
  assigneeId: z.string(),
  assigneeName: z.string().optional(),
  assigneeAvatar: z.string().optional(),
});
const assignTeamSchema = z.object({
  departmentId: z.string(),
  assigneeId: z.string().nullable().optional(),
  assigneeName: z.string().nullable().optional(),
});
const convertToTicketSchema = z.object({
  subject: z.string().optional(),
  priority: z.string().optional(),
  assigneeId: z.string().optional(),
});
const autoLinkContactSchema = z.object({
  email: z.string().email(),
  name: z.string().optional(),
  phone: z.string().optional(),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type ConversationRow = typeof t.$inferSelect;

/**
 * Enrich a conversation row with its linked CRM contact, matching the legacy
 * projection: the contact is the source of truth for name/email/avatar when a
 * `contactId` is set, falling back to the denormalised columns otherwise.
 *
 * The full row is spread first so every column stays on the wire — app-api
 * consumers already read raw rows and must not lose fields to this join.
 */
function withContact(
  conv: ConversationRow,
  contact: { fullName: string | null; email: string | null; avatarUrl: string | null } | null,
) {
  return {
    ...conv,
    customerEmail: contact?.email || conv.customerEmail,
    customerName: contact?.fullName || conv.customerName,
    customerAvatarUrl: contact?.avatarUrl || conv.customerAvatar || undefined,
    tags: conv.tags || [],
    labels: conv.labels || [],
  };
}

/** Archive the Discord ticket thread behind a conversation, best-effort. */
function archiveDiscordThreadIfTicket(
  env: Env,
  conv: Pick<ConversationRow, 'channel' | 'metadata'>,
): Promise<void> | null {
  if (conv.channel !== 'discord' || !env.DISCORD_BOT_TOKEN) return null;
  const metadata = conv.metadata as Record<string, unknown> | null;
  if (!metadata?.isTicket || !metadata?.discordChannelId) return null;

  const threadId = metadata.discordChannelId as string;
  const token = env.DISCORD_BOT_TOKEN;
  return (async () => {
    try {
      await sendDiscordMessage(token, threadId, 'This ticket has been closed by support.');
      await archiveDiscordThread(token, threadId);
    } catch (err) {
      console.error('[app-api/conversations] Failed to archive Discord thread:', err);
    }
  })();
}

/**
 * Status side effects, ported from the deleted mobile-api-worker
 * `PATCH /conversations/:id/status` — the only implementation that had them.
 * A prior review flagged their loss when the platform was repointed at the
 * generic PATCH, which writes exactly what it is given and nothing more.
 */
function statusDerivedFields(status: string): Record<string, unknown> {
  const derived: Record<string, unknown> = {};
  // Leaving the snoozed state must clear the wake-up timestamp, otherwise the
  // conversation re-surfaces when the old snooze expires.
  if (status !== 'snoozed') derived.snoozedUntil = null;
  // `isArchived` is what the inbox lists filter on; keep it in step with status.
  if (status === 'archived') derived.isArchived = true;
  else if (status === 'active' || status === 'pending') derived.isArchived = false;
  return derived;
}

/** Load a conversation, or return null when missing/soft-deleted. */
async function loadConversation(
  db: Variables['tenantDb'],
  id: string,
): Promise<ConversationRow | null> {
  const [row] = await db.select().from(t).where(and(eq(t.id, id), isNull(t.deletedAt))).limit(1);
  return row ?? null;
}

// ===========================================================================
// List
// ===========================================================================

app.get('/', requirePermission('conversations:read'), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const q = c.req.query();
  const limit = Math.min(q.limit ? parseInt(q.limit, 10) : 25, 100);

  const conditions: any[] = [
    isNull(t.deletedAt),
    // Hide chat conversations until the customer has actually said something —
    // an automated workflow greeting alone must not surface in an agent inbox.
    or(ne(t.channel, 'chat'), isNotNull(t.lastCustomerMessageAt))!,
    // Hide conversations whose multi-step workflow (choices, forms) is still
    // running; they are not actionable by an agent until it completes.
    eq(t.hasActiveWorkflow, false),
  ];

  if (q.status !== undefined && q.status !== '') conditions.push(eq(t.status, q.status));
  if (q.excludeStatus !== undefined && q.excludeStatus !== '') conditions.push(ne(t.status, q.excludeStatus));
  if (q.priority !== undefined && q.priority !== '') conditions.push(eq(t.priority, q.priority));
  if (q.channel !== undefined && q.channel !== '') conditions.push(eq(t.channel, q.channel));
  if (q.departmentId !== undefined && q.departmentId !== '') conditions.push(eq(t.departmentId, q.departmentId));
  if (q.contactId !== undefined && q.contactId !== '') conditions.push(eq(t.contactId, q.contactId));
  if (q.customerEmail !== undefined && q.customerEmail !== '') conditions.push(eq(t.customerEmail, q.customerEmail));

  // Assignment filters are mutually exclusive and ordered, matching legacy:
  // `unassigned` wins over `myConversations`, which wins over `assigneeId`.
  if (q.unassigned === 'true') {
    conditions.push(isNull(t.assigneeId));
  } else if (q.myConversations === 'true') {
    conditions.push(or(isNull(t.assigneeId), eq(t.assigneeId, userId))!);
  } else if (q.assigneeId !== undefined && q.assigneeId !== '') {
    conditions.push(eq(t.assigneeId, q.assigneeId));
  }

  if (q.isRead === 'true' || q.isRead === 'false') conditions.push(eq(t.isRead, q.isRead === 'true'));
  if (q.isStarred === 'true' || q.isStarred === 'false') conditions.push(eq(t.isStarred, q.isStarred === 'true'));
  if (q.isArchived === 'true' || q.isArchived === 'false') conditions.push(eq(t.isArchived, q.isArchived === 'true'));

  if (q.search) {
    const term = `%${q.search}%`;
    conditions.push(
      or(
        like(t.subject, term),
        like(t.customerEmail, term),
        like(t.customerName, term),
        like(t.conversationNumber, term),
        like(people.fullName, term),
        like(people.email, term),
      )!,
    );
  }

  if (q.cursor) {
    const [cur] = await db
      .select({ createdAt: t.createdAt, id: t.id })
      .from(t).where(eq(t.id, q.cursor)).limit(1);
    if (cur?.createdAt) {
      conditions.push(
        sql`(${t.createdAt} < ${cur.createdAt} OR (${t.createdAt} = ${cur.createdAt} AND ${t.id} < ${cur.id}))`,
      );
    }
  }
  const where = conditions.length ? and(...conditions) : undefined;
  const filterConditions = q.cursor ? conditions.slice(0, -1) : conditions;
  const countWhere = filterConditions.length ? and(...filterConditions) : undefined;

  try {
    const [rows, countRes] = await Promise.all([
      db
        .select({
          conversation: t,
          contactName: people.fullName,
          contactEmail: people.email,
          contactAvatarUrl: people.avatarUrl,
        })
        .from(t)
        .leftJoin(people, eq(t.contactId, people.id))
        .where(where)
        .orderBy(desc(t.createdAt), desc(t.id))
        .limit(limit + 1),
      db
        .select({ count: sql<number>`count(*)` })
        .from(t)
        .leftJoin(people, eq(t.contactId, people.id))
        .where(countWhere),
    ]);
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const data = page.map((r) =>
      withContact(r.conversation, {
        fullName: r.contactName,
        email: r.contactEmail,
        avatarUrl: r.contactAvatarUrl,
      }),
    );
    const nextCursor = hasMore && page.length > 0 ? page[page.length - 1].conversation.id : null;
    const totalCount = Number(countRes[0]?.count ?? 0);
    return list(c, data, cursorPagination(totalCount, hasMore, nextCursor));
  } catch (err) {
    console.error('[app-api/conversations] list failed:', err);
    return error.internal(c, 'Failed to list conversations');
  }
});

// ===========================================================================
// Folder counts — must stay above /:id so it is not swallowed by the param.
// ===========================================================================

app.get('/folder-counts', requirePermission('conversations:read'), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  try {
    const [result] = await db
      .select({
        all: sql<number>`count(*) filter (where ${t.isRead} = false and (${t.assigneeId} is null or ${t.assigneeId} = ${userId}))::int`,
        chat: sql<number>`count(*) filter (where ${t.isRead} = false and ${t.channel} = 'chat' and (${t.assigneeId} is null or ${t.assigneeId} = ${userId}))::int`,
        unassigned: sql<number>`count(*) filter (where ${t.isRead} = false and ${t.assigneeId} is null)::int`,
        mine: sql<number>`count(*) filter (where ${t.isRead} = false and ${t.assigneeId} = ${userId})::int`,
        active: sql<number>`count(*) filter (where ${t.status} = 'active')::int`,
        pending: sql<number>`count(*) filter (where ${t.status} = 'pending')::int`,
        resolved: sql<number>`count(*) filter (where ${t.status} = 'resolved')::int`,
        closed: sql<number>`count(*) filter (where ${t.status} = 'closed')::int`,
      })
      .from(t)
      .where(and(isNull(t.deletedAt), eq(t.isArchived, false)));

    return success(c, {
      all: result?.all || 0,
      chat: result?.chat || 0,
      unassigned: result?.unassigned || 0,
      mine: result?.mine || 0,
      active: result?.active || 0,
      pending: result?.pending || 0,
      resolved: result?.resolved || 0,
      closed: result?.closed || 0,
    });
  } catch (err) {
    console.error('[app-api/conversations] folder-counts failed:', err);
    return error.internal(c, 'Failed to fetch folder counts');
  }
});

// ===========================================================================
// Read
// ===========================================================================

app.get('/:id', requirePermission('conversations:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const [row] = await db
      .select({
        conversation: t,
        contactName: people.fullName,
        contactEmail: people.email,
        contactAvatarUrl: people.avatarUrl,
      })
      .from(t)
      .leftJoin(people, eq(t.contactId, people.id))
      .where(and(eq(t.id, id), isNull(t.deletedAt)))
      .limit(1);
    if (!row) return error.notFound(c, 'Conversation', id);
    return success(
      c,
      withContact(row.conversation, {
        fullName: row.contactName,
        email: row.contactEmail,
        avatarUrl: row.contactAvatarUrl,
      }),
    );
  } catch (err) {
    console.error('[app-api/conversations] get failed:', err);
    return error.internal(c, 'Failed to fetch conversation');
  }
});

// ===========================================================================
// Messages
// ===========================================================================

app.get('/:id/messages', requirePermission('conversations:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    if (!(await conversationExists(db, id))) return error.notFound(c, 'Conversation', id);
    return success(c, await listConversationMessages(db, id));
  } catch (err) {
    console.error('[app-api/conversations] list messages failed:', err);
    return error.internal(c, 'Failed to fetch messages');
  }
});

app.post(
  '/:id/messages',
  requirePermission('conversations:update'),
  zValidator('json', createMessageSchema),
  async (c) => {
    const db = c.get('tenantDb');
    const userId = c.get('userId');
    const id = c.req.param('id');
    const body = c.req.valid('json');

    try {
      const conversation = await getConversationForMessaging(db, id);
      if (!conversation) return error.notFound(c, 'Conversation', id);

      const authorName = body.authorName || 'Agent';
      const isInternal = body.isInternal || false;

      const autoAssigned = await autoAssignOnAgentReply(
        db,
        id,
        conversation.assigneeId,
        userId,
        authorName,
        isInternal,
      );

      if (autoAssigned) {
        publishEntityEvent({
          c,
          entityType: 'helpdesk_conversation',
          entityId: id,
          action: 'assigned',
          data: { id, assigneeId: userId },
        });
        c.executionCtx.waitUntil(
          publishAgentAssigned(c.env, id, {
            conversationId: id,
            agentId: userId,
            agentName: authorName,
            assignedAt: new Date().toISOString(),
          }).catch((err) =>
            console.error('[app-api/conversations] agent_assigned publish failed:', err),
          ),
        );
      }

      const message = await createAgentMessage(db, {
        conversationId: id,
        authorId: userId,
        authorName,
        content: body.content,
        contentHtml: body.contentHtml,
        isInternal,
        attachments: body.attachments,
        // Legacy DROPPED blocks on insert even though the client sent them and
        // the column exists — which also made `/messages/:id/respond` dead for
        // agent-sent blocks (it matches on `message.blocks`). Persisted here.
        blocks: body.blocks as unknown as MessageBlock[] | undefined,
      });

      publishEntityEvent({
        c,
        entityType: 'helpdesk_conversation_message',
        entityId: message.id,
        action: 'created',
        data: {
          id: message.id,
          conversationId: id,
          authorId: userId,
          authorType: 'agent',
          content: body.content,
          isInternal,
        },
      });

      // Internal notes never leave the workspace — no widget push, no dispatch.
      if (!isInternal) {
        c.executionCtx.waitUntil(
          publishMessage(c.env, id, {
            id: message.id,
            conversationId: id,
            content: body.content,
            senderId: userId,
            senderName: authorName,
            senderType: 'agent',
            attachments: body.attachments,
          }).catch((err) =>
            console.error('[app-api/conversations] message publish failed:', err),
          ),
        );
      }

      c.executionCtx.waitUntil(
        dispatchOutbound(
          c.env,
          db,
          {
            id,
            channel: conversation.channel,
            subject: conversation.subject,
            customerEmail: conversation.customerEmail,
            metadata: conversation.metadata as Record<string, unknown> | null,
          },
          {
            id: message.id,
            content: body.content,
            contentHtml: body.contentHtml,
            authorName: body.authorName,
            isInternal,
          },
        ).catch((err) => console.error('[app-api/conversations] channel dispatch failed:', err)),
      );

      return success(c, message, 201);
    } catch (err) {
      console.error('[app-api/conversations] send message failed:', err);
      return error.internal(c, 'Failed to send message');
    }
  },
);

app.patch(
  '/:id/messages/:messageId/respond',
  requirePermission('conversations:update'),
  zValidator('json', blockResponseSchema),
  async (c) => {
    const db = c.get('tenantDb');
    const id = c.req.param('id');
    const messageId = c.req.param('messageId');
    const { actionId, value } = c.req.valid('json');

    try {
      const result = await recordBlockResponse(db, id, messageId, actionId, value);
      if (!result.ok) {
        if (result.reason === 'not_found') return error.notFound(c, 'Message', messageId);
        if (result.reason === 'no_such_action') {
          return error.badRequest(c, `No interactive block with actionId "${actionId}"`);
        }
        return error.badRequest(c, 'This interaction has already been responded to');
      }

      publishEntityEvent({
        c,
        entityType: 'helpdesk_conversation_message',
        entityId: messageId,
        action: 'updated',
        data: { id: messageId, conversationId: id },
      });

      c.executionCtx.waitUntil(
        publishMessageUpdated(c.env, id, {
          messageId,
          blockResponses: result.blockResponses,
        }).catch((err) =>
          console.error('[app-api/conversations] block response publish failed:', err),
        ),
      );

      return success(c, { messageId, blockResponses: result.blockResponses });
    } catch (err) {
      console.error('[app-api/conversations] block response failed:', err);
      return error.internal(c, 'Failed to process block response');
    }
  },
);

// ===========================================================================
// Events / review / audit logs
// ===========================================================================

app.get('/:id/events', requirePermission('conversations:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const eventType = c.req.query('type');
  const isPublicStr = c.req.query('isPublic');

  try {
    const events = await getConversationEvents(db, id, {
      eventType: eventType || undefined,
      isPublic: isPublicStr !== undefined ? isPublicStr === 'true' : undefined,
      limit: 200,
    });
    return success(c, events);
  } catch (err) {
    console.error('[app-api/conversations] events failed:', err);
    return error.internal(c, 'Failed to fetch conversation events');
  }
});

app.get('/:id/review', requirePermission('conversations:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const { helpdeskReviews } = schema;
  try {
    const [review] = await db
      .select()
      .from(helpdeskReviews)
      .where(and(eq(helpdeskReviews.conversationId, id), isNull(helpdeskReviews.deletedAt)))
      .limit(1);

    // A conversation with no CSAT response is normal, not a 404.
    if (!review) return success(c, null);

    return success(c, {
      id: review.id,
      rating: review.rating,
      content: review.content,
      reviewerName: review.reviewerName,
      reviewerEmail: review.reviewerEmail,
      createdAt: review.createdAt?.toISOString(),
    });
  } catch (err) {
    console.error('[app-api/conversations] review failed:', err);
    return error.internal(c, 'Failed to fetch review');
  }
});

app.get('/:id/audit-logs', requirePermission('conversations:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const { auditLogs } = schema;
  try {
    const logs = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityType, 'helpdesk_conversation'), eq(auditLogs.entityId, id)))
      .orderBy(desc(auditLogs.createdAt));
    return success(c, logs);
  } catch (err) {
    console.error('[app-api/conversations] audit-logs failed:', err);
    return error.internal(c, 'Failed to fetch audit logs');
  }
});

// ===========================================================================
// Create / update / delete
// ===========================================================================

app.post('/', requirePermission('conversations:create'), zValidator('json', createConversationSchema), async (c) => {
  const db = c.get('tenantDb');
  const data = c.req.valid('json') as Record<string, any>;
  const id = generateId('conv');
  const now = new Date();
  try {
    await db.insert(t).values({ id, ...data, createdAt: now, updatedAt: now } as unknown as typeof t.$inferInsert);
    publishEntityEvent({
      c,
      entityType: 'helpdesk_conversation',
      entityId: id,
      action: 'created',
      data: { id, conversationNumber: data.conversationNumber, subject: data.subject, status: data.status, priority: data.priority, assigneeId: data.assigneeId, contactId: data.contactId, departmentId: data.departmentId },
    });
    return success(c, { id }, 201);
  } catch (err) {
    console.error('[app-api/conversations] create failed:', err);
    return error.internal(c, 'Failed to create conversation');
  }
});

app.patch('/:id', requirePermission('conversations:update'), zValidator('json', updateConversationSchema), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const data = c.req.valid('json') as Record<string, any>;
  try {
    const existing = await loadConversation(db, id);
    if (!existing) return error.notFound(c, 'Conversation', id);
    const update: Record<string, any> = { updatedAt: new Date() };
    for (const [k, v] of Object.entries(data)) if (v !== undefined) update[k] = v;
    // A status written through the generic PATCH must derive the same fields as
    // PATCH /:id/status — otherwise `snoozedUntil` / `isArchived` silently drift
    // depending on which endpoint the caller happened to use.
    if (typeof update.status === 'string') {
      Object.assign(update, statusDerivedFields(update.status), {
        // An explicit isArchived in the body still wins over the derivation.
        ...(data.isArchived !== undefined ? { isArchived: data.isArchived } : {}),
      });
    }
    await db.update(t).set(update).where(and(eq(t.id, id), isNull(t.deletedAt)));
    publishEntityEvent({
      c,
      entityType: 'helpdesk_conversation',
      entityId: id,
      action: 'updated',
      data: {
        id,
        conversationNumber: existing.conversationNumber,
        subject: (update.subject as string | null | undefined) ?? existing.subject,
        status: (update.status as string | null | undefined) ?? existing.status,
        priority: (update.priority as string | null | undefined) ?? existing.priority,
        assigneeId: (update.assigneeId as string | null | undefined) ?? existing.assigneeId,
        contactId: existing.contactId,
        departmentId: (update.departmentId as string | null | undefined) ?? existing.departmentId,
      },
    });
    return success(c, { id });
  } catch (err) {
    console.error('[app-api/conversations] update failed:', err);
    return error.internal(c, 'Failed to update conversation');
  }
});

app.delete('/:id', requirePermission('conversations:delete'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const existing = await loadConversation(db, id);
    if (!existing) return error.notFound(c, 'Conversation', id);
    await db.update(t).set({ deletedAt: new Date(), updatedAt: new Date() }).where(eq(t.id, id));
    publishEntityEvent({
      c,
      entityType: 'helpdesk_conversation',
      entityId: id,
      action: 'deleted',
      data: { id, conversationNumber: existing.conversationNumber, subject: existing.subject, status: existing.status },
    });
    return noContent(c);
  } catch (err) {
    console.error('[app-api/conversations] delete failed:', err);
    return error.internal(c, 'Failed to delete conversation');
  }
});

// ===========================================================================
// Sub-actions
// ===========================================================================

app.patch('/:id/status', requirePermission('conversations:update'), zValidator('json', statusSchema), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const id = c.req.param('id');
  const { status } = c.req.valid('json');

  try {
    const existing = await loadConversation(db, id);
    if (!existing) return error.notFound(c, 'Conversation', id);

    const now = new Date();
    const update: Record<string, unknown> = { status, updatedAt: now, ...statusDerivedFields(status) };
    if (status === 'resolved') update.resolvedAt = now;
    if (status === 'closed') update.closedAt = now;

    const [conv] = await db
      .update(t)
      .set(update)
      .where(and(eq(t.id, id), isNull(t.deletedAt)))
      .returning();

    publishEntityEvent({
      c,
      entityType: 'helpdesk_conversation',
      entityId: id,
      action: status === 'closed' ? 'closed' : status === 'resolved' ? 'resolved' : 'updated',
      data: { id, status },
    });

    if (status === 'closed' || status === 'resolved') {
      c.executionCtx.waitUntil(
        publishConversationClosed(c.env, id, {
          conversationId: id,
          closedBy: userId,
          closedByType: 'agent',
          closedAt: now.toISOString(),
        }).catch((err) =>
          console.error('[app-api/conversations] conversation_closed publish failed:', err),
        ),
      );
      const archive = archiveDiscordThreadIfTicket(c.env, conv);
      if (archive) c.executionCtx.waitUntil(archive);
    }

    return success(c, {
      id: conv.id,
      status: conv.status,
      isArchived: conv.isArchived,
      snoozedUntil: conv.snoozedUntil?.toISOString() ?? null,
      updatedAt: conv.updatedAt?.toISOString(),
    });
  } catch (err) {
    console.error('[app-api/conversations] status failed:', err);
    return error.internal(c, 'Failed to update status');
  }
});

app.post('/:id/close', requirePermission('conversations:update'), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const id = c.req.param('id');

  try {
    const existing = await loadConversation(db, id);
    if (!existing) return error.notFound(c, 'Conversation', id);

    const now = new Date();
    const [conv] = await db
      .update(t)
      .set({ status: 'closed', closedAt: now, updatedAt: now, ...statusDerivedFields('closed') })
      .where(and(eq(t.id, id), isNull(t.deletedAt)))
      .returning();

    publishEntityEvent({
      c,
      entityType: 'helpdesk_conversation',
      entityId: id,
      action: 'closed',
      data: { id, status: 'closed' },
    });

    c.executionCtx.waitUntil(
      publishConversationClosed(c.env, id, {
        conversationId: id,
        closedBy: userId,
        closedByType: 'agent',
        closedAt: now.toISOString(),
      }).catch((err) =>
        console.error('[app-api/conversations] conversation_closed publish failed:', err),
      ),
    );

    const archive = archiveDiscordThreadIfTicket(c.env, conv);
    if (archive) c.executionCtx.waitUntil(archive);

    return success(c, {
      id: conv.id,
      status: conv.status,
      updatedAt: conv.updatedAt?.toISOString(),
    });
  } catch (err) {
    console.error('[app-api/conversations] close failed:', err);
    return error.internal(c, 'Failed to close conversation');
  }
});

app.patch('/:id/read', requirePermission('conversations:update'), zValidator('json', readSchema), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const { isRead } = c.req.valid('json');

  try {
    const existing = await loadConversation(db, id);
    if (!existing) return error.notFound(c, 'Conversation', id);

    const [conv] = await db
      .update(t)
      // Marking read zeroes the badge; marking unread leaves the count alone
      // so the original unread total survives a toggle.
      .set({ isRead, ...(isRead ? { unreadCount: 0 } : {}), updatedAt: new Date() })
      .where(and(eq(t.id, id), isNull(t.deletedAt)))
      .returning();

    // The catalog's ConversationEventData has no isRead/isStarred/isArchived —
    // read-state is not part of the published contract, so subscribers re-read
    // the row. Legacy stuffed the flag in anyway; the typed publisher rejects it.
    publishEntityEvent({
      c,
      entityType: 'helpdesk_conversation',
      entityId: id,
      action: 'updated',
      data: { id },
    });

    return success(c, {
      id: conv.id,
      isRead: conv.isRead,
      unreadCount: conv.unreadCount,
      updatedAt: conv.updatedAt?.toISOString(),
    });
  } catch (err) {
    console.error('[app-api/conversations] read failed:', err);
    return error.internal(c, 'Failed to update read status');
  }
});

app.patch('/:id/star', requirePermission('conversations:update'), zValidator('json', starSchema), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const { isStarred } = c.req.valid('json');

  try {
    const existing = await loadConversation(db, id);
    if (!existing) return error.notFound(c, 'Conversation', id);

    const [conv] = await db
      .update(t)
      .set({ isStarred, updatedAt: new Date() })
      .where(and(eq(t.id, id), isNull(t.deletedAt)))
      .returning();

    publishEntityEvent({
      c,
      entityType: 'helpdesk_conversation',
      entityId: id,
      action: 'updated',
      data: { id },
    });

    return success(c, {
      id: conv.id,
      isStarred: conv.isStarred,
      updatedAt: conv.updatedAt?.toISOString(),
    });
  } catch (err) {
    console.error('[app-api/conversations] star failed:', err);
    return error.internal(c, 'Failed to update star');
  }
});

app.patch('/:id/archive', requirePermission('conversations:update'), zValidator('json', archiveSchema), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const { isArchived } = c.req.valid('json');

  try {
    const existing = await loadConversation(db, id);
    if (!existing) return error.notFound(c, 'Conversation', id);

    // Archiving forces status='archived'; un-archiving returns the conversation
    // to 'active' (legacy left a stale 'archived' status behind on unarchive,
    // which the isArchived/status derivation now makes impossible).
    const [conv] = await db
      .update(t)
      .set({ isArchived, status: isArchived ? 'archived' : 'active', updatedAt: new Date() })
      .where(and(eq(t.id, id), isNull(t.deletedAt)))
      .returning();

    publishEntityEvent({
      c,
      entityType: 'helpdesk_conversation',
      entityId: id,
      action: 'updated',
      data: { id, status: conv.status },
    });

    return success(c, {
      id: conv.id,
      isArchived: conv.isArchived,
      status: conv.status,
      updatedAt: conv.updatedAt?.toISOString(),
    });
  } catch (err) {
    console.error('[app-api/conversations] archive failed:', err);
    return error.internal(c, 'Failed to archive conversation');
  }
});

app.patch('/:id/priority', requirePermission('conversations:update'), zValidator('json', prioritySchema), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const { priority } = c.req.valid('json');

  try {
    const existing = await loadConversation(db, id);
    if (!existing) return error.notFound(c, 'Conversation', id);

    const [conv] = await db
      .update(t)
      .set({ priority, updatedAt: new Date() })
      .where(and(eq(t.id, id), isNull(t.deletedAt)))
      .returning();

    publishEntityEvent({
      c,
      entityType: 'helpdesk_conversation',
      entityId: id,
      action: 'updated',
      data: { id, priority },
    });

    return success(c, {
      id: conv.id,
      priority: conv.priority,
      updatedAt: conv.updatedAt?.toISOString(),
    });
  } catch (err) {
    console.error('[app-api/conversations] priority failed:', err);
    return error.internal(c, 'Failed to update priority');
  }
});

app.patch('/:id/assign', requirePermission('conversations:update'), zValidator('json', assignSchema), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const body = c.req.valid('json');

  try {
    const existing = await loadConversation(db, id);
    if (!existing) return error.notFound(c, 'Conversation', id);

    // Already assigned to this agent — return early so a re-assign does not
    // emit a second "joined the conversation" message.
    if (existing.assigneeId === body.assigneeId) {
      return success(c, {
        id,
        assigneeId: existing.assigneeId,
        assigneeName: existing.assigneeName,
        updatedAt: existing.updatedAt?.toISOString(),
      });
    }

    const update: Record<string, unknown> = { assigneeId: body.assigneeId, updatedAt: new Date() };
    if (body.assigneeName) update.assigneeName = body.assigneeName;
    if (body.assigneeAvatar) update.assigneeAvatar = body.assigneeAvatar;

    // Conditional update guards against two concurrent assigns racing to the
    // same agent — the loser updates zero rows and skips the system message.
    const updated = await db
      .update(t)
      .set(update)
      .where(
        and(
          eq(t.id, id),
          isNull(t.deletedAt),
          or(isNull(t.assigneeId), ne(t.assigneeId, body.assigneeId)),
        ),
      )
      .returning();

    if (updated.length === 0) {
      const current = await loadConversation(db, id);
      return success(c, {
        id,
        assigneeId: current?.assigneeId,
        assigneeName: current?.assigneeName,
        updatedAt: current?.updatedAt?.toISOString(),
      });
    }

    const conv = updated[0];
    const agentName = body.assigneeName || 'Agent';

    publishEntityEvent({
      c,
      entityType: 'helpdesk_conversation',
      entityId: id,
      action: 'assigned',
      data: { id, assigneeId: body.assigneeId },
    });

    // Persisted so "agent joined" survives a page refresh, not just the socket.
    const systemMessage = await createAgentJoinedMessage(db, id, body.assigneeId, agentName);

    c.executionCtx.waitUntil(
      Promise.all([
        publishAgentAssigned(c.env, id, {
          conversationId: id,
          agentId: body.assigneeId,
          agentName,
          agentAvatar: body.assigneeAvatar,
          assignedAt: systemMessage.createdAt.toISOString(),
        }),
        publishMessage(c.env, id, {
          id: systemMessage.id,
          conversationId: id,
          content: systemMessage.content,
          senderType: 'system',
          senderId: body.assigneeId,
          senderName: agentName,
        }),
      ]).catch((err) => console.error('[app-api/conversations] assign publish failed:', err)),
    );

    return success(c, {
      id: conv.id,
      assigneeId: conv.assigneeId,
      assigneeName: conv.assigneeName,
      updatedAt: conv.updatedAt?.toISOString(),
    });
  } catch (err) {
    console.error('[app-api/conversations] assign failed:', err);
    return error.internal(c, 'Failed to assign conversation');
  }
});

/**
 * PATCH /:id/assign-team — hand a conversation to a department.
 *
 * Ported from api-worker `PATCH /helpdesk/conversations/:id/assign-team`, gate
 * unchanged (`conversations:update`, a tier MEMBER holds — transferring is a
 * routine inbox action, not an admin one).
 *
 * Not expressible as `PATCH /:id { departmentId }`: setting the department also
 * *clears* the current assignee (the conversation drops into the team queue),
 * and then hands it to the team's next agent via `autoAssignConversation` when
 * the department has auto-assignment on. Routing the transfer picker at the
 * generic PATCH would set the department and quietly strand the conversation.
 *
 * An explicit `assigneeId` in the body pins the conversation to that agent and
 * skips auto-assignment entirely.
 */
app.patch('/:id/assign-team', requirePermission('conversations:update'), zValidator('json', assignTeamSchema), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const body = c.req.valid('json');

  try {
    const existing = await loadConversation(db, id);
    if (!existing) return error.notFound(c, 'Conversation', id);

    const update: Record<string, unknown> = {
      departmentId: body.departmentId,
      updatedAt: new Date(),
    };

    if (body.assigneeId) {
      update.assigneeId = body.assigneeId;
      if (body.assigneeName) update.assigneeName = body.assigneeName;
    } else {
      // No explicit assignee — the conversation sits in the team queue until
      // auto-assignment (below) picks it up.
      update.assigneeId = null;
      update.assigneeName = null;
    }

    await db.update(t).set(update).where(and(eq(t.id, id), isNull(t.deletedAt)));

    let autoAssigned: { assigneeId: string; assigneeName: string } | null = null;
    if (!body.assigneeId) {
      autoAssigned = await autoAssignConversation(db, body.departmentId, id);
    }

    // Re-read: `autoAssignConversation` writes the assignee itself, so the row
    // above is stale by the time we report it.
    const conv = await loadConversation(db, id);
    if (!conv) return error.notFound(c, 'Conversation', id);

    publishEntityEvent({
      c,
      entityType: 'helpdesk_conversation',
      entityId: id,
      action: 'updated',
      data: {
        id,
        departmentId: body.departmentId,
        assigneeId: conv.assigneeId,
      },
    });

    return success(c, {
      id: conv.id,
      departmentId: conv.departmentId,
      assigneeId: conv.assigneeId,
      assigneeName: conv.assigneeName,
      autoAssigned: !!autoAssigned,
      updatedAt: conv.updatedAt?.toISOString(),
    });
  } catch (err) {
    console.error('[app-api/conversations] assign-team failed:', err);
    return error.internal(c, 'Failed to assign conversation to team');
  }
});

/**
 * POST /:id/convert-to-ticket — raise a ticket from a conversation.
 *
 * Ported from api-worker `POST /helpdesk/conversations/:id/convert-to-ticket`,
 * gate unchanged (`conversations:update`).
 *
 * Server-side because it is not one write: the ticket carries fields across
 * from the conversation (contact, channel, department, tags, assignee), and the
 * conversation is annotated with the link. Doing it from the client would be
 * non-atomic and would leave the carry-over to whichever caller remembered it.
 *
 * The link itself goes through the shared `linkConversationToTicket` — the same
 * path `POST /api/tickets { conversationId }` takes — so both doors onto this
 * operation produce the same result. See that service for why the dropped
 * `ticket_id` column is not written (api-worker still tries, and 500s here
 * *after* inserting the ticket).
 */
app.post('/:id/convert-to-ticket', requirePermission('conversations:update'), zValidator('json', convertToTicketSchema), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const body = c.req.valid('json');
  const tickets = schema.helpdeskTickets;

  try {
    const [row] = await db
      .select({
        conversation: t,
        contactName: people.fullName,
        contactEmail: people.email,
      })
      .from(t)
      .leftJoin(people, eq(t.contactId, people.id))
      .where(and(eq(t.id, id), isNull(t.deletedAt)))
      .limit(1);

    if (!row) return error.notFound(c, 'Conversation', id);

    const { conversation: conv, contactName, contactEmail } = row;

    const ticketId = generateId('tkt');
    const ticketNumber = `TKT-${Date.now().toString(36).toUpperCase()}`;
    const now = new Date();
    const subject = body.subject || conv.subject;
    const priority = body.priority || conv.priority || 'normal';
    const customerName = contactName || conv.customerName;
    // `helpdesk_conversations.customer_email` is nullable but
    // `helpdesk_tickets.customer_email` is NOT NULL. api-worker passed the null
    // straight through and 500'd on channels that carry no email (Discord,
    // in-app chat); '' keeps the conversion working for them.
    const customerEmail = contactEmail || conv.customerEmail || '';

    await db.insert(tickets).values({
      id: ticketId,
      ticketNumber,
      subject,
      description: conv.lastMessage || '',
      priority,
      status: 'open',
      category: 'general_inquiry',
      channel: conv.channel,
      customerEmail,
      customerName,
      contactId: conv.contactId,
      assigneeId: body.assigneeId || conv.assigneeId,
      departmentId: conv.departmentId,
      tags: conv.tags || [],
      createdAt: now,
      updatedAt: now,
    });

    await linkConversationToTicket(c.env, db, {
      conversationId: id,
      ticketId,
      ticketNumber,
      subject,
      priority,
      customerName,
      customerEmail,
      contactId: conv.contactId,
      now,
    });

    publishEntityEvent({
      c,
      entityType: 'helpdesk_conversation',
      entityId: id,
      action: 'updated',
      data: { id, conversationNumber: conv.conversationNumber, subject: conv.subject, status: conv.status },
    });

    publishEntityEvent({
      c,
      entityType: 'ticket',
      entityId: ticketId,
      action: 'created',
      data: { id: ticketId, ticketNumber, subject, status: 'open', priority, departmentId: conv.departmentId },
    });

    return success(
      c,
      {
        id: ticketId,
        ticketNumber,
        subject,
        status: 'open',
        priority,
        conversationId: id,
        createdAt: now.toISOString(),
      },
      201,
    );
  } catch (err) {
    console.error('[app-api/conversations] convert-to-ticket failed:', err);
    return error.internal(c, 'Failed to convert to ticket');
  }
});

app.patch('/:id/snooze', requirePermission('conversations:update'), zValidator('json', snoozeSchema), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const body = c.req.valid('json');

  try {
    const existing = await loadConversation(db, id);
    if (!existing) return error.notFound(c, 'Conversation', id);

    const status = body.status || 'snoozed';
    const [conv] = await db
      .update(t)
      .set({
        snoozedUntil: body.snoozedUntil ? new Date(body.snoozedUntil) : null,
        status,
        updatedAt: new Date(),
      })
      .where(and(eq(t.id, id), isNull(t.deletedAt)))
      .returning();

    publishEntityEvent({
      c,
      entityType: 'helpdesk_conversation',
      entityId: id,
      action: 'updated',
      data: { id, status },
    });

    return success(c, {
      id: conv.id,
      snoozedUntil: conv.snoozedUntil?.toISOString() ?? null,
      status: conv.status,
      updatedAt: conv.updatedAt?.toISOString(),
    });
  } catch (err) {
    console.error('[app-api/conversations] snooze failed:', err);
    return error.internal(c, 'Failed to snooze conversation');
  }
});

app.patch('/:id/tags', requirePermission('conversations:update'), zValidator('json', tagsSchema), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const body = c.req.valid('json');

  try {
    const existing = await loadConversation(db, id);
    if (!existing) return error.notFound(c, 'Conversation', id);

    const existingTags = existing.tags || [];
    let newTags: string[];
    if (body.action === 'remove' && body.tag) {
      newTags = existingTags.filter((tag) => tag !== body.tag);
    } else if (body.action === 'add' && body.tags) {
      newTags = [...new Set([...existingTags, ...body.tags])];
    } else if (body.tags) {
      newTags = body.tags;
    } else {
      newTags = existingTags;
    }

    const [conv] = await db
      .update(t)
      .set({ tags: newTags, updatedAt: new Date() })
      .where(and(eq(t.id, id), isNull(t.deletedAt)))
      .returning();

    publishEntityEvent({
      c,
      entityType: 'helpdesk_conversation',
      entityId: id,
      action: 'updated',
      data: { id },
    });

    return success(c, {
      id: conv.id,
      tags: conv.tags || [],
      updatedAt: conv.updatedAt?.toISOString(),
    });
  } catch (err) {
    console.error('[app-api/conversations] tags failed:', err);
    return error.internal(c, 'Failed to update tags');
  }
});

app.patch('/:id/contact', requirePermission('conversations:update'), zValidator('json', contactSchema), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const { contactId } = c.req.valid('json');

  try {
    const existing = await loadConversation(db, id);
    if (!existing) return error.notFound(c, 'Conversation', id);

    const [conv] = await db
      .update(t)
      .set({ contactId, updatedAt: new Date() })
      .where(and(eq(t.id, id), isNull(t.deletedAt)))
      .returning();

    publishEntityEvent({
      c,
      entityType: 'helpdesk_conversation',
      entityId: id,
      action: 'updated',
      data: { id, contactId },
    });

    return success(c, {
      id: conv.id,
      contactId: conv.contactId,
      updatedAt: conv.updatedAt?.toISOString(),
    });
  } catch (err) {
    console.error('[app-api/conversations] contact failed:', err);
    return error.internal(c, 'Failed to update contact');
  }
});

/**
 * Find-or-create a CRM contact by email and link it to the conversation.
 * The detail page fires this on mount for any conversation that arrived
 * without a contactId (inbound email/Discord/Slack).
 */
app.post(
  '/:id/auto-link-contact',
  requirePermission('conversations:update'),
  zValidator('json', autoLinkContactSchema),
  async (c) => {
    const db = c.get('tenantDb');
    const id = c.req.param('id');
    const body = c.req.valid('json');

    try {
      if (!(await conversationExists(db, id))) return error.notFound(c, 'Conversation', id);

      const [match] = await db
        .select({ id: people.id })
        .from(people)
        .where(and(eq(people.email, body.email), isNull(people.deletedAt)))
        .limit(1);

      let contactId: string;
      if (match) {
        contactId = match.id;
      } else {
        contactId = generateId('cont');
        const fullName = body.name || body.email.split('@')[0];
        const nameParts = fullName.split(' ');
        const now = new Date();
        await db.insert(people).values({
          id: contactId,
          firstName: nameParts[0] || fullName,
          lastName: nameParts.length > 1 ? nameParts.slice(1).join(' ') : '',
          fullName,
          // NOT NULL with no default, and the column renderers actually read.
          // The legacy insert omitted it, so this path was throwing a NOT NULL
          // violation against the current schema — see the W5b report.
          displayName: fullName,
          email: body.email,
          directPhone: body.phone || null,
          status: 'active',
          // Auto-created from an inbound helpdesk conversation — linked to the
          // conversation but kept out of the CRM until a user explicitly adds
          // them via the person panel's "Add to CRM" button.
          inCrm: false,
          createdAt: now,
          updatedAt: now,
        });
      }

      await db.update(t).set({ contactId, updatedAt: new Date() }).where(eq(t.id, id));

      publishEntityEvent({
        c,
        entityType: 'helpdesk_conversation',
        entityId: id,
        action: 'updated',
        data: { id, contactId },
      });

      return success(c, { contactId });
    } catch (err) {
      console.error('[app-api/conversations] auto-link-contact failed:', err);
      return error.internal(c, 'Failed to auto-link contact');
    }
  },
);

export const conversationsRoutes = app;
