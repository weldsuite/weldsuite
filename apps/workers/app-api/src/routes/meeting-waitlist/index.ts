/**
 * Waitlist entry routes — flat /api/meeting-waitlist/* surface backed by `meetingSessionWaitlist`.
 *
 * Permissions: meetings:read | meetings:create | meetings:update | meetings:delete.
 *
 * Action endpoints (static paths registered BEFORE /:id):
 *   POST /:id/admit — admit a pending waitlist entry (organizer only)
 *   POST /:id/deny  — deny a pending waitlist entry (organizer only)
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, desc, eq, isNull, like, sql } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { createMeetingWaitlistEntrySchema, updateMeetingWaitlistEntrySchema } from '@weldsuite/core-api-client/schemas/meeting-waitlist';
import type { Env, Variables } from '../../types';
import { cursorPagination, error, list, noContent, success } from '../../lib/response';
import { generateId } from '../../lib/id';
import { schema } from '../../db';
import { decideWaitlist } from '../../services/weldmeet/waitlist';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
const t = schema.meetingSessionWaitlist;

// ============================================================================
// Action endpoints — registered BEFORE /:id CRUD
// ============================================================================

/**
 * POST /:id/admit - Admit a pending waitlist entry.
 * Only the meeting organizer may perform this action.
 */
app.post('/:id/admit', requirePermission('meetings:read'), async (c) => {
  const orgId = c.get('orgId');
  if (!orgId) return error.orgRequired(c);

  const entryId = c.req.param('id');
  const userId = c.get('userId');

  try {
    const db = c.get('tenantDb');

    // Verify organizer access by looking up the meeting via the waitlist entry
    const [entry] = await db
      .select({ meetingId: t.meetingId })
      .from(t)
      .where(eq(t.id, entryId))
      .limit(1);
    if (!entry) return error.notFound(c, 'Waitlist entry', entryId);

    const { meetings } = schema;
    const [meeting] = await db
      .select({ organizerId: meetings.organizerId })
      .from(meetings)
      .where(and(eq(meetings.id, entry.meetingId), isNull(meetings.deletedAt)))
      .limit(1);
    if (!meeting) return error.notFound(c, 'Meeting', entry.meetingId);
    if (meeting.organizerId !== userId) {
      return error.forbidden(c, 'Only the organizer can manage the waitlist');
    }

    const outcome = await decideWaitlist(db, { id: entryId, decidedBy: userId, admit: true });
    if (outcome.kind === 'not-found') return error.notFound(c, 'Waitlist entry', entryId);
    if (outcome.kind === 'already-decided') return error.badRequest(c, 'Waitlist entry is already resolved');

    publishEntityEvent({
      c,
      entityType: 'meeting_waitlist',
      entityId: entryId,
      action: 'updated',
      data: { id: entryId, meetingId: entry.meetingId, status: 'admitted' },
    });

    return success(c, outcome.entry);
  } catch (err) {
    console.error('[app-api/meeting-waitlist] admit failed:', err);
    return error.internal(c, 'Failed to admit waitlist entry');
  }
});

/**
 * POST /:id/deny - Deny a pending waitlist entry.
 * Only the meeting organizer may perform this action.
 */
app.post('/:id/deny', requirePermission('meetings:read'), async (c) => {
  const orgId = c.get('orgId');
  if (!orgId) return error.orgRequired(c);

  const entryId = c.req.param('id');
  const userId = c.get('userId');

  try {
    const db = c.get('tenantDb');

    const [entry] = await db
      .select({ meetingId: t.meetingId })
      .from(t)
      .where(eq(t.id, entryId))
      .limit(1);
    if (!entry) return error.notFound(c, 'Waitlist entry', entryId);

    const { meetings } = schema;
    const [meeting] = await db
      .select({ organizerId: meetings.organizerId })
      .from(meetings)
      .where(and(eq(meetings.id, entry.meetingId), isNull(meetings.deletedAt)))
      .limit(1);
    if (!meeting) return error.notFound(c, 'Meeting', entry.meetingId);
    if (meeting.organizerId !== userId) {
      return error.forbidden(c, 'Only the organizer can manage the waitlist');
    }

    const outcome = await decideWaitlist(db, { id: entryId, decidedBy: userId, admit: false });
    if (outcome.kind === 'not-found') return error.notFound(c, 'Waitlist entry', entryId);
    if (outcome.kind === 'already-decided') return error.badRequest(c, 'Waitlist entry is already resolved');

    publishEntityEvent({
      c,
      entityType: 'meeting_waitlist',
      entityId: entryId,
      action: 'updated',
      data: { id: entryId, meetingId: entry.meetingId, status: 'denied' },
    });

    return success(c, outcome.entry);
  } catch (err) {
    console.error('[app-api/meeting-waitlist] deny failed:', err);
    return error.internal(c, 'Failed to deny waitlist entry');
  }
});

