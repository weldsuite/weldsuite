/**
 * Support — /api/support/*. Enterprise "Contact Support" channel.
 *
 * Ported from api-worker `src/routes/support.ts` (W3 legacy-worker
 * phase-out). One active support channel per workspace, auto-created on
 * first access; messages + members live in the tenant DB; every endpoint is
 * gated on the workspace being on the `enterprise` plan (master DB lookup).
 *
 * Mount AFTER the global `/api/*` clerkMiddleware() + workspaceDbMiddleware()
 * guard — the tenant DB comes from `c.get('tenantDb')`.
 *
 * Permissions: the api-worker original had no requirePermission() gate (any
 * authenticated workspace member could contact support). We keep that
 * behaviour but attach the `general:read` baseline — the personal/self-scoped
 * pattern used by routes/notifications — so the permission middleware
 * contract still holds without excluding any member from support.
 *
 * Entity events: there is no `support_*` entity type in the
 * @weldsuite/entity-events catalog, so no events are published (realtime
 * fan-out uses the REALTIME binding's `supportEvent`, as before).
 */

import { Hono } from 'hono';
import { eq, and, desc, lt, isNull } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import { RealtimePublisher } from '@weldsuite/realtime/server';
import type { Env, Variables } from '../../types';
import { getMasterDb, masterSchema, schema } from '../../db';
import { success, error } from '../../lib/response';
import { generateId } from '../../lib/id';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

const { workspaces, plans } = masterSchema;
const { supportChannels, supportChannelMembers, supportMessages } = schema;

/**
 * Check if workspace is on enterprise plan.
 */
async function isEnterprisePlan(env: Env, orgId: string): Promise<boolean> {
  const masterDb = getMasterDb(env);
  const [workspace] = await masterDb
    .select({ planId: workspaces.planId })
    .from(workspaces)
    .where(eq(workspaces.clerkOrgId, orgId));
  if (!workspace?.planId) return false;
  const [plan] = await masterDb
    .select({ slug: plans.slug })
    .from(plans)
    .where(eq(plans.id, workspace.planId));
  return plan?.slug === 'enterprise';
}

// ============================================================================
// GET /channel — Get or auto-create the workspace support channel
// ============================================================================

app.get('/channel', requirePermission('general:read'), async (c) => {
  const orgId = c.get('orgId');
  const userId = c.get('userId');
  if (!orgId) return error.orgRequired(c);

  try {
    if (!(await isEnterprisePlan(c.env, orgId))) {
      return error.forbidden(c, 'Contact Support is available on the Enterprise plan.');
    }

    const db = c.get('tenantDb');

    // Check for existing active channel
    const [existing] = await db
      .select()
      .from(supportChannels)
      .where(eq(supportChannels.status, 'active'))
      .limit(1);

    if (existing) {
      const members = await db
        .select()
        .from(supportChannelMembers)
        .where(eq(supportChannelMembers.channelId, existing.id));

      return success(c, { channel: existing, members });
    }

    // Auto-create channel + add requesting user as owner
    const channelId = generateId('sup');
    const memberId = generateId('scm');

    await db.insert(supportChannels).values({
      id: channelId,
      status: 'active',
      memberCount: 1,
    });

    await db.insert(supportChannelMembers).values({
      id: memberId,
      channelId,
      userId,
      role: 'owner',
    });

    const [channel] = await db
      .select()
      .from(supportChannels)
      .where(eq(supportChannels.id, channelId));

    const members = await db
      .select()
      .from(supportChannelMembers)
      .where(eq(supportChannelMembers.channelId, channelId));

    return success(c, { channel, members }, 201);
  } catch (err) {
    console.error('[app-api/support] Get channel error:', err);
    return error.internal(c);
  }
});

// ============================================================================
// GET /messages — List messages with cursor-based pagination
// ============================================================================

