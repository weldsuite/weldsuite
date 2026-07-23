/**
 * WeldChat direct-message routes — flat /api/chat-dm/* surface backed by
 * `chatChannels` (type = 'dm') + `chatChannelMembers`.
 *
 *   GET  /                 — list the caller's DM channels
 *   POST /                 — create-or-get a DM with a set of users
 *   GET  /:targetUserId    — get-or-create the 1:1 DM with a specific user
 *
 * New DMs notify the other participants over the realtime WorkspaceHub
 * (REALTIME binding) and via the `@weldsuite/notifications` helper.
 *
 * WeldChat streams over its own ChatRoom DO, not the entity-event bus — no
 * entity events are published here.
 *
 * Permissions: messages:read | messages:create.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import { RealtimePublisher } from '@weldsuite/realtime/server';
import { sendChatDmNotification } from '@weldsuite/notifications';
import { createDmSchema, pinDmSchema } from '@weldsuite/app-api-client/schemas/chat-dm';
import { publishEntityEvent } from '@weldsuite/entity-events';
import type { Env, Variables } from '../../types';
import { error, noContent, success } from '../../lib/response';
import { generateId } from '../../lib/id';
import { schema, type Database } from '../../db';
import { leaveDm, setDmArchived, setDmPinned } from '../../services/chat/dm-membership';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

/** Fire the new-DM realtime + notification for a recipient (best effort). */
async function notifyNewDm(
  c: { env: Env },
  db: Database,
  orgId: string,
  recipientUserId: string,
  senderUserId: string,
  senderName: string,
  channelId: string,
): Promise<void> {
  if (c.env.REALTIME) {
    try {
      const rt = new RealtimePublisher(c.env.REALTIME);
      await rt.chatUserDmNew(orgId, recipientUserId, { channelId, senderName, preview: '' });
    } catch (e) {
      console.error('[app-api/chat-dm] realtime publish failed:', e);
    }
  }
  try {
    await sendChatDmNotification({
      db,
      env: c.env,
      workspaceId: orgId,
      recipientUserId,
      senderUserId,
      senderName,
      channelId,
      preview: '',
    });
  } catch (e) {
    console.error('[app-api/chat-dm] DM notification failed:', e);
  }
}

app.get('/', requirePermission('messages:read'), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');

  try {
    const { chatChannels, chatChannelMembers, workspaceMembers } = schema;

    const memberChannels = await db
      .select({ channelId: chatChannelMembers.channelId })
      .from(chatChannelMembers)
      .where(eq(chatChannelMembers.userId, userId));
    const channelIds = memberChannels.map((r) => r.channelId);
    if (channelIds.length === 0) return success(c, []);

    const channels = await db
      .select()
      .from(chatChannels)
      .where(
        and(inArray(chatChannels.id, channelIds), eq(chatChannels.type, 'dm'), isNull(chatChannels.deletedAt)),
      )
      .orderBy(desc(chatChannels.lastMessageAt));

    const result = await Promise.all(
      channels.map(async (channel) => {
        const members = await db
          .select({
            userId: chatChannelMembers.userId,
            role: chatChannelMembers.role,
            lastReadAt: chatChannelMembers.lastReadAt,
            lastReadMessageId: chatChannelMembers.lastReadMessageId,
            name: workspaceMembers.name,
            email: workspaceMembers.email,
            picture: workspaceMembers.picture,
          })
          .from(chatChannelMembers)
          .leftJoin(workspaceMembers, eq(chatChannelMembers.userId, workspaceMembers.userId))
          .where(eq(chatChannelMembers.channelId, channel.id));

        const currentMember = members.find((m) => m.userId === userId);
        const otherMembers = members.filter((m) => m.userId !== userId);

        return {
          ...channel,
          members,
          otherMembers,
          lastReadAt: currentMember?.lastReadAt ?? null,
          lastReadMessageId: currentMember?.lastReadMessageId ?? null,
        };
      }),
    );

    return success(c, result);
  } catch (err) {
    console.error('[app-api/chat-dm] list failed:', err);
    return error.internal(c, 'Failed to fetch DM channels');
  }
});

