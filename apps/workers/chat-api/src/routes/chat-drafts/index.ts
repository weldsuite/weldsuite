/**
 * Chat draft routes — flat /api/chat-drafts/* surface backed by `chatDrafts`.
 *
 * Permissions: channels:read for everything. Drafts are personal resources —
 * every route below is hard-scoped to the authenticated user, so the baseline
 * chat permission suffices. Gating writes on channels:create/update/delete
 * (channel management tiers) broke autosave for MEMBER-role users, who hold
 * neither; the legacy core-api routes were ungated and userId-scoped.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import { createChatDraftSchema, updateChatDraftSchema } from '@weldsuite/core-api-client/schemas/chat-drafts';
import type { Env, Variables } from '../../types';
import { cursorPagination, error, list, noContent, success } from '@weldsuite/worker-kit/response';
import { generateId } from '@weldsuite/worker-kit/id';
import { schema } from '@weldsuite/worker-kit/db';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
const t = schema.chatDrafts;

/** SQL condition: the draft has text or at least one attachment. */
const hasDraftBody = sql`(
  btrim(${t.content}) <> ''
  OR (jsonb_typeof(${t.attachments}) = 'array' AND jsonb_array_length(${t.attachments}) > 0)
)`;

/** True when there is neither non-whitespace text nor an attachment to keep. */
function isEmptyDraft(content: unknown, attachments: unknown): boolean {
  const hasText = typeof content === 'string' && content.trim().length > 0;
  const hasAttachments = Array.isArray(attachments) && attachments.length > 0;
  return !hasText && !hasAttachments;
}

app.get('/', requirePermission('channels:read'), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const q = c.req.query();
  const limit = Math.min(q.limit ? Number.parseInt(q.limit, 10) : 25, 100);

  // Owner boundary: a draft is private to its author. Always scope to the
  // caller — never trust a body/query-supplied userId.
  // Empty drafts (no text, no attachments) are never listed, even when an
  // older client left one behind.
  const conditions: any[] = [eq(t.userId, userId), hasDraftBody];
  if (q.channelId !== undefined && q.channelId !== '') conditions.push(eq(t.channelId, q.channelId));
  // Snapshot the filter set BEFORE the cursor predicate is (conditionally)
  // pushed — a stale cursor id finds no row and pushes nothing, so slicing
  // the last element off afterwards would drop a real filter instead.
  const filterConditions = [...conditions];
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
    console.error('[app-api/chat-drafts] list failed:', err);
    return error.internal(c, 'Failed to list chat drafts');
  }
});

app.get('/:id', requirePermission('channels:read'), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const id = c.req.param('id');
  try {
    const [row] = await db
      .select()
      .from(t)
      .where(and(eq(t.id, id), eq(t.userId, userId)))
      .limit(1);
    if (!row) return error.notFound(c, 'Chat draft', id);
    return success(c, row);
  } catch (err) {
    console.error('[app-api/chat-drafts] get failed:', err);
    return error.internal(c, 'Failed to fetch chat draft');
  }
});

app.post('/', requirePermission('channels:read'), zValidator('json', createChatDraftSchema), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const workspaceId = c.get('workspaceId') || c.get('orgId');
  if (!workspaceId) return error.orgRequired(c);
  const data = c.req.valid('json') as Record<string, any>;
  const id = generateId('cdft');
  const now = new Date();
  try {
    // Stamp the authenticated caller as the owner + tenant — ignore any
    // body-supplied userId / workspaceId.
    const { userId: _ignoredUserId, workspaceId: _ignoredWorkspaceId, ...rest } = data;

    // An empty draft is never stored: it means "no draft at this location", so
    // clear whatever is there and answer success without creating a row.
    if (isEmptyDraft(rest.content ?? rest.body, rest.attachments)) {
      const channelId = typeof rest.channelId === 'string' ? rest.channelId : null;
      const threadParentMessageId =
        typeof rest.threadParentMessageId === 'string' ? rest.threadParentMessageId : null;
      const removed = await db
        .delete(t)
        .where(
          and(
            eq(t.userId, userId),
            channelId === null ? isNull(t.channelId) : eq(t.channelId, channelId),
            threadParentMessageId === null
              ? isNull(t.threadParentMessageId)
              : eq(t.threadParentMessageId, threadParentMessageId),
          ),
        )
        .returning({ id: t.id });
      return success(c, { id: removed[0]?.id ?? null, deleted: removed.length > 0 });
    }
    await db
      .insert(t)
      .values({ ...rest, id, userId, workspaceId, createdAt: now, updatedAt: now } as unknown as typeof t.$inferInsert);
    return success(c, { id }, 201);
  } catch (err) {
    console.error('[app-api/chat-drafts] create failed:', err);
    return error.internal(c, 'Failed to create chat draft');
  }
});

app.patch('/:id', requirePermission('channels:read'), zValidator('json', updateChatDraftSchema), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const id = c.req.param('id');
  const data = c.req.valid('json') as Record<string, any>;
  try {
    const [existing] = await db
      .select()
      .from(t)
      .where(and(eq(t.id, id), eq(t.userId, userId)))
      .limit(1);
    if (!existing) return error.notFound(c, 'Chat draft', id);
    // A draft that would end up empty is deleted instead of stored empty.
    const nextContent = data.content !== undefined ? data.content : existing.content;
    const nextAttachments = data.attachments !== undefined ? data.attachments : existing.attachments;
    if (isEmptyDraft(nextContent, nextAttachments)) {
      await db.delete(t).where(and(eq(t.id, id), eq(t.userId, userId)));
      return success(c, { id, deleted: true });
    }
    const update: Record<string, any> = { updatedAt: new Date() };
    for (const [k, v] of Object.entries(data)) if (v !== undefined && k !== 'userId') update[k] = v;
    await db.update(t).set(update).where(and(eq(t.id, id), eq(t.userId, userId)));
    return success(c, { id });
  } catch (err) {
    console.error('[app-api/chat-drafts] update failed:', err);
    return error.internal(c, 'Failed to update chat draft');
  }
});

app.delete('/:id', requirePermission('channels:read'), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const id = c.req.param('id');
  try {
    const [existing] = await db
      .select()
      .from(t)
      .where(and(eq(t.id, id), eq(t.userId, userId)))
      .limit(1);
    if (!existing) return error.notFound(c, 'Chat draft', id);
    await db.delete(t).where(and(eq(t.id, id), eq(t.userId, userId)));
    return noContent(c);
  } catch (err) {
    console.error('[app-api/chat-drafts] delete failed:', err);
    return error.internal(c, 'Failed to delete chat draft');
  }
});

export const chatDraftsRoutes = app;