app.get('/messages', requirePermission('general:read'), async (c) => {
  const orgId = c.get('orgId');
  if (!orgId) return error.orgRequired(c);

  try {
    if (!(await isEnterprisePlan(c.env, orgId))) {
      return error.forbidden(c, 'Contact Support is available on the Enterprise plan.');
    }

    const db = c.get('tenantDb');
    const before = c.req.query('before');
    const limit = Math.min(100, Math.max(1, Number(c.req.query('limit') || '50')));

    // Get the active channel
    const [channel] = await db
      .select()
      .from(supportChannels)
      .where(eq(supportChannels.status, 'active'))
      .limit(1);

    if (!channel) {
      return success(c, { messages: [], hasMore: false, nextCursor: null });
    }

    const conditions = [
      eq(supportMessages.channelId, channel.id),
      isNull(supportMessages.deletedAt),
    ];

    // Cursor-based pagination: fetch messages older than the cursor
    if (before) {
      const [cursorMsg] = await db
        .select({ createdAt: supportMessages.createdAt })
        .from(supportMessages)
        .where(eq(supportMessages.id, before));

      if (cursorMsg) {
        conditions.push(lt(supportMessages.createdAt, cursorMsg.createdAt));
      }
    }

    const messages = await db
      .select()
      .from(supportMessages)
      .where(and(...conditions))
      .orderBy(desc(supportMessages.createdAt))
      .limit(limit + 1);

    const hasMore = messages.length > limit;
    if (hasMore) messages.pop();

    return success(c, {
      messages,
      hasMore,
      nextCursor: hasMore && messages.length > 0 ? messages[messages.length - 1]!.id : null,
    });
  } catch (err) {
    console.error('[app-api/support] List messages error:', err);
    return error.internal(c);
  }
});

// ============================================================================
// POST /messages — Send a message
// ============================================================================

app.post('/messages', requirePermission('general:read'), async (c) => {
  const orgId = c.get('orgId');
  const userId = c.get('userId');
  if (!orgId) return error.orgRequired(c);

  try {
    if (!(await isEnterprisePlan(c.env, orgId))) {
      return error.forbidden(c, 'Contact Support is available on the Enterprise plan.');
    }

    const body = await c.req.json<{
      content: string;
      authorName: string;
      authorAvatar?: string;
      htmlContent?: string;
      attachments?: Array<{ id: string; fileName: string; fileSize: number; mimeType: string; url: string }>;
    }>();

    if (!body.content?.trim()) {
      return error.badRequest(c, 'Message content is required.');
    }

    const db = c.get('tenantDb');

    // Get or fail on channel
    const [channel] = await db
      .select()
      .from(supportChannels)
      .where(eq(supportChannels.status, 'active'))
      .limit(1);

    if (!channel) {
      return error.notFound(c, 'Support channel');
    }

    const messageId = generateId('smsg');
    const preview = body.content.substring(0, 200);

    await db.insert(supportMessages).values({
      id: messageId,
      channelId: channel.id,
      authorId: userId,
      authorName: body.authorName,
      authorAvatar: body.authorAvatar || null,
      authorType: 'customer',
      content: body.content,
      htmlContent: body.htmlContent || null,
      attachments: body.attachments || null,
    });

    // Update channel stats
    await db
      .update(supportChannels)
      .set({
        lastMessageAt: new Date(),
        lastMessagePreview: preview,
        messageCount: channel.messageCount + 1,
        updatedAt: new Date(),
      })
      .where(eq(supportChannels.id, channel.id));

    const [message] = await db
      .select()
      .from(supportMessages)
      .where(eq(supportMessages.id, messageId));

    // Publish real-time event
    if (c.env.REALTIME) {
      try {
        const rt = new RealtimePublisher(c.env.REALTIME);
        await rt.supportEvent(orgId, 'message', message);
      } catch {
        // Non-critical — message is persisted regardless
      }
    }

    return success(c, message, 201);
  } catch (err) {
    console.error('[app-api/support] Send message error:', err);
    return error.internal(c);
  }
});

// ============================================================================
// GET /members — List channel members
// ============================================================================

app.get('/members', requirePermission('general:read'), async (c) => {
  const orgId = c.get('orgId');
  if (!orgId) return error.orgRequired(c);

  try {
    if (!(await isEnterprisePlan(c.env, orgId))) {
      return error.forbidden(c, 'Contact Support is available on the Enterprise plan.');
    }

    const db = c.get('tenantDb');

    const [channel] = await db
      .select()
      .from(supportChannels)
      .where(eq(supportChannels.status, 'active'))
      .limit(1);

    if (!channel) {
      return success(c, []);
    }

    const members = await db
      .select()
      .from(supportChannelMembers)
      .where(eq(supportChannelMembers.channelId, channel.id));

    return success(c, members);
  } catch (err) {
    console.error('[app-api/support] List members error:', err);
    return error.internal(c);
  }
});

