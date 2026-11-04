/**
 * Lessons learned: /api/project-lessons/*, backed by `project_lessons`
 * (design: weldflow-delivery-and-portfolio.md, "Close a project"; slice F).
 *
 *   GET    /                list (projectId optional, category, search, cursor)
 *   GET    /:id             one lesson
 *   POST   /                add a lesson
 *   PATCH  /:id             edit (its author, or a project manager)
 *   DELETE /:id             soft delete (its author, or a project manager)
 *   POST   /:id/vote        vote for a lesson (no-op when already voted)
 *   DELETE /:id/vote        take the vote back
 *   POST   /publish         one WeldKnow page with every lesson of the project
 *
 * Permissions: projects:read | projects:create | projects:update | projects:delete,
 * plus the project membership boundary (FLOW-001); publishing also takes
 * knowledge:create and an editor role in the teamspace. The checks run in a
 * fixed order so every backend answers alike: permission, then the lesson
 * (404), then project access (403), then the body (400), then the rules.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { and, asc, desc, eq, ilike, isNull, sql, type SQL } from 'drizzle-orm';
import { hasContextPermission, requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { cursorPagination, error, list, noContent, success } from '@weldsuite/worker-kit/response';
import { generateId } from '@weldsuite/worker-kit/id';
import { schema } from '@weldsuite/worker-kit/db';
import {
  LESSON_CATEGORIES,
  createLessonSchema,
  publishLessonsSchema,
  updateLessonSchema,
} from '@weldsuite/app-api-client/schemas/project-closing';
import {
  CLOSING_MESSAGES,
  lessonBlocks,
  lessonEventData,
  lessonsPageTitle,
  mayChangeLesson,
  presentLesson,
} from '@weldsuite/flow-domain/project-closing';
import { SpaceAccessError, SpaceNotFoundError } from '@weldsuite/know-domain/access';
import { createKnowledgePage } from '@weldsuite/know-domain/pages';
import type { Env, Variables } from '../../types';
import { accessibleProjectIds, canAccessProject, canManageProject, canWriteProject, inAccessibleProjects } from '../../lib/project-access';
import { containsPattern, parseLimit } from '../../lib/query-params';
import {
  PROJECT_DENIED,
  PROJECT_WRITE_DENIED,
  parseBody,
  readQuery,
  type AppContext,
} from '../../lib/closing-input';
import { findLiveProject } from '../../services/project-closing';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
const t = schema.projectLessons;
type LessonRow = typeof t.$inferSelect;

const LESSON_LABEL = 'Lesson';

const listQuerySchema = z.object({
  projectId: z.string().optional(),
  category: z.enum(LESSON_CATEGORIES).optional(),
  search: z.string().optional(),
  cursor: z.string().optional(),
  limit: z.string().optional(),
});

// ── Helpers ─────────────────────────────────────────────────────────────────

/** A live lesson by id. */
async function findLesson(c: AppContext, id: string): Promise<LessonRow | null> {
  const [row] = await c
    .get('tenantDb')
    .select()
    .from(t)
    .where(and(eq(t.id, id), isNull(t.deletedAt)))
    .limit(1);
  return row ?? null;
}

type LessonAction = 'created' | 'updated' | 'deleted' | 'published';

function publishLesson(c: AppContext, action: LessonAction, row: LessonRow) {
  publishEntityEvent({
    c,
    entityType: 'project_lesson',
    entityId: row.id,
    action,
    data: lessonEventData(row),
  });
}

// ── Reads ───────────────────────────────────────────────────────────────────

app.get('/', requirePermission('projects:read'), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const query = readQuery(c, listQuerySchema);
  if (!query.ok) return query.response;
  const q = query.data;
  const limit = parseLimit(q.limit, 50, 100);

  const conditions: SQL[] = [isNull(t.deletedAt)];
  if (q.projectId) {
    if (!(await canAccessProject(c, q.projectId))) return error.forbidden(c, PROJECT_DENIED);
    conditions.push(eq(t.projectId, q.projectId));
  } else {
    conditions.push(inAccessibleProjects(t.projectId, await accessibleProjectIds(c)));
  }
  if (q.category) conditions.push(eq(t.category, q.category));
  if (q.search) conditions.push(ilike(t.text, containsPattern(q.search)));
  const countWhere = and(...conditions);
  if (q.cursor) {
    const [cur] = await db.select({ createdAt: t.createdAt, id: t.id }).from(t).where(eq(t.id, q.cursor)).limit(1);
    if (cur) {
      conditions.push(sql`(${t.createdAt} < ${cur.createdAt} OR (${t.createdAt} = ${cur.createdAt} AND ${t.id} < ${cur.id}))`);
    }
  }

  try {
    const [rows, countRes] = await Promise.all([
      db.select().from(t).where(and(...conditions)).orderBy(desc(t.createdAt), desc(t.id)).limit(limit + 1),
      db.select({ count: sql<number>`count(*)` }).from(t).where(countWhere),
    ]);
    const hasMore = rows.length > limit;
    const data = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore && data.length > 0 ? data[data.length - 1].id : null;
    return list(
      c,
      data.map((row) => presentLesson(row, userId)),
      cursorPagination(Number(countRes[0]?.count ?? 0), hasMore, nextCursor),
    );
  } catch (err) {
    console.error('[flow-api/project-lessons] list failed:', err);
    return error.internal(c, 'Failed to list lessons');
  }
});