app.post('/', requirePermission('messages:create'), zValidator('json', createDmSchema), async (c) => {
  const db = c.get('tenantDb');
  const orgId = c.get('orgId');
  if (!orgId) return error.orgRequired(c);
  const userId = c.get('userId');
  const { userIds } = c.req.valid('json');

  try {
    const { chatChannels, chatChannelMembers, workspaceMembers } = schema;

    const allUserIds = Array.from(new Set([userId, ...userIds]));
    const participantCount = allUserIds.length;

    // Try to find an existing DM channel with exactly these participants.
    const userDmChannels = await db
      .select({ channelId: chatChannelMembers.channelId })
      .from(chatChannelMembers)
      .where(eq(chatChannelMembers.userId, userId));
    const userDmChannelIds = userDmChannels.map((r) => r.channelId);

    if (userDmChannelIds.length > 0) {
      const dmChannels = await db
        .select({ id: chatChannels.id, memberCount: chatChannels.memberCount })
        .from(chatChannels)
        .where(
          and(
            inArray(chatChannels.id, userDmChannelIds),
            eq(chatChannels.type, 'dm'),
            eq(chatChannels.memberCount, participantCount),
            isNull(chatChannels.deletedAt),
          ),
        );

      for (const candidate of dmChannels) {
        const members = await db
          .select({ userId: chatChannelMembers.userId })
          .from(chatChannelMembers)
          .where(eq(chatChannelMembers.channelId, candidate.id));

        const memberUserIds = members.map((m) => m.userId).sort();
        const targetUserIds = [...allUserIds].sort();

        if (
          memberUserIds.length === targetUserIds.length &&
          memberUserIds.every((id, i) => id === targetUserIds[i])
        ) {
          const fullMembers = await db
            .select({
              userId: chatChannelMembers.userId,
              name: workspaceMembers.name,
              email: workspaceMembers.email,
              picture: workspaceMembers.picture,
            })
            .from(chatChannelMembers)
            .leftJoin(workspaceMembers, eq(chatChannelMembers.userId, workspaceMembers.userId))
            .where(eq(chatChannelMembers.channelId, candidate.id));

          const [channel] = await db
            .select()
            .from(chatChannels)
            .where(eq(chatChannels.id, candidate.id))
            .limit(1);

          return success(c, { ...channel, members: fullMembers });
        }
      }
    }

    // No existing DM — create one.
    const otherUserIds = allUserIds.filter((id) => id !== userId);
    const otherMembers =
      otherUserIds.length > 0
        ? await db
            .select({ userId: workspaceMembers.userId, name: workspaceMembers.name })
            .from(workspaceMembers)
            .where(inArray(workspaceMembers.userId, otherUserIds))
        : [];

    const channelName = otherMembers.map((m) => m.name ?? 'Unknown').join(', ') || 'Direct Message';
    const id = generateId('ch');
    const now = new Date();

    await db.insert(chatChannels).values({
      id,
      name: channelName,
      slug: `dm-${id}`,
      type: 'dm',
      memberCount: participantCount,
      createdBy: userId,
      createdAt: now,
      updatedAt: now,
    });

    for (const uid of allUserIds) {
      await db.insert(chatChannelMembers).values({
        id: generateId('cmb'),
        channelId: id,
        userId: uid,
        role: 'member',
        joinedAt: now,
        createdAt: now,
      });
    }

    const [channel] = await db.select().from(chatChannels).where(eq(chatChannels.id, id)).limit(1);
    const fullMembers = await db
      .select({
        userId: chatChannelMembers.userId,
        name: workspaceMembers.name,
        email: workspaceMembers.email,
        picture: workspaceMembers.picture,
      })
      .from(chatChannelMembers)
      .leftJoin(workspaceMembers, eq(chatChannelMembers.userId, workspaceMembers.userId))
      .where(eq(chatChannelMembers.channelId, id));

    const [sender] = await db
      .select({ name: workspaceMembers.name })
      .from(workspaceMembers)
      .where(eq(workspaceMembers.userId, userId))
      .limit(1);
    const senderName = sender?.name ?? 'Someone';

    for (const uid of allUserIds.filter((u) => u !== userId)) {
      await notifyNewDm(c, db, orgId, uid, userId, senderName, id);
    }

    return success(c, { ...channel, members: fullMembers }, 201);
  } catch (err) {
    console.error('[app-api/chat-dm] create failed:', err);
    return error.internal(c, 'Failed to create DM');
  }
});

