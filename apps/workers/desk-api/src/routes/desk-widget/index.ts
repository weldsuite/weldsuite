/**
 * WeldDesk widget settings — /api/desk/widget
 *
 * Creates tenant desk_widget_settings + master widget_registry so the
 * public widget API can resolve widgetId → workspace.
 *
 * Identity verification: the widget's identity secret signs the identity
 * tokens a customer's server hands the widget (helpdesk-widget-api checks
 * them). It never appears in a settings response or an entity event; only
 * /:widgetId/identity reads, rotates or removes it (settings:manage).
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { eq } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import {
  createDeskWidgetSchema,
  updateDeskWidgetSchema,
  type UpdateDeskWidgetInput,
} from '@weldsuite/core-api-client/schemas/desk-widget';
import { isDeskSchemaMissing } from '@weldsuite/db/lib/desk';
import type { Env, Variables } from '../../types';
import { error, success } from '@weldsuite/worker-kit/response';
import { generateId } from '@weldsuite/worker-kit/id';
import { getMasterDb, masterSchema, schema } from '@weldsuite/worker-kit/db';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
const widgets = schema.deskWidgetSettings;

type WidgetRow = typeof widgets.$inferSelect;

/** A settings row as the API shows it: everything but the identity secret. */
function publicWidget(row: WidgetRow): Omit<WidgetRow, 'identitySecret'> {
  const shown: Partial<WidgetRow> = { ...row };
  delete shown.identitySecret;
  return shown as Omit<WidgetRow, 'identitySecret'>;
}

/** 256 random bits, base64url: the HS256 key customers sign identity tokens with. */
function newIdentitySecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = '';
  for (const byte of bytes) binary += String.fromCodePoint(byte);
  return btoa(binary).replaceAll('=', '').replaceAll('+', '-').replaceAll('/', '_');
}

app.get('/', requirePermission('settings:read'), async (c) => {
  const db = c.get('tenantDb');
  try {
    const rows = await db.select().from(widgets);
    return success(c, rows.map(publicWidget));
  } catch (err) {
    console.error('[app-api/desk-widget] list failed:', err);
    if (isDeskSchemaMissing(err)) {
      return error.unavailable(c, 'WeldDesk schema is not applied. Run tenant migration 0185_welddesk_webchat.');
    }
    return error.internal(c, 'Failed to list widgets');
  }
});

app.post('/', requirePermission('settings:update'), zValidator('json', createDeskWidgetSchema), async (c) => {
  const db = c.get('tenantDb');
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
      const masterDb = getMasterDb(c.env);
      await masterDb.insert(masterSchema.widgetRegistry).values({
        id: generateId('wr'),
        widgetId,
        workspaceId: c.get('workspaceId'),
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
    return success(c, publicWidget(created), 201);
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
    return success(c, publicWidget(row));
  } catch (err) {
    console.error('[app-api/desk-widget] get failed:', err);
    return error.internal(c, 'Failed to fetch widget');
  }
});

/** The columns a PATCH body changes: only the fields it sends; an empty away message clears it. */
function widgetSettingsPatch(data: UpdateDeskWidgetInput) {
  return {
    ...(data.widgetName !== undefined ? { widgetName: data.widgetName } : {}),
    ...(data.enabled !== undefined ? { enabled: data.enabled } : {}),
    ...(data.greeting !== undefined ? { greeting: data.greeting } : {}),
    ...(data.branding !== undefined ? { branding: data.branding } : {}),
    ...(data.allowedDomains !== undefined ? { allowedDomains: data.allowedDomains } : {}),
    ...(data.officeHours !== undefined ? { officeHours: data.officeHours } : {}),
    ...(data.timezone !== undefined ? { timezone: data.timezone } : {}),
    ...(data.awayMessage !== undefined ? { awayMessage: data.awayMessage || null } : {}),
    ...(data.expectedReplyTime !== undefined ? { expectedReplyTime: data.expectedReplyTime } : {}),
    ...(data.identityRequired !== undefined ? { identityRequired: data.identityRequired } : {}),
  };
}

app.patch('/:widgetId',requirePermission('settings:update'), zValidator('json', updateDeskWidgetSchema), async (c) => {
  const db = c.get('tenantDb');
  const widgetId = c.req.param('widgetId');
  const data = c.req.valid('json');
  try {
    const [existing] = await db.select().from(widgets).where(eq(widgets.widgetId, widgetId)).limit(1);
    if (!existing) return error.notFound(c, 'Widget', widgetId);
    if (data.identityRequired && !existing.identitySecret) {
      return error.badRequest(c, 'Set up identity verification before requiring it');
    }

    const [updated] = await db
      .update(widgets)
      .set({ updatedAt: new Date(), ...widgetSettingsPatch(data) })
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
      data: publicWidget(updated ?? existing) as unknown as Record<string, unknown>,
    });
    return success(c, publicWidget(updated ?? existing));
  } catch (err) {
    console.error('[app-api/desk-widget] update failed:', err);
    return error.internal(c, 'Failed to update widget');
  }
});

