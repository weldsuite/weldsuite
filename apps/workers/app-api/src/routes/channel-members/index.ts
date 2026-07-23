/**
 * Channel member routes — flat /api/channel-members/* surface backed by `chatChannelMembers`.
 *
 * Permission tiers follow the legacy api-worker chat routes, NOT the generic
 * CRUD ladder: self-service actions (self-join a public channel, leave) sit on
 * the baseline `channels:read`/`channels:create` that SYSTEM_ROLES.MEMBER
 * actually holds. Gating a leave on `channels:delete` — which MEMBER does not
 * have — 403s every ordinary user out of a channel they are standing in.
 * Moderation (adding/kicking someone else, granting a role) is enforced
 * in-handler via isChannelModerator, so the tier stays reachable while the
 * action stays privileged.
 *
 * The batch surface (`POST /api/channels/:channelId/members`) is the one the
 * platform uses; this flat route stays for single-row CRUD parity.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, desc, eq, sql } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import type { Env, Variables } from '../../types';
import { cursorPagination, error, list, noContent, success } from '../../lib/response';
import { generateId } from '../../lib/id';
import { schema } from '../../db';
import {
  canAccessChannel,
  getChannelRole,
  isChannelModerator,
} from '../../services/chat/channel-access';
import { removeChannelMemberByUserId } from '../../services/chat/channel-members';
import {
  publishChatMemberJoined,
  publishChatMemberLeft,
  publishChatUserChannelNew,
} from '../../services/realtime/weldchat-publisher';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
const t = schema.chatChannelMembers;

/** Roles a membership row may hold. */
const VALID_MEMBER_ROLES = new Set(['owner', 'admin', 'member']);

// Explicit field lists — the `@weldsuite/core-api-client` member schemas are
// `.passthrough()`, and this route feeds Drizzle directly.
const createChannelMemberSchema = z.object({
  channelId: z.string().min(1),
  userId: z.string().min(1),
  role: z.enum(['owner', 'admin', 'member']).optional(),
  memberType: z.enum(['user', 'agent']).optional(),
});

const updateChannelMemberSchema = z.object({
  role: z.enum(['owner', 'admin', 'member']).optional(),
  isMuted: z.boolean().optional(),
  notificationPreference: z.enum(['all', 'mentions', 'none']).optional(),
  lastReadAt: z.coerce.date().optional(),
  lastReadMessageId: z.string().nullable().optional(),
});

app.get('/', requirePermission('channels:read'), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const q = c.req.query();
  const limit = Math.min(q.limit ? parseInt(q.limit, 10) : 25, 100);

  // Membership boundary: a roster is scoped to a single channel the caller can
  // access — never an un-scoped dump of every membership row in the tenant.
  if (q.channelId === undefined || q.channelId === '') {
    return error.badRequest(c, 'channelId query parameter is required');
  }
  if (!(await canAccessChannel(db, q.channelId, userId))) {
    return error.forbidden(c, 'You do not have access to this channel');
  }

  const conditions: any[] = [eq(t.channelId, q.channelId)];
  if (q.userId !== undefined && q.userId !== '') conditions.push(eq(t.userId, q.userId));
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
    console.error('[app-api/channel-members] list failed:', err);
    return error.internal(c, 'Failed to list channel members');
  }
});

app.get('/:id', requirePermission('channels:read'), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const id = c.req.param('id');
  try {
    const [row] = await db.select().from(t).where(eq(t.id, id)).limit(1);
    if (!row) return error.notFound(c, 'Channel member', id);
    // Membership boundary: don't reveal a private channel's membership rows.
    if (!(await canAccessChannel(db, row.channelId, userId))) {
      return error.notFound(c, 'Channel member', id);
    }
    return success(c, row);
  } catch (err) {
    console.error('[app-api/channel-members] get failed:', err);
    return error.internal(c, 'Failed to fetch channel member');
  }
});

