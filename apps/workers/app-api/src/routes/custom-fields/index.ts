/**
 * Custom field definition routes — flat /api/custom-fields/* surface backed by
 * `customFieldDefinitions`. Definitions are org-wide reusable columns attached
 * to a platform entity type (contact, customer, ticket, ...).
 *
 * Permissions: settings:read (reads) | settings:manage (mutations). These are
 * org-level settings objects so they share the `settings:*` prefix used by the
 * other settings-managed objects (customer-statuses, etc.).
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent, computeChanges } from '@weldsuite/entity-events';
import {
  createCustomFieldSchema,
  updateCustomFieldSchema,
  reorderCustomFieldsSchema,
} from '@weldsuite/app-api-client/schemas/custom-fields';
import { z } from 'zod';
import type { Env, Variables } from '../../types';
import { error, success } from '../../lib/response';
import { generateId } from '../../lib/id';
import { schema } from '../../db';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
const t = schema.customFieldDefinitions;

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
      console.error('[app-api/custom-fields] list failed:', err);
      return error.internal(c, 'Failed to list custom field definitions');
    }
  },
);

// List all definitions grouped by entity type
app.get('/all', requirePermission('settings:read'), async (c) => {
  const db = c.get('tenantDb');

  try {
    const results = await db
      .select()
      .from(t)
      .where(isNull(t.deletedAt))
      .orderBy(asc(t.entityType), asc(t.sortOrder));

    const grouped: Record<string, typeof results> = {};
    for (const field of results) {
      if (!grouped[field.entityType]) grouped[field.entityType] = [];
      grouped[field.entityType].push(field);
    }

    return success(c, grouped);
  } catch (err) {
    console.error('[app-api/custom-fields] list all failed:', err);
    return error.internal(c, 'Failed to list custom field definitions');
  }
});

// Batch reorder definitions (before /:id to avoid route conflict)
app.put('/reorder', requirePermission('settings:manage'), zValidator('json', reorderCustomFieldsSchema), async (c) => {
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
    console.error('[app-api/custom-fields] reorder failed:', err);
    return error.internal(c, 'Failed to reorder custom field definitions');
  }
});

// Get single definition
app.get('/:id', requirePermission('settings:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');

  try {
    const [field] = await db
      .select()
      .from(t)
      .where(and(eq(t.id, id), isNull(t.deletedAt)))
      .limit(1);
    if (!field) return error.notFound(c, 'Custom field definition', id);
    return success(c, field);
  } catch (err) {
    console.error('[app-api/custom-fields] get failed:', err);
    return error.internal(c, 'Failed to get custom field definition');
  }
});

// Create definition
app.post('/', requirePermission('settings:manage'), zValidator('json', createCustomFieldSchema), async (c) => {
  const db = c.get('tenantDb');
  const data = c.req.valid('json');

  try {
    // Uniqueness is scoped by ticketTypeId, mirroring the two partial unique
    // indexes on the table: a global definition (ticketTypeId null) is unique on
    // (entityType, slug) among other globals; a ticket-type-scoped one is unique
    // on (entityType, slug, ticketTypeId). A slug may therefore repeat across
    // ticket types but never within one, nor twice globally.
    const scope = data.ticketTypeId
      ? eq(t.ticketTypeId, data.ticketTypeId)
      : isNull(t.ticketTypeId);
    const [existing] = await db
      .select({ id: t.id })
      .from(t)
      .where(and(eq(t.entityType, data.entityType), eq(t.slug, data.slug), scope, isNull(t.deletedAt)))
      .limit(1);

    if (existing) {
      return error.conflict(
        c,
        `A custom field with slug '${data.slug}' already exists for entity type '${data.entityType}'`,
      );
    }

    const id = generateId('cfld');
    const now = new Date();

    await db.insert(t).values({
      id,
      entityType: data.entityType,
      name: data.name,
      slug: data.slug,
      description: data.description,
      fieldType: data.fieldType,
      options: data.options,
      config: data.config,
      required: data.required ?? false,
      sortOrder: data.sortOrder ?? 0,
      group: data.group,
      ticketTypeId: data.ticketTypeId ?? null,
      createdAt: now,
      updatedAt: now,
    } as unknown as typeof t.$inferInsert);

    const [created] = await db.select().from(t).where(eq(t.id, id)).limit(1);

    publishEntityEvent({
      c,
      entityType: 'custom_field',
      entityId: id,
      action: 'created',
      data: { id, ...data },
    });

    return success(c, created, 201);
  } catch (err) {
    console.error('[app-api/custom-fields] create failed:', err);
    return error.internal(c, 'Failed to create custom field definition');
  }
});

// Update definition
app.put('/:id', requirePermission('settings:manage'), zValidator('json', updateCustomFieldSchema), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const data = c.req.valid('json');

  try {
    const [existing] = await db
      .select()
      .from(t)
      .where(and(eq(t.id, id), isNull(t.deletedAt)))
      .limit(1);
    if (!existing) return error.notFound(c, 'Custom field definition', id);

    const updateData: Record<string, unknown> = { updatedAt: new Date() };
    if (data.name !== undefined) updateData.name = data.name;
    if (data.description !== undefined) updateData.description = data.description;
    if (data.fieldType !== undefined) updateData.fieldType = data.fieldType;
    if (data.options !== undefined) updateData.options = data.options;
    if (data.config !== undefined) updateData.config = data.config;
    if (data.required !== undefined) updateData.required = data.required;
    if (data.sortOrder !== undefined) updateData.sortOrder = data.sortOrder;
    if (data.group !== undefined) updateData.group = data.group;

    await db.update(t).set(updateData).where(eq(t.id, id));

    const [updated] = await db.select().from(t).where(eq(t.id, id)).limit(1);

    const changes = computeChanges(existing as Record<string, unknown>, data as Record<string, unknown>);
    if (changes) {
      publishEntityEvent({
        c,
        entityType: 'custom_field',
        entityId: id,
        action: 'updated',
        data: { id, ...data },
        changes,
      });
    }

    return success(c, updated);
  } catch (err) {
    console.error('[app-api/custom-fields] update failed:', err);
    return error.internal(c, 'Failed to update custom field definition');
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
    if (!existing) return error.notFound(c, 'Custom field definition', id);

    await db.update(t).set({ deletedAt: new Date(), updatedAt: new Date() }).where(eq(t.id, id));

    publishEntityEvent({
      c,
      entityType: 'custom_field',
      entityId: id,
      action: 'deleted',
      data: { id },
    });

    return success(c, { deleted: true });
  } catch (err) {
    console.error('[app-api/custom-fields] delete failed:', err);
    return error.internal(c, 'Failed to delete custom field definition');
  }
});

export const customFieldsRoutes = app;
