/**
 * Object Templates routes — flat /api/object-templates/* surface backed by `objectTemplates`.
 *
 * A template is a named field-set used when creating a Company or Person.
 * Permissions piggy-back on companies/people domains depending on entityType.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import {
  createObjectTemplateSchema,
  updateObjectTemplateSchema,
} from '@weldsuite/app-api-client/schemas/object-templates';
import { publishEntityEvent } from '@weldsuite/entity-events';
import type { Env, Variables } from '../../types';
import { cursorPagination, error, list, noContent, success } from '../../lib/response';
import { generateId } from '../../lib/id';
import { schema } from '../../db';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
const t = schema.objectTemplates;

// Read is open to anyone who can read either companies or people — pick the
// more permissive companies:read; the picker is also surfaced in the people
// quick-add dialog so any CRM user needs it.
app.get('/', requirePermission('companies:read'), async (c) => {
  const db = c.get('tenantDb');
  const q = c.req.query();

  const conditions: any[] = [isNull(t.deletedAt)];
  // Accept any registered entityType — the registry lives on the front-end
  // (apps/web/platform/app/settings/object-templates/registry.ts). We only
  // enforce the slug shape here as a safety net.
  if (q.entityType && /^[a-z][a-z0-9_]*$/.test(q.entityType)) {
    conditions.push(eq(t.entityType, q.entityType));
  }
  const where = and(...conditions);

  try {
    const rows = await db
      .select()
      .from(t)
      .where(where)
      .orderBy(asc(t.sortOrder), asc(t.name));
    return list(c, rows, cursorPagination(rows.length, false, null));
  } catch (err) {
    console.error('[app-api/object-templates] list failed:', err);
    return error.internal(c, 'Failed to list object templates');
  }
});

app.get('/:id', requirePermission('companies:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const [row] = await db.select().from(t).where(and(eq(t.id, id), isNull(t.deletedAt))).limit(1);
    if (!row) return error.notFound(c, 'CRM template', id);
    return success(c, row);
  } catch (err) {
    console.error('[app-api/object-templates] get failed:', err);
    return error.internal(c, 'Failed to fetch CRM template');
  }
});

app.post(
  '/',
  requirePermission('companies:update'),
  zValidator('json', createObjectTemplateSchema),
  async (c) => {
    const db = c.get('tenantDb');
    const data = c.req.valid('json');
    const id = generateId('crmtpl');
    const now = new Date();
    try {
      const [row] = await db
        .insert(t)
        .values({
          id,
          ...data,
          isDefault: data.isDefault ?? false,
          sortOrder: data.sortOrder ?? 0,
          createdAt: now,
          updatedAt: now,
        })
        .returning();

      publishEntityEvent({
        c,
        entityType: 'object_template',
        action: 'created',
        entityId: id,
        data: row as unknown as Record<string, unknown>,
      });

      return success(c, row, 201);
    } catch (err) {
      console.error('[app-api/object-templates] create failed:', err);
      return error.internal(c, 'Failed to create CRM template');
    }
  },
);

app.patch(
  '/:id',
  requirePermission('companies:update'),
  zValidator('json', updateObjectTemplateSchema),
  async (c) => {
    const db = c.get('tenantDb');
    const id = c.req.param('id');
    const data = c.req.valid('json');
    try {
      const [existing] = await db
        .select()
        .from(t)
        .where(and(eq(t.id, id), isNull(t.deletedAt)))
        .limit(1);
      if (!existing) return error.notFound(c, 'CRM template', id);

      const update: Record<string, any> = { updatedAt: new Date() };
      for (const [k, v] of Object.entries(data)) if (v !== undefined) update[k] = v;

      const [row] = await db
        .update(t)
        .set(update)
        .where(and(eq(t.id, id), isNull(t.deletedAt)))
        .returning();

      publishEntityEvent({
        c,
        entityType: 'object_template',
        action: 'updated',
        entityId: id,
        data: row as unknown as Record<string, unknown>,
      });

      return success(c, row);
    } catch (err) {
      console.error('[app-api/object-templates] update failed:', err);
      return error.internal(c, 'Failed to update CRM template');
    }
  },
);

app.delete('/:id', requirePermission('companies:update'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const [existing] = await db
      .select()
      .from(t)
      .where(and(eq(t.id, id), isNull(t.deletedAt)))
      .limit(1);
    if (!existing) return error.notFound(c, 'CRM template', id);

    await db.update(t).set({ deletedAt: new Date(), updatedAt: new Date() }).where(eq(t.id, id));

    publishEntityEvent({
      c,
      entityType: 'object_template',
      action: 'deleted',
      entityId: id,
      data: { id } as Record<string, unknown>,
    });

    return noContent(c);
  } catch (err) {
    console.error('[app-api/object-templates] delete failed:', err);
    return error.internal(c, 'Failed to delete CRM template');
  }
});

export const objectTemplatesRoutes = app;
