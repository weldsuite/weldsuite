/**
 * Channel routes — flat /api/channels/* surface backed by `chatChannels`.
 *
 * Permissions: channels:read | channels:create | channels:update | channels:delete.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, asc, desc, eq, gt, isNull, like, lt, or, sql } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import { updateChannelMembershipSchema } from '@weldsuite/app-api-client/schemas/chat-dm';
import { publishEntityEvent } from '@weldsuite/entity-events';
import type { Env, Variables } from '../../types';
import { cursorPagination, error, list, noContent, success } from '../../lib/response';
import { schema } from '../../db';
import { postChatMessage } from '../../services/chat/post-message';
import { setChannelMuted } from '../../services/chat/dm-membership';
import { canAccessChannel } from '../../services/chat/channel-access';
import { createChannel, slugifyChannelName } from '../../services/chat/create-channel';
import {
  addChannelMembers,
  getMembership,
  joinPublicChannel,
  removeChannelMemberByUserId,
} from '../../services/chat/channel-members';
import {
  getChannelReadReceipts,
  getReaderProfile,
  markChannelRead,
  markChannelUnreadFrom,
} from '../../services/chat/channel-reads';
import { forwardMessage } from '../../services/chat/forward-message';
import {
  publishChatChannelUpdated,
  publishChatMemberJoined,
  publishChatMemberLeft,
  publishChatReadUpdated,
  publishChatUnreadUpdate,
  publishChatUserChannelNew,
} from '../../services/realtime/weldchat-publisher';
import { RealtimePublisher } from '@weldsuite/realtime/server';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
const t = schema.chatChannels;

// ---------------------------------------------------------------------------
// Local request schemas.
//
// The `@weldsuite/core-api-client` channel schemas are `.passthrough()` shells:
// spread straight into Drizzle they let a caller write arbitrary columns, and
// the create dialog's `memberIds` array (not a column) took the insert down
// with it. These mirror the legacy api-worker schemas instead — an explicit
// field list, nothing else reaches the DB.
// ---------------------------------------------------------------------------

const createChannelBodySchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().optional(),
  topic: z.string().optional(),
  type: z.enum(['public', 'private']).default('public'),
  icon: z.string().max(50).optional(),
  sectionId: z.string().optional(),
  memberIds: z.array(z.string()).optional(),
});

const updateChannelBodySchema = z.object({
  name: z.string().min(1).max(255).optional(),
  description: z.string().optional(),
  topic: z.string().optional(),
  icon: z.string().max(50).optional(),
  voiceCallsEnabled: z.boolean().optional(),
  videoCallsEnabled: z.boolean().optional(),
  threadsEnabled: z.boolean().optional(),
  attachmentsEnabled: z.boolean().optional(),
  reactionsEnabled: z.boolean().optional(),
  slowModeSeconds: z.number().int().min(0).max(21600).optional(),
  // Not on the legacy update schema, but both are reachable today through this
  // route (useArchiveChannel / useAssignChannelToSection) — `sectionId: null`
  // is how a channel is removed from a section.
  isArchived: z.boolean().optional(),
  sectionId: z.string().nullable().optional(),
});

app.get('/', requirePermission('channels:read'), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const q = c.req.query();
  const limit = Math.min(q.limit ? parseInt(q.limit, 10) : 25, 100);

  // Membership boundary: only list channels the caller may actually see —
  // public channels plus any (private/dm) channel the caller has joined.
  // Mirrors chat-directories' membership-aware listing. `channels:read`
  // permission alone is NOT enough to enumerate private channel metadata.
  const conditions: any[] = [
    isNull(t.deletedAt),
    or(
      eq(t.type, 'public'),
      sql`EXISTS (
        SELECT 1 FROM ${schema.chatChannelMembers}
        WHERE ${schema.chatChannelMembers.channelId} = ${t.id}
          AND ${schema.chatChannelMembers.userId} = ${userId}
      )`,
    )!,
  ];
  if (q.type !== undefined && q.type !== '') conditions.push(eq(t.type, q.type));
  if (q.search) {
    conditions.push(like(t.name, `%${q.search}%`));
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
      db.select().from(t).where(where).orderBy(desc(t.createdAt), desc(t.id)).limit(limit + 1),
      db.select({ count: sql<number>`count(*)` }).from(t).where(countWhere),
    ]);
    const hasMore = rows.length > limit;
    const data = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore && data.length > 0 ? data[data.length - 1].id : null;
    const totalCount = Number(countRes[0]?.count ?? 0);
    return list(c, data, cursorPagination(totalCount, hasMore, nextCursor));
  } catch (err) {
    console.error('[app-api/channels] list failed:', err);
    return error.internal(c, 'Failed to list channels');
  }
});

app.get('/:id', requirePermission('channels:read'), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const id = c.req.param('id');
  try {
    const [row] = await db.select().from(t).where(and(eq(t.id, id), isNull(t.deletedAt))).limit(1);
    if (!row) return error.notFound(c, 'Channel', id);
    // Membership boundary: a private channel's metadata + roster is only
    // visible to members. 404 so we don't confirm a private channel exists.
    if (!(await canAccessChannel(db, id, userId))) {
      return error.notFound(c, 'Channel', id);
    }
    // Hydrate members with workspace member info so the channel header /
    // member list have name/email/picture without a second round-trip.
    const members = await db
      .select({
        id: schema.chatChannelMembers.id,
        userId: schema.chatChannelMembers.userId,
        role: schema.chatChannelMembers.role,
        joinedAt: schema.chatChannelMembers.joinedAt,
        isMuted: schema.chatChannelMembers.isMuted,
        notificationPreference: schema.chatChannelMembers.notificationPreference,
        name: schema.workspaceMembers.name,
        email: schema.workspaceMembers.email,
        picture: schema.workspaceMembers.picture,
      })
      .from(schema.chatChannelMembers)
      .leftJoin(
        schema.workspaceMembers,
        eq(schema.chatChannelMembers.userId, schema.workspaceMembers.userId),
      )
      .where(eq(schema.chatChannelMembers.channelId, id));
    return success(c, { ...row, members });
  } catch (err) {
    console.error('[app-api/channels] get failed:', err);
    return error.internal(c, 'Failed to fetch channel');
  }
});

/**
 * POST / — create a channel.
 *
 * Delegates to the createChannel service: creator auto-joins as `owner`,
 * `memberIds` are honoured, a public channel fans out to every ACTIVE INTERNAL
 * workspace member, and `memberCount` is denormalised. Every added member gets
 * a `channel_new` push so the channel appears in their sidebar without a
 * refresh. Returns the full channel row (the create dialog navigates to
 * `data.id` and renders `data.name`).
 */
