/**
 * Activities routes — flat /api/activities/* surface backed by `crm_activities`.
 *
 * A CRM activity is a call/email/meeting/task/note attached to a contact /
 * customer / lead / opportunity. Assigned to a user via `assignedToId`
 * (defaults to the caller).
 *
 * Permissions: activities:read | activities:create | activities:update | activities:delete.
 *   activities:scope:all elevates from own-only default to cross-owner access.
 */

import { Hono, type Context } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, desc, eq, isNull, like, or, sql } from 'drizzle-orm';
import { publishEntityEvent } from '@weldsuite/entity-events';
import {
  ensurePermissionsResolved,
  requirePermission,
} from '@weldsuite/permissions/server';
import { hasPermission } from '@weldsuite/permissions';
import {
  createActivitySchema,
  updateActivitySchema,
} from '@weldsuite/core-api-client/schemas/activities';
import type { Env, Variables } from '../../types';
import { cursorPagination, error, list, noContent, success } from '../../lib/response';
import { generateId } from '../../lib/id';
import {
  syncValuesForEntity,
  hydrateCustomFields,
  hydrateCustomFieldsOne,
} from '../../services/custom-field-values';
import { schema } from '../../db';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
const t = schema.crmActivities;

async function scopeFor(c: Context<{ Bindings: Env; Variables: Variables }>): Promise<string | undefined> {
  const resolved = await ensurePermissionsResolved(c);
  const perms = resolved?.permissions ?? [];
  if (hasPermission(perms, 'activities:scope:all')) return undefined;
  return c.get('userId');
}

const DATE_FIELDS = new Set(['dueDate', 'startTime', 'endTime', 'followUpDate']);

