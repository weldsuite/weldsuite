/**
 * Parcel settings routes — /api/parcel-settings/* singleton config backed by
 * the `customSettings.parcel` JSONB key on `workspaceSettings`. Also exposes
 * a read-only carrier list and a write endpoint for per-carrier API
 * credentials (stored as JSONB on the `carriers` table).
 *
 * This is a singleton (no row ID on the parcel key) — GET / + PUT / only.
 * The carriers sub-routes are also not standard /:id CRUD so this route
 * directory is registered as EXEMPT in _event-coverage.test.ts for the
 * top-level list. The PUT / mutation still publishes an entity event.
 *
 * Permissions: carriers:read (reads) | carriers:update (mutations).
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, eq, isNull } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import {
  updateParcelSettingsSchema,
  updateCarrierCredentialsSchema,
} from '@weldsuite/app-api-client/schemas/parcel-settings';
import type { Env, Variables } from '../../types';
import { error, success } from '../../lib/response';
import { schema } from '../../db';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
const { workspaceSettings, carriers } = schema;

/**
 * GET / — Retrieve parcel module settings (parcel sub-key of customSettings).
 */
app.get('/', requirePermission('carriers:read'), async (c) => {
  try {
    const db = c.get('tenantDb');
    const workspaceId = c.get('workspaceId');

    const [settings] = await db
      .select()
      .from(workspaceSettings)
      .where(eq(workspaceSettings.id, workspaceId))
      .limit(1);

    const custom = (settings?.customSettings ?? {}) as Record<string, unknown>;
    const parcel = (custom.parcel ?? {}) as Record<string, unknown>;

    return success(c, {
      defaultCarrier: parcel.defaultCarrier as string | undefined,
      defaultServiceType: parcel.defaultServiceType as string | undefined,
      autoGenerateLabels: (parcel.autoGenerateLabels as boolean | undefined) ?? false,
      autoSendNotifications: (parcel.autoSendNotifications as boolean | undefined) ?? true,
      labelFormat: (parcel.labelFormat as string | undefined) ?? 'pdf',
      labelSize: (parcel.labelSize as string | undefined) ?? 'A6',
      defaultWeight: (parcel.defaultWeight as object | undefined) ?? { value: 1, unit: 'kg' },
      defaultDimensions: (parcel.defaultDimensions as object | undefined) ?? {
        length: 20,
        width: 15,
        height: 10,
        unit: 'cm',
      },
    });
  } catch (err) {
    console.error('[app-api/parcel-settings] get failed:', err);
    return error.internal(c, 'Failed to fetch settings');
  }
});

/**
 * PUT / — Update parcel module settings (merges into customSettings.parcel).
 */
app.put('/', requirePermission('carriers:update'), zValidator('json', updateParcelSettingsSchema), async (c) => {
  const data = c.req.valid('json');

  try {
    const db = c.get('tenantDb');
    const workspaceId = c.get('workspaceId');

    const [existing] = await db
      .select()
      .from(workspaceSettings)
      .where(eq(workspaceSettings.id, workspaceId))
      .limit(1);

    const custom = ((existing?.customSettings ?? {}) as Record<string, unknown>);
    const currentParcel = (custom.parcel ?? {}) as Record<string, unknown>;

    const newCustomSettings = {
      ...custom,
      parcel: { ...currentParcel, ...data },
    };

    const now = new Date();
    if (existing) {
      await db
        .update(workspaceSettings)
        .set({ customSettings: newCustomSettings, updatedAt: now })
        .where(eq(workspaceSettings.id, workspaceId));
    } else {
      await db.insert(workspaceSettings).values({
        id: workspaceId,
        customSettings: newCustomSettings,
        createdAt: now,
        updatedAt: now,
      } as unknown as typeof workspaceSettings.$inferInsert);
    }

    publishEntityEvent({
      c,
      entityType: 'parcel_settings',
      entityId: workspaceId,
      action: 'updated',
      data: data as unknown as Record<string, unknown>,
    });

    return success(c, { message: 'Settings updated successfully' });
  } catch (err) {
    console.error('[app-api/parcel-settings] update failed:', err);
    return error.internal(c, 'Failed to update settings');
  }
});

/**
 * GET /carriers — List carriers with their API credential status.
 */
app.get('/carriers', requirePermission('carriers:read'), async (c) => {
  try {
    const db = c.get('tenantDb');

    const results = await db
      .select({
        id: carriers.id,
        name: carriers.name,
        code: carriers.code,
        isActive: carriers.isActive,
        integrationType: carriers.integrationType,
        apiCredentials: carriers.apiCredentials,
        createdAt: carriers.createdAt,
        updatedAt: carriers.updatedAt,
      })
      .from(carriers)
      .where(isNull(carriers.deletedAt));

    return success(
      c,
      results.map((row) => ({
        id: row.id,
        name: row.name,
        code: row.code,
        isActive: row.isActive,
        integrationType: row.integrationType,
        hasApiCredentials: !!row.apiCredentials,
        createdAt: row.createdAt?.toISOString(),
        updatedAt: row.updatedAt?.toISOString(),
      })),
    );
  } catch (err) {
    console.error('[app-api/parcel-settings] carriers list failed:', err);
    return error.internal(c, 'Failed to fetch carrier settings');
  }
});

/**
 * PUT /carriers/:id/credentials — Update API credentials for a carrier.
 */
app.put(
  '/carriers/:id/credentials',
  requirePermission('carriers:update'),
  zValidator('json', updateCarrierCredentialsSchema),
  async (c) => {
    const carrierId = c.req.param('id');
    const credentials = c.req.valid('json');

    try {
      const db = c.get('tenantDb');

      const [existing] = await db
        .select({ id: carriers.id })
        .from(carriers)
        .where(and(eq(carriers.id, carrierId), isNull(carriers.deletedAt)))
        .limit(1);

      if (!existing) return error.notFound(c, 'Carrier', carrierId);

      await db
        .update(carriers)
        .set({ apiCredentials: credentials as unknown as typeof carriers.$inferInsert['apiCredentials'], updatedAt: new Date() })
        .where(and(eq(carriers.id, carrierId), isNull(carriers.deletedAt)));

      publishEntityEvent({
        c,
        entityType: 'parcel_settings',
        entityId: carrierId,
        action: 'updated',
        data: { carrierId, credentialsUpdated: true },
      });

      return success(c, { message: 'Carrier credentials updated successfully' });
    } catch (err) {
      console.error('[app-api/parcel-settings] update carrier credentials failed:', err);
      return error.internal(c, 'Failed to update carrier credentials');
    }
  },
);

export const parcelSettingsRoutes = app;
