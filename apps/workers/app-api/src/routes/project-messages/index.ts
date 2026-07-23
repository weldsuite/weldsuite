/**
 * Project message routes — /api/project-messages/*.
 *
 * Project-scoped chat. Sender ownership is enforced on update/delete so users
 * can't edit each other's messages. Reactions are toggled via POST /:id/reactions.
 *
 * Permissions: projects:read | projects:create | projects:update | projects:delete.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import type { Env, Variables } from '../../types';
import { error, list, noContent, success } from '../../lib/response';
import { generateId } from '../../lib/id';
import { schema } from '../../db';
import { accessibleProjectIds, canAccessProject } from '../../lib/project-access';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
const t = schema.projectMessages;

const PROJECT_DENIED = 'You are not a member of this project';

const listFiltersSchema = z.object({
  projectId: z.string().optional(),
  senderId: z.string().optional(),
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

const createMessageSchema = z.object({
  projectId: z.string().min(1),
  message: z.string().min(1),
  messageType: z.string().default('text'),
  replyToId: z.string().optional(),
  attachments: z.unknown().optional(),
  metadata: z.record(z.unknown()).optional(),
});

const updateMessageSchema = z.object({
  message: z.string().min(1).optional(),
  isPinned: z.boolean().optional(),
});

const reactionSchema = z.object({
  emoji: z.string().min(1),
});

// ============================================================================
// GET / — list chronological (oldest first) so the chat scrolls correctly
// ============================================================================

app.get('/', requirePermission('projects:read'), zValidator('query', listFiltersSchema), async (c) => {
  const db = c.get('tenantDb');
  const f = c.req.valid('query');
  const page = f.page ?? 1;
  const limit = f.limit ?? 50;
  const offset = (page - 1) * limit;

  const conditions: any[] = [isNull(t.deletedAt)];
  if (f.projectId) conditions.push(eq(t.projectId, f.projectId));
  if (f.projectId) {
    if (!(await canAccessProject(c, f.projectId))) return error.forbidden(c, PROJECT_DENIED);
  } else {
    const accessible = await accessibleProjectIds(c);
    if (accessible !== null) conditions.push(inArray(t.projectId, accessible.length ? accessible : ['']));
  }
  if (f.senderId) conditions.push(eq(t.senderId, f.senderId));
  const where = and(...conditions);

  try {
    const [rows, countRes] = await Promise.all([
      db.select().from(t).where(where).orderBy(asc(t.createdAt)).limit(limit).offset(offset),
      db.select({ count: sql<number>`count(*)::int` }).from(t).where(where),
    ]);
    const totalCount = Number(countRes[0]?.count ?? 0);
    return list(c, rows, {
      totalCount,
      hasMore: offset + rows.length < totalCount,
      cursor: null,
    });
  } catch (err) {
    console.error('[app-api/project-messages] list failed:', err);
    return error.internal(c, 'Failed to list project messages');
  }
});

// ============================================================================
// GET /:id
// ============================================================================

app.get('/:id', requirePermission('projects:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const [row] = await db.select().from(t).where(and(eq(t.id, id), isNull(t.deletedAt))).limit(1);
    if (!row) return error.notFound(c, 'Project message', id);
    if (row.projectId && !(await canAccessProject(c, row.projectId))) {
      return error.forbidden(c, PROJECT_DENIED);
    }
    return success(c, row);
  } catch (err) {
    console.error('[app-api/project-messages] get failed:', err);
    return error.internal(c, 'Failed to fetch project message');
  }
});

// ============================================================================
// POST / — create. senderId is inferred from the Clerk session.
// conversationId is set to projectId (project chat uses one room per project).
// ============================================================================

app.post(
  '/',
  requirePermission('projects:create'),
  zValidator('json', createMessageSchema),
  async (c) => {
    const db = c.get('tenantDb');
    const userId = c.get('userId');
    if (!userId) return error.unauthorized(c);
    const data = c.req.valid('json');
    const id = generateId('pmsg');
    const now = new Date();
    if (!(await canAccessProject(c, data.projectId))) {
      return error.forbidden(c, PROJECT_DENIED);
    }
    try {
      await db.insert(t).values({
        id,
        projectId: data.projectId,
        conversationId: data.projectId,
        senderId: userId,
        message: data.message,
        messageType: data.messageType ?? 'text',
        replyToId: data.replyToId ?? null,
        attachments: (data.attachments as any) ?? null,
        metadata: (data.metadata as any) ?? null,
        isRead: false,
        createdAt: now,
        updatedAt: now,
      } as unknown as typeof t.$inferInsert);
      publishEntityEvent({
        c,
        entityType: 'project_message',
        entityId: id,
        action: 'created',
        data: { id, projectId: data.projectId, senderId: userId },
      });
      return success(c, { id, projectId: data.projectId, senderId: userId, message: data.message }, 201);
    } catch (err) {
      console.error('[app-api/project-messages] create failed:', err);
      return error.internal(c, 'Failed to create project message');
    }
  },
);

// ============================================================================
// PATCH /:id — message edit. Only the sender can edit; sets editedAt.
// ============================================================================

app.patch(
  '/:id',
  requirePermission('projects:update'),
  zValidator('json', updateMessageSchema),
  async (c) => {
    const db = c.get('tenantDb');
    const id = c.req.param('id');
    const userId = c.get('userId');
    const data = c.req.valid('json');
    try {
      const [existing] = await db
        .select({ senderId: t.senderId })
        .from(t)
        .where(and(eq(t.id, id), isNull(t.deletedAt)))
        .limit(1);
      if (!existing) return error.notFound(c, 'Project message', id);
      if (existing.senderId !== userId) {
        return error.forbidden(c, 'You can only edit your own messages');
      }
      const update: Record<string, any> = { updatedAt: new Date() };
      if (data.message !== undefined) {
        update.message = data.message;
        update.editedAt = new Date();
      }
      if (data.isPinned !== undefined) update.isPinned = data.isPinned;
      await db.update(t).set(update).where(eq(t.id, id));
      publishEntityEvent({
        c,
        entityType: 'project_message',
        entityId: id,
        action: 'updated',
        data: { id, ...data },
      });
      return success(c, { id, ...data });
    } catch (err) {
      console.error('[app-api/project-messages] update failed:', err);
      return error.internal(c, 'Failed to update project message');
    }
  },
);

// ============================================================================
// POST /:id/reactions — toggle a reaction by emoji (add if absent, remove
// if present). Matches the api-worker contract the frontend already uses.
// ============================================================================

app.post(
  '/:id/reactions',
  requirePermission('projects:update'),
  zValidator('json', reactionSchema),
  async (c) => {
    const db = c.get('tenantDb');
    const id = c.req.param('id');
    const userId = c.get('userId');
    if (!userId) return error.unauthorized(c);
    const { emoji } = c.req.valid('json');
    try {
      const [existing] = await db
        .select({ reactions: t.reactions, projectId: t.projectId })
        .from(t)
        .where(and(eq(t.id, id), isNull(t.deletedAt)))
        .limit(1);
      if (!existing) return error.notFound(c, 'Project message', id);
      if (existing.projectId && !(await canAccessProject(c, existing.projectId))) {
        return error.forbidden(c, PROJECT_DENIED);
      }
      const reactions = ((existing.reactions as Record<string, string[]> | null) ?? {});
      const list = reactions[emoji] ?? [];
      const idx = list.indexOf(userId);
      if (idx >= 0) list.splice(idx, 1);
      else list.push(userId);
      if (list.length === 0) delete reactions[emoji];
      else reactions[emoji] = list;
      await db.update(t).set({ reactions, updatedAt: new Date() }).where(eq(t.id, id));
      publishEntityEvent({
        c,
        entityType: 'project_message',
        entityId: id,
        action: 'updated',
        data: { id, reactions },
      });
      return success(c, { id, reactions });
    } catch (err) {
      console.error('[app-api/project-messages] reaction toggle failed:', err);
      return error.internal(c, 'Failed to toggle reaction');
    }
  },
);

// ============================================================================
// DELETE /:id — only the sender can delete their message
// ============================================================================

app.delete('/:id', requirePermission('projects:delete'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const userId = c.get('userId');
  try {
    const [existing] = await db
      .select({ senderId: t.senderId })
      .from(t)
      .where(and(eq(t.id, id), isNull(t.deletedAt)))
      .limit(1);
    if (!existing) return error.notFound(c, 'Project message', id);
    if (existing.senderId !== userId) {
      return error.forbidden(c, 'You can only delete your own messages');
    }
    await db.update(t).set({ deletedAt: new Date(), updatedAt: new Date() }).where(eq(t.id, id));
    publishEntityEvent({
      c,
      entityType: 'project_message',
      entityId: id,
      action: 'deleted',
      data: { id },
    });
    return noContent(c);
  } catch (err) {
    console.error('[app-api/project-messages] delete failed:', err);
    return error.internal(c, 'Failed to delete project message');
  }
});

export const projectMessagesRoutes = app;
