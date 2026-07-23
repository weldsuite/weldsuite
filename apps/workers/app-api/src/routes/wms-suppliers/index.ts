/**
 * WMS Supplier routes — flat /api/wms-suppliers/* surface backed by `suppliers`.
 * Suppliers are vendors for purchasing inventory (WeldStash / WMS module).
 *
 * Permissions: suppliers:read | suppliers:create | suppliers:update | suppliers:delete.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, desc, eq, isNull, like, or, sql } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import {
  createWmsSupplierSchema,
  updateWmsSupplierSchema,
} from '@weldsuite/app-api-client/schemas/wms-suppliers';
import type { Env, Variables } from '../../types';
import { cursorPagination, error, list, noContent, success } from '../../lib/response';
import { generateId } from '../../lib/id';
import { schema } from '../../db';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
const t = schema.suppliers;

app.get('/', requirePermission('suppliers:read'), async (c) => {
  const db = c.get('tenantDb');
  const q = c.req.query();
  const limit = Math.min(q.limit ? parseInt(q.limit, 10) : 25, 100);

  const conditions: any[] = [isNull(t.deletedAt)];
  if (q.search) {
    const term = `%${q.search}%`;
    conditions.push(or(like(t.name, term), like(t.code, term), like(t.email, term))!);
  }
  if (q.status === 'active') conditions.push(eq(t.status, 'active'));
  else if (q.status === 'inactive') conditions.push(eq(t.status, 'inactive'));
  if (q.isActive !== undefined) conditions.push(eq(t.isActive, q.isActive === 'true'));

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
    console.error('[app-api/wms-suppliers] list failed:', err);
    return error.internal(c, 'Failed to list suppliers');
  }
});

app.get('/:id', requirePermission('suppliers:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const [row] = await db.select().from(t).where(and(eq(t.id, id), isNull(t.deletedAt))).limit(1);
    if (!row) return error.notFound(c, 'Supplier', id);
    return success(c, row);
  } catch (err) {
    console.error('[app-api/wms-suppliers] get failed:', err);
    return error.internal(c, 'Failed to fetch supplier');
  }
});

app.post('/', requirePermission('suppliers:create'), zValidator('json', createWmsSupplierSchema), async (c) => {
  const db = c.get('tenantDb');
  const data = c.req.valid('json') as Record<string, any>;
  const id = generateId('sup');
  const now = new Date();
  const isActive = (data.isActive as boolean | undefined) ?? true;
  try {
    await db.insert(t).values({
      id,
      name: data.name as string,
      code: data.code as string | undefined,
      description: data.description as string | undefined,
      contactName: data.contactName as string | undefined,
      email: data.email as string | undefined,
      phone: data.phone as string | undefined,
      website: data.website as string | undefined,
      addressLine1: data.addressLine1 as string | undefined,
      addressLine2: data.addressLine2 as string | undefined,
      city: data.city as string | undefined,
      state: data.state as string | undefined,
      postalCode: data.postalCode as string | undefined,
      country: data.country as string | undefined,
      paymentTerms: data.paymentTerms as string | undefined,
      currency: (data.currency as string | undefined) ?? 'USD',
      taxId: data.taxId as string | undefined,
      defaultLeadTimeDays: data.defaultLeadTimeDays as number | undefined,
      isActive,
      status: isActive ? 'active' : 'inactive',
      rating: data.rating as number | undefined,
      notes: data.notes as string | undefined,
      metadata: data.metadata as Record<string, unknown> | undefined,
      tags: data.tags as string[] | undefined,
      createdAt: now,
      updatedAt: now,
    } as unknown as typeof t.$inferInsert);
    publishEntityEvent({
      c,
      entityType: 'supplier',
      entityId: id,
      action: 'created',
      data: { id, name: data.name as string },
    });
    return success(c, { id }, 201);
  } catch (err) {
    console.error('[app-api/wms-suppliers] create failed:', err);
    return error.internal(c, 'Failed to create supplier');
  }
});

app.patch('/:id', requirePermission('suppliers:update'), zValidator('json', updateWmsSupplierSchema), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const data = c.req.valid('json') as Record<string, any>;
  try {
    const [existing] = await db.select().from(t).where(and(eq(t.id, id), isNull(t.deletedAt))).limit(1);
    if (!existing) return error.notFound(c, 'Supplier', id);
    const update: Record<string, any> = { updatedAt: new Date() };
    const simpleFields = [
      'name', 'code', 'description', 'contactName', 'email', 'phone', 'website',
      'addressLine1', 'addressLine2', 'city', 'state', 'postalCode', 'country',
      'paymentTerms', 'currency', 'taxId', 'defaultLeadTimeDays',
      'isActive', 'rating', 'notes', 'metadata', 'tags',
    ];
    for (const [k, v] of Object.entries(data)) {
      if (v !== undefined && simpleFields.includes(k)) update[k] = v;
    }
    if (data.isActive !== undefined) {
      update.status = data.isActive ? 'active' : 'inactive';
    }
    await db.update(t).set(update).where(and(eq(t.id, id), isNull(t.deletedAt)));
    publishEntityEvent({
      c,
      entityType: 'supplier',
      entityId: id,
      action: 'updated',
      data: {
        id,
        name: (update.name as string | undefined) ?? existing.name,
      },
    });
    return success(c, { id });
  } catch (err) {
    console.error('[app-api/wms-suppliers] update failed:', err);
    return error.internal(c, 'Failed to update supplier');
  }
});

app.delete('/:id', requirePermission('suppliers:delete'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const [existing] = await db.select().from(t).where(and(eq(t.id, id), isNull(t.deletedAt))).limit(1);
    if (!existing) return error.notFound(c, 'Supplier', id);
    await db.update(t).set({ deletedAt: new Date(), updatedAt: new Date() }).where(eq(t.id, id));
    publishEntityEvent({
      c,
      entityType: 'supplier',
      entityId: id,
      action: 'deleted',
      data: { id, name: existing.name },
    });
    return noContent(c);
  } catch (err) {
    console.error('[app-api/wms-suppliers] delete failed:', err);
    return error.internal(c, 'Failed to delete supplier');
  }
});

export const wmsSuppliersRoutes = app;