app.post(
  '/',
  requirePermission('channels:create'),
  zValidator('json', createChannelBodySchema),
  async (c) => {
    const orgId = c.get('orgId');
    if (!orgId) return error.orgRequired(c);
    const db = c.get('tenantDb');
    const userId = c.get('userId');
    const data = c.req.valid('json');

    try {
      const { channel, memberUserIds } = await createChannel(db, userId, data);

      for (const uid of memberUserIds) {
        try {
          await publishChatUserChannelNew(c.env, orgId, uid, channel.id, channel.name);
        } catch (e) {
          console.error('[app-api/channels] channel_new publish failed:', e);
        }
      }

      safePublish(() =>
        publishEntityEvent({
          c,
          entityType: 'chat_channel',
          action: 'created',
          entityId: channel.id,
          data: { id: channel.id, name: channel.name, type: channel.type },
        }),
      );

      return success(c, channel, 201);
    } catch (err) {
      console.error('[app-api/channels] create failed:', err);
      return error.internal(c, 'Failed to create channel');
    }
  },
);

app.patch('/:id', requirePermission('channels:update'), zValidator('json', updateChannelBodySchema), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const id = c.req.param('id');
  const data = c.req.valid('json');
  try {
    const [existing] = await db.select().from(t).where(and(eq(t.id, id), isNull(t.deletedAt))).limit(1);
    if (!existing) return error.notFound(c, 'Channel', id);
    // Membership boundary: an outsider must not reconfigure a private channel.
    // (Stricter owner/admin-only moderation is deferred to the channel-role
    // model — see weldchat-backend-security-audit.)
    if (!(await canAccessChannel(db, id, userId))) {
      return error.notFound(c, 'Channel', id);
    }
    const update: Record<string, any> = { updatedAt: new Date() };
    for (const [k, v] of Object.entries(data)) if (v !== undefined) update[k] = v;
    // Renaming re-derives the slug, as the legacy handler did — the slug backs
    // the channel's URL, so leaving it on the old name silently rots links.
    if (data.name !== undefined) update.slug = slugifyChannelName(data.name) || id;
    await db.update(t).set(update).where(and(eq(t.id, id), isNull(t.deletedAt)));

    const [updated] = await db.select().from(t).where(eq(t.id, id)).limit(1);
    try {
      await publishChatChannelUpdated(c.env, id, update);
    } catch (e) {
      console.error('[app-api/channels] channel:updated publish failed:', e);
    }
    return success(c, updated ?? { id });
  } catch (err) {
    console.error('[app-api/channels] update failed:', err);
    return error.internal(c, 'Failed to update channel');
  }
});

