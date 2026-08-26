/**
 * WeldDesk widget settings — /api/desk/widget
 *
 * Creates tenant desk_widget_settings + master widget_registry so the
 * public widget API can resolve widgetId → workspace.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { eq } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { createDeskWidgetSchema, updateDeskWidgetSchema } from '@weldsuite/core-api-client/schemas/desk-widget';
import type { Env, Variables } from '../../types';
import { error, success } from '../../lib/response';
import { generateId } from '../../lib/id';
import { getMasterDb, getWorkspaceForOrg, masterSchema, schema } from '../../db';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
const widgets = schema.deskWidgetSettings;

app.get('/', requirePermission('settings:read'), async (c) => {
  const db = c.get('tenantDb');
  try {
    const rows = await db.select().from(widgets);
    return success(c, rows);
  } catch (err) {
    console.error('[app-api/desk-widget] list failed:', err);
    return error.internal(c, 'Failed to list widgets');
  }
});

app.post('/', requirePermission('settings:update'), zValidator('json', createDeskWidgetSchema), async (c) => {
  const db = c.get('tenantDb');
  const clerkOrgId = c.get('workspaceId');
  const data = c.req.valid('json');
  const id = generateId('dwgt');
  const widgetId = generateId('widget');
  const now = new Date();
  const widgetName = data.widgetName ?? 'Chat widget';
  try {
    const [created] = await db
      .insert(widgets)
      .values({
        id,
        createdAt: now,
        updatedAt: now,
        widgetId,
        widgetName,
        enabled: true,
        greeting: data.greeting ?? 'Hi — how can we help?',
        branding: data.branding ?? { primaryColor: '#2563eb', position: 'right' },
        allowedDomains: data.allowedDomains ?? [],
      })
      .returning();

    try {
      const { id: internalWorkspaceId } = await getWorkspaceForOrg(c.env, clerkOrgId);
      const masterDb = getMasterDb(c.env);
      await masterDb.insert(masterSchema.widgetRegistry).values({
        id: generateId('wr'),
        widgetId,
        workspaceId: internalWorkspaceId,
        widgetName,
        isActive: true,
        createdAt: now,
        updatedAt: now,
      });
    } catch (err) {
      console.error('[app-api/desk-widget] registry insert failed:', err);
    }

    publishEntityEvent({
      c,
      entityType: 'desk_widget',
      action: 'created',
      entityId: id,
      data: { id, widgetId, widgetName },
    });
    return success(c, created, 201);
  } catch (err) {
    console.error('[app-api/desk-widget] create failed:', err);
    return error.internal(c, 'Failed to create widget');
  }
});

app.get('/:widgetId', requirePermission('settings:read'), async (c) => {
  const db = c.get('tenantDb');
  const widgetId = c.req.param('widgetId');
  try {
    const [row] = await db.select().from(widgets).where(eq(widgets.widgetId, widgetId)).limit(1);
    if (!row) return error.notFound(c, 'Widget', widgetId);
    return success(c, row);
  } catch (err) {
    console.error('[app-api/desk-widget] get failed:', err);
    return error.internal(c, 'Failed to fetch widget');
  }
});

app.patch('/:widgetId', requirePermission('settings:update'), zValidator('json', updateDeskWidgetSchema), async (c) => {
  const db = c.get('tenantDb');
  const widgetId = c.req.param('widgetId');
  const data = c.req.valid('json');
  try {
    const [existing] = await db.select().from(widgets).where(eq(widgets.widgetId, widgetId)).limit(1);
    if (!existing) return error.notFound(c, 'Widget', widgetId);

    const [updated] = await db
      .update(widgets)
      .set({
        updatedAt: new Date(),
        ...(data.widgetName !== undefined ? { widgetName: data.widgetName } : {}),
        ...(data.enabled !== undefined ? { enabled: data.enabled } : {}),
        ...(data.greeting !== undefined ? { greeting: data.greeting } : {}),
        ...(data.branding !== undefined ? { branding: data.branding } : {}),
        ...(data.allowedDomains !== undefined ? { allowedDomains: data.allowedDomains } : {}),
      })
      .where(eq(widgets.id, existing.id))
      .returning();

    if (data.widgetName || data.enabled !== undefined) {
      try {
        const masterDb = getMasterDb(c.env);
        await masterDb
          .update(masterSchema.widgetRegistry)
          .set({
            ...(data.widgetName ? { widgetName: data.widgetName } : {}),
            ...(data.enabled !== undefined ? { isActive: data.enabled } : {}),
            updatedAt: new Date(),
          })
          .where(eq(masterSchema.widgetRegistry.widgetId, widgetId));
      } catch (err) {
        console.error('[app-api/desk-widget] registry update failed:', err);
      }
    }

    publishEntityEvent({
      c,
      entityType: 'desk_widget',
      action: 'updated',
      entityId: existing.id,
      data: (updated ?? existing) as unknown as Record<string, unknown>,
    });
    return success(c, updated ?? existing);
  } catch (err) {
    console.error('[app-api/desk-widget] update failed:', err);
    return error.internal(c, 'Failed to update widget');
  }
});

app.delete('/:widgetId', requirePermission('settings:manage'), async (c) => {
  const db = c.get('tenantDb');
  const widgetId = c.req.param('widgetId');
  try {
    const [existing] = await db.select().from(widgets).where(eq(widgets.widgetId, widgetId)).limit(1);
    if (!existing) return error.notFound(c, 'Widget', widgetId);
    await db.delete(widgets).where(eq(widgets.id, existing.id));
    try {
      const masterDb = getMasterDb(c.env);
      await masterDb.delete(masterSchema.widgetRegistry).where(eq(masterSchema.widgetRegistry.widgetId, widgetId));
    } catch (err) {
      console.error('[app-api/desk-widget] registry delete failed:', err);
    }
    publishEntityEvent({
      c,
      entityType: 'desk_widget',
      action: 'deleted',
      entityId: existing.id,
      data: { id: existing.id, widgetId },
    });
    return success(c, { id: existing.id, widgetId });
  } catch (err) {
    console.error('[app-api/desk-widget] delete failed:', err);
    return error.internal(c, 'Failed to delete widget');
  }
});

export { app as deskWidgetRoutes };
