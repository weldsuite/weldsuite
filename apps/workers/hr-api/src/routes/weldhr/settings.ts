/**
 * /api/weldhr/settings — the My HR self-service switches (back office).
 */

import { Hono } from 'hono';
import { requirePermission } from '@weldsuite/permissions/server';
import { updateHrSettingsSchema } from '@weldsuite/app-api-client/schemas/weldhr';
import type { Env, Variables } from '../../types';
import { success } from '@weldsuite/worker-kit/response';
import { loadHrSettings, updateHrSettings } from '../../services/weldhr/settings';
import { recordHrAudit } from '../../services/weldhr/shared';
import { actor, hrJson, clientIp, db } from './helpers';

export const settingsRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

settingsRoutes.get('/', requirePermission('employees:read'), async (c) => success(c, await loadHrSettings(db(c))));

settingsRoutes.put('/', requirePermission('employees:manage'), hrJson(updateHrSettingsSchema), async (c) => {
  const input = c.req.valid('json');
  const row = await updateHrSettings(db(c), input);
  await recordHrAudit(db(c), {
    actorId: actor(c),
    action: 'settings.updated',
    metadata: { fields: Object.keys(input) },
    ip: clientIp(c),
  });
  return success(c, row);
});