app.get('/:targetUserId', requirePermission('messages:read'), async (c) => {
  const db = c.get('tenantDb');
  const orgId = c.get('orgId');
  if (!orgId) return error.orgRequired(c);
  const userId = c.get('userId');
  const targetUserId = c.req.param('targetUserId');

  try {
    const { chatChannels, chatChannelMembers, workspaceMembers } = schema;

    const allUserIds = Array.from(new Set([userId, targetUserId])).sort();
    const participantCount = allUserIds.length;

    const userDmChannels = await db
      .select({ channelId: chatChannelMembers.channelId })
      .from(chatChannelMembers)
      .where(eq(chatChannelMembers.userId, userId));
    const userDmChannelIds = userDmChannels.map((r) => r.channelId);

    if (userDmChannelIds.length > 0) {
      const dmChannels = await db
        .select({ id: chatChannels.id })
        .from(chatChannels)
        .where(
          and(
            inArray(chatChannels.id, userDmChannelIds),
            eq(chatChannels.type, 'dm'),
            eq(chatChannels.memberCount, participantCount),
            isNull(chatChannels.deletedAt),
          ),
        );

      for (const candidate of dmChannels) {
        const members = await db
          .select({ userId: chatChannelMembers.userId })
          .from(chatChannelMembers)
          .where(eq(chatChannelMembers.channelId, candidate.id));

        const memberIds = members.map((m) => m.userId).sort();
        if (memberIds.length === allUserIds.length && memberIds.every((id, i) => id === allUserIds[i])) {
          const [channel] = await db
            .select()
            .from(chatChannels)
            .where(eq(chatChannels.id, candidate.id))
            .limit(1);

          const fullMembers = await db
            .select({
              userId: chatChannelMembers.userId,
              role: chatChannelMembers.role,
              lastReadAt: chatChannelMembers.lastReadAt,
              lastReadMessageId: chatChannelMembers.lastReadMessageId,
              name: workspaceMembers.name,
              email: workspaceMembers.email,
              picture: workspaceMembers.picture,
            })
            .from(chatChannelMembers)
            .leftJoin(workspaceMembers, eq(chatChannelMembers.userId, workspaceMembers.userId))
            .where(eq(chatChannelMembers.channelId, candidate.id));

          const currentMember = fullMembers.find((m) => m.userId === userId);
          const otherMembers = fullMembers.filter((m) => m.userId !== userId);

          return success(c, {
            ...channel,
            members: fullMembers,
            otherMembers,
            lastReadAt: currentMember?.lastReadAt ?? null,
            lastReadMessageId: currentMember?.lastReadMessageId ?? null,
          });
        }
      }
    }

    // No existing DM — create one.
    const [targetUser] = await db
      .select({ userId: workspaceMembers.userId, name: workspaceMembers.name })
      .from(workspaceMembers)
      .where(eq(workspaceMembers.userId, targetUserId))
      .limit(1);

    const channelName = targetUser?.name ?? 'Direct Message';
    const id = generateId('ch');
    const now = new Date();

    await db.insert(chatChannels).values({
      id,
      name: channelName,
      slug: `dm-${id}`,
      type: 'dm',
      memberCount: participantCount,
      createdBy: userId,
      createdAt: now,
      updatedAt: now,
    });

    for (const uid of allUserIds) {
      await db.insert(chatChannelMembers).values({
        id: generateId('cmb'),
        channelId: id,
        userId: uid,
        role: 'member',
        joinedAt: now,
        createdAt: now,
      });
    }

    const [channel] = await db.select().from(chatChannels).where(eq(chatChannels.id, id)).limit(1);
    const fullMembers = await db
      .select({
        userId: chatChannelMembers.userId,
        role: chatChannelMembers.role,
        lastReadAt: chatChannelMembers.lastReadAt,
        lastReadMessageId: chatChannelMembers.lastReadMessageId,
        name: workspaceMembers.name,
        email: workspaceMembers.email,
        picture: workspaceMembers.picture,
      })
      .from(chatChannelMembers)
      .leftJoin(workspaceMembers, eq(chatChannelMembers.userId, workspaceMembers.userId))
      .where(eq(chatChannelMembers.channelId, id));

    const otherMembers = fullMembers.filter((m) => m.userId !== userId);

    if (targetUserId !== userId) {
      const [initiator] = await db
        .select({ name: workspaceMembers.name })
        .from(workspaceMembers)
        .where(eq(workspaceMembers.userId, userId))
        .limit(1);
      await notifyNewDm(c, db, orgId, targetUserId, userId, initiator?.name ?? 'Someone', id);
    }

    return success(c, { ...channel, members: fullMembers, otherMembers }, 201);
  } catch (err) {
    console.error('[app-api/chat-dm] resolve failed:', err);
    return error.internal(c, 'Failed to resolve DM');
  }
});