app.post('/', requirePermission('channels:create'), zValidator('json', createChannelMemberSchema), async (c) => {
  const orgId = c.get('orgId');
  if (!orgId) return error.orgRequired(c);
  const db = c.get('tenantDb');
  const callerId = c.get('userId');
  const data = c.req.valid('json');

  const channelId = data.channelId;
  const targetUserId = data.userId;
  const requestedRole =
    data.role && VALID_MEMBER_ROLES.has(data.role) ? data.role : 'member';
  // Honour the caller's memberType instead of hardcoding 'user' — an agent
  // invite silently becoming a user member is how agent ids ended up in the
  // roster as if they were people.
  const memberType = data.memberType ?? 'user';
  if (memberType === 'agent' && !targetUserId.startsWith('agt_')) {
    return error.badRequest(c, `Invalid agent id: ${targetUserId}`);
  }

  // Authorization — this endpoint was previously an open self-join into ANY
  // channel (the master key that bypassed every other membership check). Two
  // legitimate cases only:
  //   (a) self-join a PUBLIC channel, or
  //   (b) a channel admin/owner adding someone.
  const isSelfAdd = targetUserId === callerId;
  if (isSelfAdd) {
    // Self-join is allowed only for public channels — joining a private channel
    // requires being invited by an admin/owner.
    if (!(await canAccessChannel(db, channelId, callerId))) {
      const [channel] = await db
        .select({ type: schema.chatChannels.type })
        .from(schema.chatChannels)
        .where(eq(schema.chatChannels.id, channelId))
        .limit(1);
      if (!channel || channel.type !== 'public') {
        return error.forbidden(c, 'You cannot join this channel');
      }
    }
  } else {
    // Adding another user requires the caller to be a channel admin/owner.
    if (!(await isChannelModerator(db, channelId, callerId))) {
      return error.forbidden(c, 'Only a channel admin can add members');
    }
  }

  // Role cap: a self-join is always a plain member; only an owner may grant the
  // owner role.
  let role = requestedRole;
  if (isSelfAdd) {
    role = 'member';
  } else if (role === 'owner') {
    const callerRole = await getChannelRole(db, channelId, callerId);
    if (callerRole !== 'owner') role = 'admin';
  }

  // Idempotency: a membership row may already exist (unique on channelId+userId).
  const [existing] = await db
    .select()
    .from(t)
    .where(and(eq(t.channelId, channelId), eq(t.userId, targetUserId)))
    .limit(1);
  if (existing) return success(c, { id: existing.id }, 200);

  const id = generateId('chm');
  const now = new Date();
  try {
    // Explicit column list. NOTE: `chatChannelMembers` has no `updatedAt`
    // column — writing one used to be silently dropped on insert and would
    // throw on update (see PATCH below).
    await db.insert(t).values({
      id,
      channelId,
      userId: targetUserId,
      role,
      memberType,
      createdAt: now,
      joinedAt: now,
    });

    // Keep the denormalised roster size honest — the sidebar renders it.
    await db
      .update(schema.chatChannels)
      .set({
        memberCount: sql`${schema.chatChannels.memberCount} + 1`,
        updatedAt: now,
      })
      .where(eq(schema.chatChannels.id, channelId));

    try {
      await publishChatMemberJoined(c.env, channelId, { channelId, userId: targetUserId });
      if (memberType === 'user') {
        const [channel] = await db
          .select({ name: schema.chatChannels.name })
          .from(schema.chatChannels)
          .where(eq(schema.chatChannels.id, channelId))
          .limit(1);
        await publishChatUserChannelNew(
          c.env,
          orgId,
          targetUserId,
          channelId,
          channel?.name ?? '',
        );
      }
    } catch (e) {
      console.error('[app-api/channel-members] realtime publish failed:', e);
    }

    return success(c, { id }, 201);
  } catch (err) {
    console.error('[app-api/channel-members] create failed:', err);
    return error.internal(c, 'Failed to create channel member');
  }
});