app.delete('/:id', requirePermission('channels:delete'), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const id = c.req.param('id');
  try {
    const [existing] = await db.select().from(t).where(and(eq(t.id, id), isNull(t.deletedAt))).limit(1);
    if (!existing) return error.notFound(c, 'Channel', id);
    // Membership boundary: an outsider must not delete a private channel.
    // (Stricter owner/admin-only moderation is deferred to the channel-role
    // model — see weldchat-backend-security-audit.)
    if (!(await canAccessChannel(db, id, userId))) {
      return error.notFound(c, 'Channel', id);
    }
    await db.update(t).set({ deletedAt: new Date(), updatedAt: new Date() }).where(eq(t.id, id));
    // Tell everyone currently in the room it's gone — otherwise open clients
    // keep rendering a channel that no longer exists.
    try {
      await publishChatChannelUpdated(c.env, id, { deleted: true });
    } catch (e) {
      console.error('[app-api/channels] channel deleted publish failed:', e);
    }
    return noContent(c);
  } catch (err) {
    console.error('[app-api/channels] delete failed:', err);
    return error.internal(c, 'Failed to delete channel');
  }
});

// ===========================================================================
// Nested message + member sub-routes (ported from the obsolete api-worker
// /chat/channels/:channelId/* surface). The WeldChat platform hooks consume
// these exact shapes: messages → { messages, hasMore, nextCursor }; members →
// an array in `.data`. Message ops are guarded with `channels:*` to match the
// rest of the app-api chat surface.
// ===========================================================================

const messageAttachmentSchema = z.object({
  id: z.string(),
  fileName: z.string(),
  fileSize: z.number(),
  mimeType: z.string(),
  url: z.string(),
  thumbnailUrl: z.string().optional(),
});

const sendMessageSchema = z
  .object({
    content: z.string(),
    htmlContent: z.string().optional(),
    parentId: z.string().optional(),
    attachments: z.array(messageAttachmentSchema).optional(),
    mentions: z.array(z.string()).optional(),
  })
  .refine((d) => d.content.length > 0 || (d.attachments?.length ?? 0) > 0, {
    message: 'Message must have content or attachments',
  });

const messageCursorSchema = z.object({
  before: z.string().optional(),
  after: z.string().optional(),
  limit: z.coerce.number().min(1).max(100).default(50),
});