// ============================================================================
// CRUD
// ============================================================================

app.get('/', requirePermission('meetings:read'), async (c) => {
  const db = c.get('tenantDb');
  const q = c.req.query();
  const limit = Math.min(q.limit ? parseInt(q.limit, 10) : 25, 100);

  const conditions: any[] = [];
  if (q.sessionId !== undefined && q.sessionId !== '') conditions.push(eq(t.sessionId, q.sessionId));
  if (q.status !== undefined && q.status !== '') conditions.push(eq(t.status, q.status));
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
    console.error('[app-api/meeting-waitlist] list failed:', err);
    return error.internal(c, 'Failed to list waitlist entrys');
  }
});

app.get('/:id', requirePermission('meetings:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const [row] = await db.select().from(t).where(eq(t.id, id)).limit(1);
    if (!row) return error.notFound(c, 'Waitlist entry', id);
    return success(c, row);
  } catch (err) {
    console.error('[app-api/meeting-waitlist] get failed:', err);
    return error.internal(c, 'Failed to fetch waitlist entry');
  }
});

app.post('/', requirePermission('meetings:create'), zValidator('json', createMeetingWaitlistEntrySchema), async (c) => {
  const db = c.get('tenantDb');
  const data = c.req.valid('json') as Record<string, any>;
  const id = generateId('wl');
  const now = new Date();
  try {
    await db.insert(t).values({ id, ...data, createdAt: now, updatedAt: now } as unknown as typeof t.$inferInsert);
    publishEntityEvent({
      c,
      entityType: 'meeting_waitlist',
      entityId: id,
      action: 'created',
      data: {
        id,
        meetingId: data.meetingId as string,
        name: data.name as string,
        email: data.email as string,
        status: (data.status as string | undefined) ?? 'pending',
      },
    });
    return success(c, { id }, 201);
  } catch (err) {
    console.error('[app-api/meeting-waitlist] create failed:', err);
    return error.internal(c, 'Failed to create waitlist entry');
  }
});

app.patch('/:id', requirePermission('meetings:update'), zValidator('json', updateMeetingWaitlistEntrySchema), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const data = c.req.valid('json') as Record<string, any>;
  try {
    const [existing] = await db.select().from(t).where(eq(t.id, id)).limit(1);
    if (!existing) return error.notFound(c, 'Waitlist entry', id);
    const update: Record<string, any> = { updatedAt: new Date() };
    for (const [k, v] of Object.entries(data)) if (v !== undefined) update[k] = v;
    await db.update(t).set(update).where(eq(t.id, id));
    publishEntityEvent({
      c,
      entityType: 'meeting_waitlist',
      entityId: id,
      action: 'updated',
      data: {
        id,
        meetingId: (update.meetingId as string | undefined) ?? existing.meetingId,
        name: (update.name as string | undefined) ?? existing.name,
        email: (update.email as string | undefined) ?? existing.email,
        status: (update.status as string | undefined) ?? existing.status,
      },
    });
    return success(c, { id });
  } catch (err) {
    console.error('[app-api/meeting-waitlist] update failed:', err);
    return error.internal(c, 'Failed to update waitlist entry');
  }
});

app.delete('/:id', requirePermission('meetings:delete'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const [existing] = await db.select().from(t).where(eq(t.id, id)).limit(1);
    if (!existing) return error.notFound(c, 'Waitlist entry', id);
    await db.delete(t).where(eq(t.id, id));
    publishEntityEvent({
      c,
      entityType: 'meeting_waitlist',
      entityId: id,
      action: 'deleted',
      data: { id },
    });
    return noContent(c);
  } catch (err) {
    console.error('[app-api/meeting-waitlist] delete failed:', err);
    return error.internal(c, 'Failed to delete waitlist entry');
  }
});

export const meetingWaitlistRoutes = app;