// ── Publish to WeldKnow ─────────────────────────────────────────────────────

// MUST be before /:id routes that share its verb.
app.post('/publish', requirePermission('projects:update'), requirePermission('knowledge:create'), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const body = await parseBody(c, publishLessonsSchema);
  if (!body.ok) return body.response;
  const input = body.data;

  if (!(await canWriteProject(c, input.projectId))) return error.forbidden(c, PROJECT_WRITE_DENIED);
  const project = await findLiveProject(db, input.projectId);
  if (!project) return error.notFound(c, 'Project', input.projectId);

  try {
    const lessons = await db
      .select()
      .from(t)
      .where(and(eq(t.projectId, input.projectId), isNull(t.deletedAt)))
      .orderBy(asc(t.createdAt), asc(t.id));
    if (lessons.length === 0) return error.badRequest(c, CLOSING_MESSAGES.noLessons);

    const title = lessonsPageTitle(project.name, input.locale ?? 'en', input.title);
    const page = await createKnowledgePage(db, userId, {
      spaceId: input.spaceId,
      title,
      contentJson: lessonBlocks(lessons, input.locale ?? 'en'),
      canManageAll: await hasContextPermission(c, 'knowledge:manage'),
    });

    const now = new Date();
    // Every lesson of the project now points at the page (a later publish makes a new page and moves them over).
    const published = await db
      .update(t)
      .set({ knowPageId: page.id, updatedAt: now })
      .where(and(eq(t.projectId, input.projectId), isNull(t.deletedAt)))
      .returning();

    publishEntityEvent({
      c,
      entityType: 'knowledge_page',
      entityId: page.id,
      action: 'created',
      data: { id: page.id, spaceId: page.spaceId, parentId: null, title: page.title },
    });
    for (const row of published.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : 1))) {
      publishLesson(c, 'published', row);
    }
    return success(c, { pageId: page.id, spaceId: page.spaceId, title: page.title, lessonCount: published.length }, 201);
  } catch (err) {
    if (err instanceof SpaceNotFoundError) return error.notFound(c, err.resource, err.id);
    if (err instanceof SpaceAccessError) return error.forbidden(c, err.message);
    console.error('[flow-api/project-lessons] publish failed:', err);
    return error.internal(c, 'Failed to publish the lessons');
  }
});

app.get('/:id', requirePermission('projects:read'), async (c) => {
  const id = c.req.param('id');
  try {
    const row = await findLesson(c, id);
    if (!row) return error.notFound(c, LESSON_LABEL, id);
    if (!(await canAccessProject(c, row.projectId))) return error.forbidden(c, PROJECT_DENIED);
    return success(c, presentLesson(row, c.get('userId')));
  } catch (err) {
    console.error('[flow-api/project-lessons] get failed:', err);
    return error.internal(c, 'Failed to fetch lesson');
  }
});

// ── Create ──────────────────────────────────────────────────────────────────

app.post('/', requirePermission('projects:create'), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const body = await parseBody(c, createLessonSchema);
  if (!body.ok) return body.response;
  const input = body.data;

  if (!(await canWriteProject(c, input.projectId))) return error.forbidden(c, PROJECT_WRITE_DENIED);
  if (!(await findLiveProject(db, input.projectId))) return error.notFound(c, 'Project', input.projectId);

  try {
    const now = new Date();
    const id = generateId('les');
    await db.insert(t).values({
      id,
      projectId: input.projectId,
      category: input.category,
      text: input.text,
      authorId: userId,
      votes: [],
      knowPageId: null,
      createdBy: userId,
      createdAt: now,
      updatedAt: now,
    });
    const row = await findLesson(c, id);
    if (!row) return error.internal(c, 'Failed to create lesson');
    publishLesson(c, 'created', row);
    return success(c, presentLesson(row, userId), 201);
  } catch (err) {
    console.error('[flow-api/project-lessons] create failed:', err);
    return error.internal(c, 'Failed to create lesson');
  }
});