app.get('/', requirePermission('activities:read'), async (c) => {
  const db = c.get('tenantDb');
  const q = c.req.query();
  const limit = Math.min(q.limit ? parseInt(q.limit, 10) : 25, 100);
  const scope = await scopeFor(c);

  const conditions: any[] = [isNull(t.deletedAt)];
  if (scope) conditions.push(eq(t.assignedToId, scope));
  if (q.type) conditions.push(eq(t.type, q.type));
  if (q.status) conditions.push(eq(t.status, q.status));
  if (q.assignedToId) conditions.push(eq(t.assignedToId, q.assignedToId));
  if (q.customerId) conditions.push(eq(t.customerId, q.customerId));
  if (q.contactId) conditions.push(eq(t.contactId, q.contactId));
  if (q.leadId) conditions.push(eq(t.leadId, q.leadId));
  if (q.opportunityId) conditions.push(eq(t.opportunityId, q.opportunityId));
  if (q.search) {
    const term = `%${q.search}%`;
    conditions.push(or(like(t.subject, term), like(t.description, term))!);
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
  const where = and(...conditions);
  const filterConditions = q.cursor ? conditions.slice(0, -1) : conditions;

  try {
    const [rows, countRes] = await Promise.all([
      db.select().from(t).where(where).orderBy(desc(t.createdAt), desc(t.id)).limit(limit + 1),
      db.select({ count: sql<number>`count(*)` }).from(t).where(and(...filterConditions)),
    ]);
    const hasMore = rows.length > limit;
    const data = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore && data.length > 0 ? data[data.length - 1].id : null;
    const totalCount = Number(countRes[0]?.count ?? 0);
    // Phase 3: customFields comes from the typed values table, not the blob.
    const hydrated = await hydrateCustomFields(db, 'activity', data);
    return list(c, hydrated, cursorPagination(totalCount, hasMore, nextCursor));
  } catch (err) {
    console.error('[app-api/activities] list failed:', err);
    return error.internal(c, 'Failed to list activities');
  }
});

app.get('/:id', requirePermission('activities:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const scope = await scopeFor(c);
  const conditions: any[] = [eq(t.id, id), isNull(t.deletedAt)];
  if (scope) conditions.push(eq(t.assignedToId, scope));
  try {
    const [row] = await db.select().from(t).where(and(...conditions)).limit(1);
    if (!row) return error.notFound(c, 'Activity', id);
    // Phase 3: customFields comes from the typed values table, not the blob.
    return success(c, await hydrateCustomFieldsOne(db, 'activity', row));
  } catch (err) {
    console.error('[app-api/activities] get failed:', err);
    return error.internal(c, 'Failed to fetch activity');
  }
});

app.post('/', requirePermission('activities:create'), zValidator('json', createActivitySchema), async (c) => {
  const db = c.get('tenantDb');
  const data = c.req.valid('json');
  const userId = c.get('userId');
  const assignedToId = data.assignedToId ?? userId;
  if (!assignedToId) return error.badRequest(c, 'assignedToId required');
  const id = generateId('act');
  const now = new Date();
  try {
    const values: typeof t.$inferInsert = {
      id,
      type: data.type,
      subject: data.subject,
      description: data.description,
      relatedTo: data.relatedTo,
      relatedToId: data.relatedToId,
      relatedToName: data.relatedToName,
      customerId: data.customerId,
      contactId: data.contactId,
      leadId: data.leadId,
      opportunityId: data.opportunityId,
      assignedToId,
      dueDate: data.dueDate ? new Date(data.dueDate) : undefined,
      startTime: data.startTime ? new Date(data.startTime) : undefined,
      endTime: data.endTime ? new Date(data.endTime) : undefined,
      duration: data.duration,
      status: data.status ?? 'planned',
      priority: data.priority ?? 'medium',
      location: data.location,
      isVirtual: data.isVirtual,
      meetingUrl: data.meetingUrl,
      callDirection: data.callDirection,
      callDuration: data.callDuration,
      callRecordingUrl: data.callRecordingUrl,
      emailMessageId: data.emailMessageId,
      emailSubject: data.emailSubject,
      emailFrom: data.emailFrom,
      emailTo: data.emailTo,
      emailCc: data.emailCc,
      attendees: data.attendees,
      meetingAgenda: data.meetingAgenda,
      meetingNotes: data.meetingNotes,
      outcome: data.outcome,
      nextAction: data.nextAction,
      followUpDate: data.followUpDate ? new Date(data.followUpDate) : undefined,
      attachments: data.attachments,
      calendarEventId: data.calendarEventId,
      tags: data.tags,
      customFields: data.customFields as Record<string, unknown> | null | undefined,
      createdAt: now,
      updatedAt: now,
    };
    await db.insert(t).values(values);
    // Phase 1 dual-write: mirror the customFields blob into the typed values table.
    await syncValuesForEntity(db, 'activity', id, data.customFields as Record<string, unknown> | null | undefined);
    publishEntityEvent({
      c,
      entityType: 'activity',
      entityId: id,
      action: 'created',
      data: {
        id,
        type: values.type,
        subject: values.subject,
        status: values.status,
        customerId: values.customerId,
        contactId: values.contactId,
        assigneeId: values.assignedToId,
        dueDate: values.dueDate ? new Date(values.dueDate).toISOString() : null,
      },
    });
    return success(c, { id }, 201);
  } catch (err) {
    console.error('[app-api/activities] create failed:', err);
    return error.internal(c, 'Failed to create activity');
  }
});

app.patch('/:id', requirePermission('activities:update'), zValidator('json', updateActivitySchema), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const data = c.req.valid('json');
  const scope = await scopeFor(c);
  const conditions: any[] = [eq(t.id, id), isNull(t.deletedAt)];
  if (scope) conditions.push(eq(t.assignedToId, scope));
  try {
    const [existing] = await db.select().from(t).where(and(...conditions)).limit(1);
    if (!existing) return error.notFound(c, 'Activity', id);
    const update: Record<string, unknown> = { updatedAt: new Date() };
    for (const [k, v] of Object.entries(data)) {
      if (v === undefined) continue;
      update[k] = DATE_FIELDS.has(k) && typeof v === 'string' ? new Date(v) : v;
    }
    await db.update(t).set(update).where(and(eq(t.id, id), isNull(t.deletedAt)));
    // Phase 1 dual-write: mirror the customFields blob into the typed values table.
    await syncValuesForEntity(db, 'activity', id, data.customFields as Record<string, unknown> | null | undefined);
    publishEntityEvent({
      c,
      entityType: 'activity',
      entityId: id,
      action: 'updated',
      data: {
        id,
        type: existing.type,
        subject: (update.subject as string | undefined) ?? existing.subject,
        status: (update.status as string | undefined) ?? existing.status,
        customerId: (update.customerId as string | null | undefined) ?? existing.customerId,
        contactId: (update.contactId as string | null | undefined) ?? existing.contactId,
        assigneeId: (update.assignedToId as string | null | undefined) ?? existing.assignedToId,
      },
    });
    if (update.status === 'completed' && existing.status !== 'completed') {
      publishEntityEvent({
        c,
        entityType: 'activity',
        entityId: id,
        action: 'completed',
        data: { id, type: existing.type },
      });
    }
    return success(c, { id });
  } catch (err) {
    console.error('[app-api/activities] update failed:', err);
    return error.internal(c, 'Failed to update activity');
  }
});

app.delete('/:id', requirePermission('activities:delete'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const scope = await scopeFor(c);
  const conditions: any[] = [eq(t.id, id), isNull(t.deletedAt)];
  if (scope) conditions.push(eq(t.assignedToId, scope));
  try {
    const [existing] = await db.select().from(t).where(and(...conditions)).limit(1);
    if (!existing) return error.notFound(c, 'Activity', id);
    await db.update(t).set({ deletedAt: new Date(), updatedAt: new Date() }).where(eq(t.id, id));
    publishEntityEvent({
      c,
      entityType: 'activity',
      entityId: id,
      action: 'deleted',
      data: {
        id,
        type: existing.type,
        customerId: existing.customerId,
        contactId: existing.contactId,
      },
    });
    return noContent(c);
  } catch (err) {
    console.error('[app-api/activities] delete failed:', err);
    return error.internal(c, 'Failed to delete activity');
  }
});

export const activitiesRoutes = app;