/**
 * GET /:channelId/messages — cursor-paginated top-level messages.
 * `before` paginates older (desc); `after` catches up newer (asc).
 * Returns { messages, hasMore, nextCursor } — NOT the list() envelope.
 */
app.get(
  '/:channelId/messages',
  requirePermission('channels:read'),
  zValidator('query', messageCursorSchema),
  async (c) => {
    const db = c.get('tenantDb');
    const userId = c.get('userId');
    const channelId = c.req.param('channelId');
    const { before, after, limit } = c.req.valid('query');
    const m = schema.chatMessages;

    // Membership boundary: don't return a private channel's history to
    // non-members.
    if (!(await canAccessChannel(db, channelId, userId))) {
      return error.forbidden(c, 'You do not have access to this channel');
    }

    try {
      const conditions = [
        eq(m.channelId, channelId),
        isNull(m.deletedAt),
        isNull(m.parentId), // top-level only (thread replies fetched separately)
      ];

      if (after) {
        const [cursorMsg] = await db
          .select({ createdAt: m.createdAt })
          .from(m)
          .where(eq(m.id, after))
          .limit(1);
        if (cursorMsg) conditions.push(gt(m.createdAt, cursorMsg.createdAt));

        const rows = await db
          .select()
          .from(m)
          .where(and(...conditions))
          .orderBy(asc(m.createdAt))
          .limit(limit + 1);
        const hasMore = rows.length > limit;
        const data = hasMore ? rows.slice(0, limit) : rows;
        return success(c, {
          messages: data,
          hasMore,
          nextCursor: hasMore && data.length > 0 ? data[data.length - 1].id : null,
        });
      }

      if (before) {
        const [cursorMsg] = await db
          .select({ createdAt: m.createdAt })
          .from(m)
          .where(eq(m.id, before))
          .limit(1);
        if (cursorMsg) conditions.push(lt(m.createdAt, cursorMsg.createdAt));
      }

      const rows = await db
        .select()
        .from(m)
        .where(and(...conditions))
        .orderBy(desc(m.createdAt))
        .limit(limit + 1);
      const hasMore = rows.length > limit;
      const data = hasMore ? rows.slice(0, limit) : rows;
      return success(c, {
        messages: data,
        hasMore,
        nextCursor: hasMore && data.length > 0 ? data[data.length - 1].id : null,
      });
    } catch (err) {
      console.error('[app-api/channels] list messages failed:', err);
      return error.internal(c, 'Failed to fetch messages');
    }
  },
);

/**
 * POST /:channelId/messages — send a message. Delegates to the shared
 * postChatMessage service (mentions, denorm counts, thread bump, realtime,
 * notifications). Realtime is best-effort, so this works without REALTIME.
 */
app.post(
  '/:channelId/messages',
  requirePermission('channels:create'),
  zValidator('json', sendMessageSchema),
  async (c) => {
    const orgId = c.get('orgId');
    if (!orgId) return error.orgRequired(c);
    const channelId = c.req.param('channelId');
    const input = c.req.valid('json');
    // Membership boundary: only members (or anyone, for a public channel) may
    // post to a channel.
    if (!(await canAccessChannel(c.get('tenantDb'), channelId, c.get('userId')))) {
      return error.forbidden(c, 'You do not have access to this channel');
    }
    try {
      const message = await postChatMessage(
        {
          db: c.get('tenantDb'),
          env: c.env,
          orgId,
          channelId,
          authorUserId: c.get('userId'),
        },
        input,
      );
      return success(c, message, 201);
    } catch (err) {
      console.error('[app-api/channels] send message failed:', err);
      return error.internal(c, 'Failed to send message');
    }
  },
);

/**
 * GET /:channelId/members — channel members hydrated with workspace member
 * info + agent name/icon. Returns an array in `.data`.
 */