// ============================================================================
// POST /members — Add members to the channel
// ============================================================================

app.post('/members', requirePermission('general:read'), async (c) => {
  const orgId = c.get('orgId');
  if (!orgId) return error.orgRequired(c);

  try {
    if (!(await isEnterprisePlan(c.env, orgId))) {
      return error.forbidden(c, 'Contact Support is available on the Enterprise plan.');
    }

    const { userIds } = await c.req.json<{ userIds: string[] }>();
    if (!userIds?.length) {
      return error.badRequest(c, 'At least one userId is required.');
    }

    const db = c.get('tenantDb');

    const [channel] = await db
      .select()
      .from(supportChannels)
      .where(eq(supportChannels.status, 'active'))
      .limit(1);

    if (!channel) {
      return error.notFound(c, 'Support channel');
    }

    // Get existing member userIds to avoid duplicates
    const existing = await db
      .select({ userId: supportChannelMembers.userId })
      .from(supportChannelMembers)
      .where(eq(supportChannelMembers.channelId, channel.id));

    const existingSet = new Set(existing.map((m) => m.userId));
    const newUserIds = userIds.filter((id) => !existingSet.has(id));

    if (newUserIds.length > 0) {
      await db.insert(supportChannelMembers).values(
        newUserIds.map((uid) => ({
          id: generateId('scm'),
          channelId: channel.id,
          userId: uid,
          role: 'member' as const,
        })),
      );

      await db
        .update(supportChannels)
        .set({
          memberCount: channel.memberCount + newUserIds.length,
          updatedAt: new Date(),
        })
        .where(eq(supportChannels.id, channel.id));
    }

    // Return updated members list
    const members = await db
      .select()
      .from(supportChannelMembers)
      .where(eq(supportChannelMembers.channelId, channel.id));

    // Publish real-time event
    if (c.env.REALTIME && newUserIds.length > 0) {
      try {
        const rt = new RealtimePublisher(c.env.REALTIME);
        await rt.supportEvent(orgId, 'members_changed', { added: newUserIds });
      } catch {
        // Non-critical
      }
    }

    return success(c, members);
  } catch (err) {
    console.error('[app-api/support] Add members error:', err);
    return error.internal(c);
  }
});

// ============================================================================
// DELETE /members/:userId — Remove a member from the channel
// ============================================================================

app.delete('/members/:userId', requirePermission('general:read'), async (c) => {
  const orgId = c.get('orgId');
  if (!orgId) return error.orgRequired(c);

  try {
    if (!(await isEnterprisePlan(c.env, orgId))) {
      return error.forbidden(c, 'Contact Support is available on the Enterprise plan.');
    }

    const targetUserId = c.req.param('userId');
    const db = c.get('tenantDb');

    const [channel] = await db
      .select()
      .from(supportChannels)
      .where(eq(supportChannels.status, 'active'))
      .limit(1);

    if (!channel) {
      return error.notFound(c, 'Support channel');
    }

    // Prevent removing the owner
    const [member] = await db
      .select()
      .from(supportChannelMembers)
      .where(
        and(
          eq(supportChannelMembers.channelId, channel.id),
          eq(supportChannelMembers.userId, targetUserId),
        ),
      );

    if (!member) {
      return error.notFound(c, 'Member', targetUserId);
    }

    if (member.role === 'owner') {
      return error.badRequest(c, 'Cannot remove the channel owner.');
    }

    await db
      .delete(supportChannelMembers)
      .where(eq(supportChannelMembers.id, member.id));

    await db
      .update(supportChannels)
      .set({
        memberCount: Math.max(0, channel.memberCount - 1),
        updatedAt: new Date(),
      })
      .where(eq(supportChannels.id, channel.id));

    // Publish real-time event
    if (c.env.REALTIME) {
      try {
        const rt = new RealtimePublisher(c.env.REALTIME);
        await rt.supportEvent(orgId, 'members_changed', { removed: [targetUserId] });
      } catch {
        // Non-critical
      }
    }

    return success(c, { removed: targetUserId });
  } catch (err) {
    console.error('[app-api/support] Remove member error:', err);
    return error.internal(c);
  }
});

export const supportRoutes = app;
