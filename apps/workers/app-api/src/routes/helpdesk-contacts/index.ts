/**
 * Helpdesk contacts routes — /api/helpdesk-contacts/* surface backed by the
 * shared `people` table. Surfaced here as a helpdesk-scoped contact directory
 * with conversation-count enrichment.
 *
 * Permissions: conversations:read | conversations:create | conversations:update.
 * No DELETE — contacts are owned by WeldCRM; helpdesk never deletes them.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, asc, desc, eq, isNull, like, or, sql } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import type { Env, Variables } from '../../types';
import { cursorPagination, error, list, success } from '../../lib/response';
import { generateId } from '../../lib/id';
import { schema } from '../../db';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
const t = schema.people;

// ============================================================================
// Schemas
// ============================================================================

const createContactSchema = z.object({
  name: z.string().min(1).max(255),
  email: z.string().email(),
  phone: z.string().optional(),
  firstName: z.string().optional(),
  lastName: z.string().optional(),
  directPhone: z.string().optional(),
  notes: z.string().optional(),
  tags: z.array(z.string()).optional(),
  metadata: z.record(z.unknown()).optional(),
  status: z.string().default('active'),
});

const updateContactSchema = z.object({
  firstName: z.string().optional(),
  lastName: z.string().optional(),
  email: z.string().email().optional(),
  phone: z.string().optional(),
  notes: z.string().optional(),
  avatarUrl: z.string().optional(),
});

// ============================================================================
// GET / — list contacts with cursor pagination + conversation count
// ============================================================================

app.get('/', requirePermission('conversations:read'), async (c) => {
  const db = c.get('tenantDb');
  const q = c.req.query();
  const limit = Math.min(q.limit ? parseInt(q.limit, 10) : 25, 100);

  const conditions: ReturnType<typeof eq>[] = [isNull(t.deletedAt)];
  if (q.status) conditions.push(eq(t.status, q.status));
  if (q.search) {
    const term = `%${q.search}%`;
    conditions.push(
      or(
        like(t.firstName, term),
        like(t.lastName, term),
        like(t.fullName, term),
        like(t.email, term),
      )!,
    );
  }

  if (q.cursor) {
    const [cur] = await db
      .select({ updatedAt: t.updatedAt, id: t.id })
      .from(t)
      .where(eq(t.id, q.cursor))
      .limit(1);
    if (cur?.updatedAt) {
      conditions.push(
        sql`(${t.updatedAt} < ${cur.updatedAt} OR (${t.updatedAt} = ${cur.updatedAt} AND ${t.id} < ${cur.id}))`,
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
          id: t.id,
          firstName: t.firstName,
          lastName: t.lastName,
          fullName: t.fullName,
          email: t.email,
          directPhone: t.directPhone,
          mobilePhone: t.mobilePhone,
          status: t.status,
          notes: t.notes,
          interests: t.interests,
          lastContactedAt: t.lastContactedAt,
          avatarUrl: t.avatarUrl,
          createdAt: t.createdAt,
          updatedAt: t.updatedAt,
          conversationCount: sql<number>`COALESCE((
            SELECT count(*)::int FROM helpdesk_conversations hc
            WHERE hc.contact_id = ${t.id} AND hc.deleted_at IS NULL
          ), 0)`.as('conversation_count'),
        })
        .from(t)
        .where(where)
        .orderBy(desc(t.updatedAt), desc(t.id))
        .limit(limit + 1),
      db.select({ count: sql<number>`count(*)` }).from(t).where(countWhere),
    ]);
    const hasMore = rows.length > limit;
    const data = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore && data.length > 0 ? data[data.length - 1].id : null;
    const totalCount = Number(countRes[0]?.count ?? 0);
    return list(c, data, cursorPagination(totalCount, hasMore, nextCursor));
  } catch (err) {
    console.error('[app-api/helpdesk-contacts] list failed:', err);
    return error.internal(c, 'Failed to list helpdesk contacts');
  }
});

// ============================================================================
// GET /search — quick contact search (lightweight, no cursor)
// ============================================================================

app.get('/search', requirePermission('conversations:read'), async (c) => {
  const db = c.get('tenantDb');
  const q = c.req.query('q');
  if (!q || q.length < 1) return success(c, []);
  const term = `%${q}%`;
  try {
    const results = await db
      .select({
        id: t.id,
        firstName: t.firstName,
        lastName: t.lastName,
        fullName: t.fullName,
        email: t.email,
        directPhone: t.directPhone,
        mobilePhone: t.mobilePhone,
        status: t.status,
        avatarUrl: t.avatarUrl,
      })
      .from(t)
      .where(
        and(
          isNull(t.deletedAt),
          or(like(t.firstName, term), like(t.lastName, term), like(t.fullName, term), like(t.email, term))!,
        ),
      )
      .orderBy(desc(t.updatedAt))
      .limit(20);
    return success(c, results);
  } catch (err) {
    console.error('[app-api/helpdesk-contacts] search failed:', err);
    return error.internal(c, 'Failed to search helpdesk contacts');
  }
});

// ============================================================================
// GET /:id
// ============================================================================

app.get('/:id', requirePermission('conversations:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const [row] = await db.select().from(t).where(and(eq(t.id, id), isNull(t.deletedAt))).limit(1);
    if (!row) return error.notFound(c, 'Helpdesk contact', id);
    return success(c, row);
  } catch (err) {
    console.error('[app-api/helpdesk-contacts] get failed:', err);
    return error.internal(c, 'Failed to fetch helpdesk contact');
  }
});

// ============================================================================
// POST /
// ============================================================================

app.post('/', requirePermission('conversations:create'), zValidator('json', createContactSchema), async (c) => {
  const db = c.get('tenantDb');
  const data = c.req.valid('json');
  const id = generateId('con');
  const now = new Date();

  let firstName = data.firstName ?? '';
  let lastName = data.lastName ?? '';
  if (!firstName && !lastName && data.name) {
    const parts = data.name.split(' ');
    firstName = parts[0] ?? '';
    lastName = parts.slice(1).join(' ');
  }

  try {
    await db.insert(t).values({
      id,
      firstName,
      lastName,
      fullName: data.name || `${firstName} ${lastName}`.trim(),
      email: data.email,
      directPhone: data.directPhone ?? data.phone,
      status: data.status ?? 'active',
      notes: data.notes,
      interests: data.tags as string[] | undefined,
      customFields: data.metadata as Record<string, unknown> | undefined,
      createdAt: now,
      updatedAt: now,
    } as unknown as typeof t.$inferInsert);
    publishEntityEvent({
      c,
      entityType: 'helpdesk_contact',
      entityId: id,
      action: 'created',
      data: { id, name: data.name, email: data.email },
    });
    return success(c, { id }, 201);
  } catch (err) {
    console.error('[app-api/helpdesk-contacts] create failed:', err);
    return error.internal(c, 'Failed to create helpdesk contact');
  }
});

// ============================================================================
// PATCH /:id
// ============================================================================

app.patch('/:id', requirePermission('conversations:update'), zValidator('json', updateContactSchema), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const data = c.req.valid('json');
  try {
    const [existing] = await db.select().from(t).where(and(eq(t.id, id), isNull(t.deletedAt))).limit(1);
    if (!existing) return error.notFound(c, 'Helpdesk contact', id);

    const update: Record<string, unknown> = { updatedAt: new Date() };
    if (data.firstName !== undefined) update.firstName = data.firstName;
    if (data.lastName !== undefined) update.lastName = data.lastName;
    if (data.firstName !== undefined || data.lastName !== undefined) {
      const first = data.firstName ?? existing.firstName ?? '';
      const last = data.lastName ?? existing.lastName ?? '';
      update.fullName = `${first} ${last}`.trim();
    }
    if (data.email !== undefined) update.email = data.email;
    if (data.phone !== undefined) update.directPhone = data.phone;
    if (data.notes !== undefined) update.notes = data.notes;
    if (data.avatarUrl !== undefined) update.avatarUrl = data.avatarUrl;

    await db.update(t).set(update).where(and(eq(t.id, id), isNull(t.deletedAt)));
    publishEntityEvent({
      c,
      entityType: 'helpdesk_contact',
      entityId: id,
      action: 'updated',
      data: { id, ...data },
    });
    return success(c, { id });
  } catch (err) {
    console.error('[app-api/helpdesk-contacts] update failed:', err);
    return error.internal(c, 'Failed to update helpdesk contact');
  }
});

export const helpdeskContactsRoutes = app;
