/**
 * WeldDesk routing rules — /api/desk/routing
 *
 * Stored in `helpdesk_settings.automation.deskRouting`; the rules run where
 * conversations open (widget, email, phone, portal, API) and where their type
 * or tags change, via `@weldsuite/db/lib/desk-routing`.
 *
 *   GET  /   the ordered rules            (settings:read)
 *   PUT  /   replace the ordered rules    (settings:update)
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { updateDeskRoutingSchema } from '@weldsuite/core-api-client/schemas/desk-routing';
import { getDeskRoutingSettings, saveDeskRoutingSettings } from '@weldsuite/db/lib/desk-routing';
import { error, success } from '@weldsuite/worker-kit/response';
import { generateId } from '@weldsuite/worker-kit/id';
import type { Env, Variables } from '../../types';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

app.get('/', requirePermission('settings:read'), async (c) => {
  try {
    const { settings } = await getDeskRoutingSettings(c.get('tenantDb'));
    return success(c, settings);
  } catch (err) {
    console.error('[desk-api/desk-routing] get failed:', err);
    return error.internal(c, 'Failed to load routing rules');
  }
});

app.put('/', requirePermission('settings:update'), zValidator('json', updateDeskRoutingSchema), async (c) => {
  const db = c.get('tenantDb');
  const data = c.req.valid('json');
  try {
    const settings = await saveDeskRoutingSettings(db, generateId, data);
    const { settingsId } = await getDeskRoutingSettings(db);
    if (settingsId) {
      publishEntityEvent({
        c,
        entityType: 'helpdesk_settings',
        action: 'updated',
        entityId: settingsId,
        data: { deskRouting: settings },
      });
    }
    return success(c, settings);
  } catch (err) {
    console.error('[desk-api/desk-routing] update failed:', err);
    return error.internal(c, 'Failed to save routing rules');
  }
});

export { app as deskRoutingRoutes };