/** The identity secret and whether it is required; null secret = not set up. */
app.get('/:widgetId/identity', requirePermission('settings:manage'), async (c) => {
  const db = c.get('tenantDb');
  const widgetId = c.req.param('widgetId');
  try {
    const [row] = await db.select().from(widgets).where(eq(widgets.widgetId, widgetId)).limit(1);
    if (!row) return error.notFound(c, 'Widget', widgetId);
    return success(c, { secret: row.identitySecret, required: row.identityRequired });
  } catch (err) {
    console.error('[desk-api/desk-widget] identity read failed:', err);
    return error.internal(c, 'Failed to read identity verification');
  }
});

/** Set up or rotate the identity secret. Tokens signed with the old one stop working at once. */
app.post('/:widgetId/identity', requirePermission('settings:manage'), async (c) => {
  const db = c.get('tenantDb');
  const widgetId = c.req.param('widgetId');
  try {
    const [existing] = await db.select().from(widgets).where(eq(widgets.widgetId, widgetId)).limit(1);
    if (!existing) return error.notFound(c, 'Widget', widgetId);
    const [updated] = await db
      .update(widgets)
      .set({ identitySecret: newIdentitySecret(), updatedAt: new Date() })
      .where(eq(widgets.id, existing.id))
      .returning();
    const row = updated ?? existing;
    publishEntityEvent({
      c,
      entityType: 'desk_widget',
      action: 'updated',
      entityId: existing.id,
      data: publicWidget(row) as unknown as Record<string, unknown>,
    });
    return success(c, { secret: row.identitySecret, required: row.identityRequired });
  } catch (err) {
    console.error('[desk-api/desk-widget] identity rotate failed:', err);
    return error.internal(c, 'Failed to set up identity verification');
  }
});

/** Turn identity verification off: no secret, nobody required to be identified. */
app.delete('/:widgetId/identity', requirePermission('settings:manage'), async (c) => {
  const db = c.get('tenantDb');
  const widgetId = c.req.param('widgetId');
  try {
    const [existing] = await db.select().from(widgets).where(eq(widgets.widgetId, widgetId)).limit(1);
    if (!existing) return error.notFound(c, 'Widget', widgetId);
    const [updated] = await db
      .update(widgets)
      .set({ identitySecret: null, identityRequired: false, updatedAt: new Date() })
      .where(eq(widgets.id, existing.id))
      .returning();
    publishEntityEvent({
      c,
      entityType: 'desk_widget',
      action: 'updated',
      entityId: existing.id,
      data: publicWidget(updated ?? existing) as unknown as Record<string, unknown>,
    });
    return success(c, { secret: null, required: false });
  } catch (err) {
    console.error('[desk-api/desk-widget] identity remove failed:', err);
    return error.internal(c, 'Failed to turn off identity verification');
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
