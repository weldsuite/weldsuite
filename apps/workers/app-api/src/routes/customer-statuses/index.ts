/**
 * Customer status routes — flat /api/customer-statuses/* surface backed by
 * `crmCustomerStatuses`. Workspace-defined lifecycle states for customers.
 * Slugs are unique per workspace; built-in slugs are reserved.
 *
 * Permissions: customers:read (list/get) | settings:manage (create/update/delete/reorder).
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, asc, eq, isNull, ne } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import {
  createCustomerStatusSchema,
  updateCustomerStatusSchema,
  reorderCustomerStatusesSchema,
} from '@weldsuite/app-api-client/schemas/customer-statuses';
import type { Env, Variables } from '../../types';
import { error, noContent, success } from '../../lib/response';
import { generateId } from '../../lib/id';
import { schema } from '../../db';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
const t = schema.crmCustomerStatuses;

// Slugs reserved by the built-in hardcoded statuses on the client.
const BUILTIN_SLUGS = ['prospect', 'active', 'inactive', 'churned', 'blacklisted'];

app.get('/', requirePermission('customers:read'), async (c) => {
  const db = c.get('tenantDb');
  try {
    const data = await db
      .select()
      .from(t)
      .where(isNull(t.deletedAt))
      .orderBy(asc(t.sortOrder), asc(t.name));
    return success(c, data);
  } catch (err) {
    console.error('[app-api/customer-statuses] list failed:', err);
    return error.internal(c, 'Failed to list customer statuses');
  }
});

app.get('/:id', requirePermission('customers:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const [row] = await db
      .select()
      .from(t)
      .where(and(eq(t.id, id), isNull(t.deletedAt)))
      .limit(1);
    if (!row) return error.notFound(c, 'Customer status', id);
    return success(c, row);
  } catch (err) {
    console.error('[app-api/customer-statuses] get failed:', err);
    return error.internal(c, 'Failed to fetch customer status');
  }
});

// /reorder must be mounted before /:id to prevent 'reorder' being treated as an id param
app.put('/reorder', requirePermission('settings:manage'), zValidator('json', reorderCustomerStatusesSchema), async (c) => {
  const db = c.get('tenantDb');
  const { ids } = c.req.valid('json');
  try {
    for (let i = 0; i < ids.length; i++) {
      await db
        .update(t)
        .set({ sortOrder: i, updatedAt: new Date() })
        .where(and(eq(t.id, ids[i]), isNull(t.deletedAt)));
    }
    const data = await db
      .select()
      .from(t)
      .where(isNull(t.deletedAt))
      .orderBy(asc(t.sortOrder), asc(t.name));
    publishEntityEvent({
      c,
      entityType: 'customer_status',
      entityId: ids[0] ?? 'reorder',
      action: 'updated',
      data: { ids },
    });
    return success(c, data);
  } catch (err) {
    console.error('[app-api/customer-statuses] reorder failed:', err);
    return error.internal(c, 'Failed to reorder customer statuses');
  }
});

app.post('/', requirePermission('settings:manage'), zValidator('json', createCustomerStatusSchema), async (c) => {
  const db = c.get('tenantDb');
  const data = c.req.valid('json');
  try {
    if (BUILTIN_SLUGS.includes(data.slug)) {
      return error.conflict(c, `Slug '${data.slug}' is reserved`);
    }
    const [existing] = await db
      .select({ id: t.id })
      .from(t)
      .where(and(eq(t.slug, data.slug), isNull(t.deletedAt)))
      .limit(1);
    if (existing) return error.conflict(c, `Slug '${data.slug}' is already in use`);
    const id = generateId('ccst');
    const now = new Date();
    await db.insert(t).values({
      id,
      name: data.name,
      slug: data.slug,
      color: data.color,
      sortOrder: data.sortOrder ?? 0,
      createdAt: now,
      updatedAt: now,
    } as unknown as typeof t.$inferInsert);
    const [row] = await db.select().from(t).where(eq(t.id, id)).limit(1);
    publishEntityEvent({
      c,
      entityType: 'customer_status',
      entityId: id,
      action: 'created',
      data: { id, name: data.name, slug: data.slug },
    });
    return success(c, row, 201);
  } catch (err) {
    console.error('[app-api/customer-statuses] create failed:', err);
    return error.internal(c, 'Failed to create customer status');
  }
});

app.patch('/:id', requirePermission('settings:manage'), zValidator('json', updateCustomerStatusSchema), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const data = c.req.valid('json');
  try {
    const [existing] = await db
      .select()
      .from(t)
      .where(and(eq(t.id, id), isNull(t.deletedAt)))
      .limit(1);
    if (!existing) return error.notFound(c, 'Customer status', id);
    if (data.slug !== undefined) {
      if (BUILTIN_SLUGS.includes(data.slug)) {
        return error.conflict(c, `Slug '${data.slug}' is reserved`);
      }
      const [conflict] = await db
        .select({ id: t.id })
        .from(t)
        .where(and(eq(t.slug, data.slug), isNull(t.deletedAt), ne(t.id, id)))
        .limit(1);
      if (conflict) return error.conflict(c, `Slug '${data.slug}' is already in use`);
    }
    const update: Record<string, unknown> = { updatedAt: new Date() };
    if (data.name !== undefined) update.name = data.name;
    if (data.slug !== undefined) update.slug = data.slug;
    if (data.color !== undefined) update.color = data.color;
    if (data.sortOrder !== undefined) update.sortOrder = data.sortOrder;
    await db.update(t).set(update).where(eq(t.id, id));
    const [row] = await db.select().from(t).where(eq(t.id, id)).limit(1);
    publishEntityEvent({
      c,
      entityType: 'customer_status',
      entityId: id,
      action: 'updated',
      data: { id, name: row?.name ?? existing.name },
    });
    return success(c, row);
  } catch (err) {
    console.error('[app-api/customer-statuses] update failed:', err);
    return error.internal(c, 'Failed to update customer status');
  }
});

app.delete('/:id', requirePermission('settings:manage'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const [existing] = await db
      .select({ id: t.id })
      .from(t)
      .where(and(eq(t.id, id), isNull(t.deletedAt)))
      .limit(1);
    if (!existing) return error.notFound(c, 'Customer status', id);
    await db.update(t).set({ deletedAt: new Date(), updatedAt: new Date() }).where(eq(t.id, id));
    publishEntityEvent({
      c,
      entityType: 'customer_status',
      entityId: id,
      action: 'deleted',
      data: { id },
    });
    return noContent(c);
  } catch (err) {
    console.error('[app-api/customer-statuses] delete failed:', err);
    return error.internal(c, 'Failed to delete customer status');
  }
});

export const customerStatusesRoutes = app;