app.get('/:channelId/members', requirePermission('channels:read'), async (c) => {
  const db = c.get('tenantDb');
  const channelId = c.req.param('channelId');
  const { chatChannelMembers, workspaceMembers } = schema;

  // Membership boundary: a private channel's roster is only visible to members.
  if (!(await canAccessChannel(db, channelId, c.get('userId')))) {
    return error.forbidden(c, 'You do not have access to this channel');
  }

  try {
    const rows = await db
      .select({
        id: chatChannelMembers.id,
        userId: chatChannelMembers.userId,
        memberType: chatChannelMembers.memberType,
        role: chatChannelMembers.role,
        joinedAt: chatChannelMembers.joinedAt,
        isMuted: chatChannelMembers.isMuted,
        notificationPreference: chatChannelMembers.notificationPreference,
        lastReadAt: chatChannelMembers.lastReadAt,
        lastReadMessageId: chatChannelMembers.lastReadMessageId,
        name: workspaceMembers.name,
        email: workspaceMembers.email,
        picture: workspaceMembers.picture,
        workspaceMemberType: workspaceMembers.memberType,
      })
      .from(chatChannelMembers)
      .leftJoin(workspaceMembers, eq(chatChannelMembers.userId, workspaceMembers.userId))
      .where(eq(chatChannelMembers.channelId, channelId));

    // Chat "agent" members are a legacy concept: the AI agents table was removed
    // in the 2026-07-08 AI teardown, so there is nothing left to hydrate them
    // from (`schema.agents` no longer exists). Any surviving agent-type rows
    // render with a generic label; the response shape is unchanged for the
    // frontend.
    const members = rows.map((r) => {
      if (r.memberType === 'agent') {
        return {
          ...r,
          name: 'Agent',
          email: null,
          picture: null,
          agentIcon: null,
          agentDescription: null,
        };
      }
      return r;
    });

    return success(c, members);
  } catch (err) {
    console.error('[app-api/channels] list members failed:', err);
    return error.internal(c, 'Failed to fetch members');
  }
});

const addMembersSchema = z.object({
  userIds: z.array(z.string().min(1)).min(1),
  memberType: z.enum(['user', 'agent']).optional().default('user'),
});

/** Body for POST /:channelId/read — every field optional. */
const markReadBodySchema = z.object({ beforeMessageId: z.string().optional() });

/**
 * publishEntityEvent() is fire-and-forget, but it dereferences
 * `c.executionCtx` — and Hono THROWS ("This context has no ExecutionContext")
 * when there isn't one (test harness, or any non-fetch invocation). Raw calls
 * sitting inside a route's try/catch therefore turn a perfectly good mutation
 * into a 500. Passing a thunk keeps the call site fully catalog-typed while
 * making the failure non-fatal, matching how realtime publishes are treated.
 */
function safePublish(publish: () => void): void {
  try {
    publish();
  } catch (e) {
    console.error('[app-api/channels] entity event publish failed:', e);
  }
}

/**
 * POST /:channelId/members — add members in one batch.
 *
 * Gated on `channels:update`, the tier the legacy api-worker handler used —
 * adding someone else to a channel is a moderation action, not a MEMBER-level
 * one. (Self-join is a separate, baseline-gated route below.)
 */