// ── Edit ────────────────────────────────────────────────────────────────────

app.patch('/:id', requirePermission('projects:update'), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const id = c.req.param('id');
  const existing = await findLesson(c, id);
  if (!existing) return error.notFound(c, LESSON_LABEL, id);
  if (!(await canWriteProject(c, existing.projectId))) return error.forbidden(c, PROJECT_WRITE_DENIED);
  const body = await parseBody(c, updateLessonSchema);
  if (!body.ok) return body.response;
  if (!mayChangeLesson(existing, userId, await canManageProject(c, existing.projectId))) {
    return error.forbidden(c, CLOSING_MESSAGES.notAuthor);
  }

  try {
    const set: Partial<typeof t.$inferInsert> = { updatedAt: new Date() };
    if (body.data.category !== undefined) set.category = body.data.category;
    if (body.data.text !== undefined) set.text = body.data.text;
    await db.update(t).set(set).where(and(eq(t.id, id), isNull(t.deletedAt)));
    const row = await findLesson(c, id);
    if (!row) return error.notFound(c, LESSON_LABEL, id);
    publishLesson(c, 'updated', row);
    return success(c, presentLesson(row, userId));
  } catch (err) {
    console.error('[flow-api/project-lessons] update failed:', err);
    return error.internal(c, 'Failed to update lesson');
  }
});

// ── Delete ──────────────────────────────────────────────────────────────────

app.delete('/:id', requirePermission('projects:delete'), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const id = c.req.param('id');
  try {
    const existing = await findLesson(c, id);
    if (!existing) return error.notFound(c, LESSON_LABEL, id);
    if (!(await canWriteProject(c, existing.projectId))) return error.forbidden(c, PROJECT_WRITE_DENIED);
    if (!mayChangeLesson(existing, userId, await canManageProject(c, existing.projectId))) {
      return error.forbidden(c, CLOSING_MESSAGES.notAuthor);
    }

    const now = new Date();
    await db.update(t).set({ deletedAt: now, updatedAt: now }).where(and(eq(t.id, id), isNull(t.deletedAt)));
    publishEntityEvent({
      c,
      entityType: 'project_lesson',
      entityId: id,
      action: 'deleted',
      data: { id, projectId: existing.projectId, category: existing.category },
    });
    return noContent(c);
  } catch (err) {
    console.error('[flow-api/project-lessons] delete failed:', err);
    return error.internal(c, 'Failed to delete lesson');
  }
});

// ── Votes ───────────────────────────────────────────────────────────────────

/**
 * Add or take back the caller's vote. The array is changed in the database,
 * not read and written back, so two votes at once cannot lose one. Answers the
 * lesson; the `updated` event is published only when the vote set changed.
 */
async function changeVote(c: AppContext, id: string, vote: boolean) {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  try {
    const existing = await findLesson(c, id);
    if (!existing) return error.notFound(c, LESSON_LABEL, id);
    if (!(await canWriteProject(c, existing.projectId))) return error.forbidden(c, PROJECT_WRITE_DENIED);

    const had = existing.votes.includes(userId);
    if (had === vote) return success(c, presentLesson(existing, userId));

    const votes = vote
      ? sql`CASE WHEN jsonb_exists(${t.votes}, ${userId}) THEN ${t.votes} ELSE ${t.votes} || jsonb_build_array(${userId}::text) END`
      : sql`${t.votes} - ${userId}::text`;
    await db
      .update(t)
      .set({ votes, updatedAt: new Date() })
      .where(and(eq(t.id, id), isNull(t.deletedAt)));
    const row = await findLesson(c, id);
    if (!row) return error.notFound(c, LESSON_LABEL, id);
    publishLesson(c, 'updated', row);
    return success(c, presentLesson(row, userId));
  } catch (err) {
    console.error('[flow-api/project-lessons] vote failed:', err);
    return error.internal(c, vote ? 'Failed to vote for lesson' : 'Failed to take back the vote');
  }
}

app.post('/:id/vote', requirePermission('projects:update'), (c) => changeVote(c, c.req.param('id'), true));
app.delete('/:id/vote', requirePermission('projects:update'), (c) => changeVote(c, c.req.param('id'), false));

export const projectLessonsRoutes = app;