/**
 * PATCH /:id — self-service prefs (mute, notifications, read cursor) or, for a
 * channel moderator, a role change.
 *
 * Baseline `channels:read` gate: muting your own membership is a MEMBER-level
 * action and MEMBER does not hold `channels:update`. Role changes stay
 * privileged via the isChannelModerator check below.
 */
app.patch('/:id', requirePermission('channels:read'), zValidator('json', updateChannelMemberSchema), async (c) => {
  const db = c.get('tenantDb');
  const callerId = c.get('userId');
  const id = c.req.param('id');
  const data = c.req.valid('json') as Record<string, any>;
  try {
    const [existing] = await db.select().from(t).where(eq(t.id, id)).limit(1);
    if (!existing) return error.notFound(c, 'Channel member', id);

    const isSelf = existing.userId === callerId;
    const isMod = await isChannelModerator(db, existing.channelId, callerId);
    if (!isSelf && !isMod) {
      return error.forbidden(c, 'You cannot modify this membership');
    }

    // A member may only change their own self-service prefs. Role (and the
    // identity columns) may only be set by a channel moderator, and only an
    // owner may grant the owner role.
    const SELF_FIELDS = new Set(['isMuted', 'notificationPreference', 'lastReadAt', 'lastReadMessageId']);
    // No `updatedAt` seed: chat_channel_members has no such column, and Drizzle
    // dereferences the column meta when building the SET clause — an unknown
    // key threw a TypeError, i.e. every PATCH here 500'd.
    const update: Record<string, any> = {};
    for (const [k, v] of Object.entries(data)) {
      if (v === undefined) continue;
      if (k === 'channelId' || k === 'userId' || k === 'id') continue; // never reassign identity
      if (SELF_FIELDS.has(k)) {
        update[k] = v;
      } else if (k === 'role' && isMod) {
        if (!VALID_MEMBER_ROLES.has(v)) continue;
        if (v === 'owner' && (await getChannelRole(db, existing.channelId, callerId)) !== 'owner') continue;
        update[k] = v;
      }
      // any other field (and role changes by a non-moderator) is ignored
    }
    if (Object.keys(update).length === 0) return success(c, { id });
    await db.update(t).set(update).where(eq(t.id, id));
    return success(c, { id });
  } catch (err) {
    console.error('[app-api/channel-members] update failed:', err);
    return error.internal(c, 'Failed to update channel member');
  }
});

/**
 * DELETE /:id — leave (self) or kick (moderator).
 *
 * Baseline `channels:read` gate. This was `channels:delete`, which
 * SYSTEM_ROLES.MEMBER does not hold — so the self-leave path the handler
 * explicitly supports was unreachable for every ordinary member (403 before
 * the isSelf check ever ran). The legacy api-worker leave route gated on
 * `channels:read` for exactly this reason; kicking stays privileged via
 * isChannelModerator.
 */
app.delete('/:id', requirePermission('channels:read'), async (c) => {
  const db = c.get('tenantDb');
  const callerId = c.get('userId');
  const id = c.req.param('id');
  try {
    const [existing] = await db.select().from(t).where(eq(t.id, id)).limit(1);
    if (!existing) return error.notFound(c, 'Channel member', id);
    // A member may remove themselves (leave); removing anyone else requires
    // being a channel admin/owner (kick).
    const isSelf = existing.userId === callerId;
    if (!isSelf && !(await isChannelModerator(db, existing.channelId, callerId))) {
      return error.forbidden(c, 'You cannot remove this member');
    }
    // Deletes the row AND decrements chatChannels.memberCount.
    await removeChannelMemberByUserId(db, existing.channelId, existing.userId);

    try {
      await publishChatMemberLeft(c.env, existing.channelId, {
        channelId: existing.channelId,
        userId: existing.userId,
      });
    } catch (e) {
      console.error('[app-api/channel-members] realtime publish failed:', e);
    }

    return noContent(c);
  } catch (err) {
    console.error('[app-api/channel-members] delete failed:', err);
    return error.internal(c, 'Failed to delete channel member');
  }
});

export const channelMembersRoutes = app;