app.post(
  '/:channelId/members',
  requirePermission('channels:update'),
  zValidator('json', addMembersSchema),
  async (c) => {
    const orgId = c.get('orgId');
    if (!orgId) return error.orgRequired(c);
    const db = c.get('tenantDb');
    const channelId = c.req.param('channelId');
    const { userIds, memberType } = c.req.valid('json');

    // Membership boundary: consistent with the sibling GET on this path — a
    // private channel's roster is members-only, so you cannot bulk-add into a
    // private channel you are not in.
    if (!(await canAccessChannel(db, channelId, c.get('userId')))) {
      return error.forbidden(c, 'You do not have access to this channel');
    }

    try {
      const [channel] = await db
        .select({ name: t.name })
        .from(t)
        .where(and(eq(t.id, channelId), isNull(t.deletedAt)))
        .limit(1);
      if (!channel) return error.notFound(c, 'Channel', channelId);

      const result = await addChannelMembers(db, { channelId, userIds, memberType });
      if (!result.ok) return error.badRequest(c, result.message);

      for (const uid of result.addedUserIds) {
        try {
          await publishChatMemberJoined(c.env, channelId, { channelId, userId: uid });
          if (memberType === 'user') {
            await publishChatUserChannelNew(c.env, orgId, uid, channelId, channel.name);
          }
        } catch (e) {
          console.error('[app-api/channels] member_joined publish failed:', e);
        }
        // NOTE: ChatChannelEventData is a closed { id, name?, type? } — it
        // cannot carry WHICH user joined, so a subscriber only learns that the
        // roster changed. Catalog gap, flagged in the W5b report.
        safePublish(() =>
          publishEntityEvent({
            c,
            entityType: 'chat_channel',
            action: 'joined',
            entityId: channelId,
            data: { id: channelId, name: channel.name },
          }),
        );
      }

      return success(c, { channelId, addedCount: result.addedCount }, 201);
    } catch (err) {
      console.error('[app-api/channels] add members failed:', err);
      return error.internal(c, 'Failed to add members');
    }
  },
);

/**
 * POST /:channelId/members/join — self-join a public channel.
 * Baseline `channels:read` gate, matching the legacy route: joining an open
 * channel is a MEMBER-reachable action.
 */
app.post('/:channelId/members/join', requirePermission('channels:read'), async (c) => {
  const orgId = c.get('orgId');
  if (!orgId) return error.orgRequired(c);
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const channelId = c.req.param('channelId');

  try {
    const result = await joinPublicChannel(db, channelId, userId);
    if (!result.ok) return error.badRequest(c, result.message);
    if (result.alreadyMember) return success(c, { channelId, alreadyMember: true });

    try {
      await publishChatMemberJoined(c.env, channelId, { channelId, userId });
    } catch (e) {
      console.error('[app-api/channels] member_joined publish failed:', e);
    }
    safePublish(() =>
      publishEntityEvent({
        c,
        entityType: 'chat_channel',
        action: 'joined',
        entityId: channelId,
        data: { id: channelId },
      }),
    );

    return success(c, { channelId, joined: true }, 201);
  } catch (err) {
    console.error('[app-api/channels] join failed:', err);
    return error.internal(c, 'Failed to join channel');
  }
});

/**
 * POST /:channelId/members/leave — the current user leaves.
 * Baseline `channels:read` gate: leaving is self-service. An owner must hand
 * over ownership first, or the channel is left unadministered.
 */
app.post('/:channelId/members/leave', requirePermission('channels:read'), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const channelId = c.req.param('channelId');

  try {
    const membership = await getMembership(db, channelId, userId);
    if (!membership) return error.badRequest(c, 'You are not a member of this channel');
    if (membership.role === 'owner') {
      return error.badRequest(c, 'Channel owner cannot leave. Transfer ownership first.');
    }

    await removeChannelMemberByUserId(db, channelId, userId);

    try {
      await publishChatMemberLeft(c.env, channelId, { channelId, userId });
    } catch (e) {
      console.error('[app-api/channels] member_left publish failed:', e);
    }
    safePublish(() =>
      publishEntityEvent({
        c,
        entityType: 'chat_channel',
        action: 'left',
        entityId: channelId,
        data: { id: channelId },
      }),
    );

    return success(c, { channelId, left: true });
  } catch (err) {
    console.error('[app-api/channels] leave failed:', err);
    return error.internal(c, 'Failed to leave channel');
  }
});

/**
 * DELETE /:channelId/members/:userId — remove a member by USER id (the flat
 * /api/channel-members route keys off the membership row id, which no caller
 * holds). Maintains `memberCount` and publishes `member_left`.
 */
