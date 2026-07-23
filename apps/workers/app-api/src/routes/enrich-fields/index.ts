/**
 * Enrich field definition routes — flat /api/enrich-fields/* surface backed by
 * `enrichFieldDefinitions`. Each row enables one provider+operation
 * data-enrichment pair for an entity type (e.g. Hunter `email_verifier` for
 * contacts).
 *
 * Permissions: settings:read (reads) | settings:manage (mutations). These are
 * org-level settings objects so they share the `settings:*` prefix used by the
 * other settings-managed objects.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent, computeChanges } from '@weldsuite/entity-events';
import {
  createEnrichFieldSchema,
  updateEnrichFieldSchema,
  reorderEnrichFieldsSchema,
} from '@weldsuite/app-api-client/schemas/enrich-fields';
import { z } from 'zod';
import type { Env, Variables } from '../../types';
import { error, success } from '../../lib/response';
import { generateId } from '../../lib/id';
import { schema } from '../../db';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
const t = schema.enrichFieldDefinitions;

// List definitions (optionally filtered by entityType)
app.get(
  '/',
  requirePermission('settings:read'),
  zValidator('query', z.object({ entityType: z.string().optional() })),
  async (c) => {
    const db = c.get('tenantDb');
    const { entityType } = c.req.valid('query');

    try {
      const conditions = [isNull(t.deletedAt)];
      if (entityType) conditions.push(eq(t.entityType, entityType));

      const results = await db
        .select()
        .from(t)
        .where(and(...conditions))
        .orderBy(asc(t.sortOrder), asc(t.createdAt));

      return success(c, results);
    } catch (err) {
      console.error('[app-api/enrich-fields] list failed:', err);
      return error.internal(c, 'Failed to list enrich field definitions');
    }
  },
);

// Batch reorder definitions (before /:id to avoid route conflict)
app.put('/reorder', requirePermission('settings:manage'), zValidator('json', reorderEnrichFieldsSchema), async (c) => {
  const db = c.get('tenantDb');
  const { items } = c.req.valid('json');

  try {
    for (const item of items) {
      await db
        .update(t)
        .set({ sortOrder: item.sortOrder, updatedAt: new Date() })
        .where(and(eq(t.id, item.id), isNull(t.deletedAt)));
    }
    return success(c, { reordered: items.length });
  } catch (err) {
    console.error('[app-api/enrich-fields] reorder failed:', err);
    return error.internal(c, 'Failed to reorder enrich field definitions');
  }
});

// Create definition
app.post('/', requirePermission('settings:manage'), zValidator('json', createEnrichFieldSchema), async (c) => {
  const db = c.get('tenantDb');
  const data = c.req.valid('json');

  try {
    const [existing] = await db
      .select({ id: t.id })
      .from(t)
      .where(
        and(
          eq(t.provider, data.provider),
          eq(t.operation, data.operation),
          eq(t.entityType, data.entityType),
          isNull(t.deletedAt),
        ),
      )
      .limit(1);

    if (existing) {
      return error.conflict(
        c,
        `An enrich field for ${data.provider}/${data.operation} on ${data.entityType} already exists`,
      );
    }

    const id = generateId('efd');
    const now = new Date();

    await db.insert(t).values({
      id,
      provider: data.provider,
      operation: data.operation,
      entityType: data.entityType,
      name: data.name,
      slug: data.slug,
      enabled: data.enabled ?? true,
      sortOrder: data.sortOrder ?? 0,
      config: data.config,
      createdAt: now,
      updatedAt: now,
    } as unknown as typeof t.$inferInsert);

    const [created] = await db.select().from(t).where(eq(t.id, id)).limit(1);

    publishEntityEvent({
      c,
      entityType: 'enrich_field',
      entityId: id,
      action: 'created',
      data: { id, ...data },
    });

    return success(c, created, 201);
  } catch (err) {
    console.error('[app-api/enrich-fields] create failed:', err);
    return error.internal(c, 'Failed to create enrich field definition');
  }
});

// Update definition
app.put('/:id', requirePermission('settings:manage'), zValidator('json', updateEnrichFieldSchema), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const data = c.req.valid('json');

  try {
    const [existing] = await db
      .select()
      .from(t)
      .where(and(eq(t.id, id), isNull(t.deletedAt)))
      .limit(1);
    if (!existing) return error.notFound(c, 'Enrich field definition', id);

    const updateData: Record<string, unknown> = { updatedAt: new Date() };
    if (data.name !== undefined) updateData.name = data.name;
    if (data.enabled !== undefined) updateData.enabled = data.enabled;
    if (data.sortOrder !== undefined) updateData.sortOrder = data.sortOrder;
    if (data.config !== undefined) updateData.config = data.config;

    await db.update(t).set(updateData).where(eq(t.id, id));

    const [updated] = await db.select().from(t).where(eq(t.id, id)).limit(1);

    const changes = computeChanges(existing as Record<string, unknown>, data as Record<string, unknown>);
    if (changes) {
      publishEntityEvent({
        c,
        entityType: 'enrich_field',
        entityId: id,
        action: 'updated',
        data: { id, ...data },
        changes,
      });
    }

    return success(c, updated);
  } catch (err) {
    console.error('[app-api/enrich-fields] update failed:', err);
    return error.internal(c, 'Failed to update enrich field definition');
  }
});

// Soft-delete definition
app.delete('/:id', requirePermission('settings:manage'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');

  try {
    const [existing] = await db
      .select()
      .from(t)
      .where(and(eq(t.id, id), isNull(t.deletedAt)))
      .limit(1);
    if (!existing) return error.notFound(c, 'Enrich field definition', id);

    await db.update(t).set({ deletedAt: new Date(), updatedAt: new Date() }).where(eq(t.id, id));

    publishEntityEvent({
      c,
      entityType: 'enrich_field',
      entityId: id,
      action: 'deleted',
      data: { id },
    });

    return success(c, { deleted: true });
  } catch (err) {
    console.error('[app-api/enrich-fields] delete failed:', err);
    return error.internal(c, 'Failed to delete enrich field definition');
  }
});

export const enrichFieldsRoutes = app;