// ===========================================================================
// DM membership mutations — archive / unarchive / pin / delete for the current
// user. Ported from the obsolete mobile-api-worker chat routes. Archive is a
// channel-level flag (`chatChannels.isArchived`); pin is stored per-user in
// `chatChannels.metadata.pinnedBy[]`; delete removes the caller's membership.
// Each mutation publishes a `chat_channel` entity event (fire-and-forget).
// ===========================================================================

/** PATCH /:channelId/archive — archive the DM for the current user. */
app.patch('/:channelId/archive', requirePermission('messages:update'), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const channelId = c.req.param('channelId');

  try {
    const ok = await setDmArchived(db, channelId, userId, true);
    if (!ok) return error.notFound(c, 'Channel', channelId);

    publishEntityEvent({
      c,
      entityType: 'chat_channel',
      action: 'archived',
      entityId: channelId,
      data: { id: channelId },
    });

    return success(c, { id: channelId, isArchived: true });
  } catch (err) {
    console.error('[app-api/chat-dm] archive failed:', err);
    return error.internal(c, 'Failed to archive DM');
  }
});

/** PATCH /:channelId/unarchive — unarchive the DM for the current user. */
app.patch('/:channelId/unarchive', requirePermission('messages:update'), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const channelId = c.req.param('channelId');

  try {
    const ok = await setDmArchived(db, channelId, userId, false);
    if (!ok) return error.notFound(c, 'Channel', channelId);

    publishEntityEvent({
      c,
      entityType: 'chat_channel',
      action: 'updated',
      entityId: channelId,
      data: { id: channelId },
    });

    return success(c, { id: channelId, isArchived: false });
  } catch (err) {
    console.error('[app-api/chat-dm] unarchive failed:', err);
    return error.internal(c, 'Failed to unarchive DM');
  }
});

/** PATCH /:channelId/pin — pin/unpin the DM for the current user. */
app.patch(
  '/:channelId/pin',
  requirePermission('messages:update'),
  zValidator('json', pinDmSchema),
  async (c) => {
    const db = c.get('tenantDb');
    const userId = c.get('userId');
    const channelId = c.req.param('channelId');
    const { isPinned } = c.req.valid('json');

    try {
      const ok = await setDmPinned(db, channelId, userId, isPinned);
      if (!ok) return error.notFound(c, 'Channel', channelId);

      publishEntityEvent({
        c,
        entityType: 'chat_channel',
        action: 'updated',
        entityId: channelId,
        data: { id: channelId },
      });

      return success(c, { id: channelId, isPinned });
    } catch (err) {
      console.error('[app-api/chat-dm] pin failed:', err);
      return error.internal(c, 'Failed to pin DM');
    }
  },
);

/** DELETE /:channelId — leave the DM (removes the caller's membership row). */
app.delete('/:channelId', requirePermission('messages:delete'), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const channelId = c.req.param('channelId');

  try {
    const ok = await leaveDm(db, channelId, userId);
    if (!ok) return error.notFound(c, 'Channel', channelId);

    publishEntityEvent({
      c,
      entityType: 'chat_channel',
      action: 'left',
      entityId: channelId,
      data: { id: channelId },
    });

    return noContent(c);
  } catch (err) {
    console.error('[app-api/chat-dm] delete failed:', err);
    return error.internal(c, 'Failed to delete DM');
  }
});

export const chatDmRoutes = app;