app.delete('/:channelId/members/:userId', requirePermission('channels:update'), async (c) => {
  const db = c.get('tenantDb');
  const channelId = c.req.param('channelId');
  const targetUserId = c.req.param('userId');

  if (!(await canAccessChannel(db, channelId, c.get('userId')))) {
    return error.forbidden(c, 'You do not have access to this channel');
  }

  try {
    const { removed } = await removeChannelMemberByUserId(db, channelId, targetUserId);
    if (!removed) return error.notFound(c, 'Member', targetUserId);

    try {
      await publishChatMemberLeft(c.env, channelId, { channelId, userId: targetUserId });
    } catch (e) {
      console.error('[app-api/channels] member_left publish failed:', e);
    }
    safePublish(() =>
      publishEntityEvent({
        c,
        entityType: 'chat_channel',
        action: 'left',
        entityId: channelId,
        data: { id: channelId },
      }),
    );

    return success(c, { channelId, userId: targetUserId, removed: true });
  } catch (err) {
    console.error('[app-api/channels] remove member failed:', err);
    return error.internal(c, 'Failed to remove member');
  }
});

/**
 * GET /:channelId/read-receipts — per-message read data, grouped by messageId.
 */
app.get('/:channelId/read-receipts', requirePermission('channels:read'), async (c) => {
  const db = c.get('tenantDb');
  const channelId = c.req.param('channelId');

  if (!(await canAccessChannel(db, channelId, c.get('userId')))) {
    return error.forbidden(c, 'You do not have access to this channel');
  }

  try {
    return success(c, await getChannelReadReceipts(db, channelId));
  } catch (err) {
    console.error('[app-api/channels] read receipts failed:', err);
    return error.internal(c, 'Failed to fetch read receipts');
  }
});

/**
 * POST /:channelId/messages/:messageId/forward — copy a message into one or
 * more target channels, carrying a `forwardedFrom` snapshot.
 *
 * `messages:create` gate, matching the legacy handler: forwarding writes
 * messages, so it is a MEMBER-reachable message action, not a channel one.
 */
app.post(
  '/:channelId/messages/:messageId/forward',
  requirePermission('messages:create'),
  zValidator(
    'json',
    z.object({
      targetChannelIds: z.array(z.string().min(1)).min(1),
      comment: z.string().optional(),
      htmlComment: z.string().optional(),
    }),
  ),
  async (c) => {
    const orgId = c.get('orgId');
    if (!orgId) return error.orgRequired(c);
    const db = c.get('tenantDb');
    const userId = c.get('userId');
    const input = c.req.valid('json');

    try {
      const result = await forwardMessage(
        db,
        {
          sourceChannelId: c.req.param('channelId'),
          sourceMessageId: c.req.param('messageId'),
          userId,
        },
        input,
      );

      if (!result.ok) {
        return result.status === 403
          ? error.forbidden(c, result.message)
          : error.notFound(c, 'Message', result.message);
      }

      const rt = c.env.REALTIME ? new RealtimePublisher(c.env.REALTIME) : null;
      for (const fwd of result.forwarded) {
        if (rt) {
          try {
            await rt.chatMessage(fwd.channelId, {
              id: fwd.messageId,
              content: fwd.content,
              senderId: userId,
              senderName: result.authorName,
              senderAvatar: result.authorAvatar ?? undefined,
              authorType: 'user',
            });
          } catch (e) {
            console.error('[app-api/channels] forward realtime publish failed:', e);
          }
        }
        for (const recipientId of fwd.recipientUserIds) {
          try {
            await publishChatUnreadUpdate(c.env, orgId, recipientId, fwd.channelId, 1);
          } catch {
            /* non-critical */
          }
        }
        safePublish(() =>
          publishEntityEvent({
            c,
            entityType: 'chat_message',
            action: 'created',
            entityId: fwd.messageId,
            data: { id: fwd.messageId, channelId: fwd.channelId, authorId: userId },
          }),
        );
      }

      return success(
        c,
        { forwarded: result.forwarded.map((f) => ({ channelId: f.channelId, messageId: f.messageId })) },
        201,
      );
    } catch (err) {
      console.error('[app-api/channels] forward failed:', err);
      return error.internal(c, 'Failed to forward message');
    }
  },
);

/**
 * POST /:channelId/read — mark the channel read for the current user, or (with
 * `beforeMessageId`) mark it unread from that message onwards.
 *
 * Two gaps closed vs the previous cursor-only implementation:
 *   - per-message `chatMessageReads` rows are written, which is what the
 *     "seen by" avatars (GET /read-receipts) actually read. Cursor-only left
 *     that surface permanently empty.
 *   - `beforeMessageId` is honoured. The legacy handler accepted the body and
 *     ignored it, so "Mark unread from here" has been marking the channel READ.
 */
app.post('/:channelId/read', requirePermission('channels:read'), async (c) => {
  const orgId = c.get('orgId');
  if (!orgId) return error.orgRequired(c);
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const channelId = c.req.param('channelId');

  // The body is optional — useMarkChannelAsRead() posts nothing at all, so a
  // zValidator here would 400 the common case. Tolerate a missing/invalid
  // body, then validate whatever did arrive.
  const rawBody = await c.req.json().catch(() => ({}));
  const parsed = markReadBodySchema.safeParse(rawBody ?? {});
  if (!parsed.success) return error.badRequest(c, 'Invalid request body');
  const { beforeMessageId } = parsed.data;

  if (!(await canAccessChannel(db, channelId, userId))) {
    return error.forbidden(c, 'You do not have access to this channel');
  }

  try {
    if (beforeMessageId) {
      const result = await markChannelUnreadFrom(db, channelId, userId, beforeMessageId);
      if (!result) return error.notFound(c, 'Message', beforeMessageId);
      return success(c, result);
    }

    const result = await markChannelRead(db, channelId, userId);

    // The caller's other devices clear their unread badge…
    try {
      await publishChatUnreadUpdate(c.env, orgId, userId, channelId, 0);
    } catch (e) {
      console.error('[app-api/channels] unread publish failed:', e);
    }
    // …and the channel gets a read receipt so senders see "seen by".
    if (result.lastReadMessageId) {
      try {
        const reader = await getReaderProfile(db, userId);
        await publishChatReadUpdated(c.env, channelId, {
          channelId,
          userId,
          userName: reader.name,
          userAvatar: reader.avatar,
          lastReadMessageId: result.lastReadMessageId,
          lastReadAt: result.lastReadAt.toISOString(),
        });
      } catch (e) {
        console.error('[app-api/channels] read receipt publish failed:', e);
      }
    }

    return success(c, result);
  } catch (err) {
    console.error('[app-api/channels] mark read failed:', err);
    return error.internal(c, 'Failed to mark channel read');
  }
});

/**
 * PATCH /:channelId/me — update the current user's membership (mute self).
 * Ported from the obsolete mobile-api-worker chat route. Publishes a
 * `chat_channel` updated entity event (fire-and-forget).
 */
app.patch(
  '/:channelId/me',
  requirePermission('channels:update'),
  zValidator('json', updateChannelMembershipSchema),
  async (c) => {
    const db = c.get('tenantDb');
    const userId = c.get('userId');
    const channelId = c.req.param('channelId');
    const { isMuted } = c.req.valid('json');

    try {
      const updated = await setChannelMuted(db, channelId, userId, isMuted);
      if (!updated) return error.notFound(c, 'Membership');

      safePublish(() =>
        publishEntityEvent({
          c,
          entityType: 'chat_channel',
          action: 'updated',
          entityId: channelId,
          data: { id: channelId },
        }),
      );

      return success(c, updated);
    } catch (err) {
      console.error('[app-api/channels] update membership failed:', err);
      return error.internal(c, 'Failed to update membership');
    }
  },
);

export const channelsRoutes = app;
