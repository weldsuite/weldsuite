/**
 * /api/reach/settings: the workspace's single WeldReach settings row (sender
 * identity for the email footer, sending defaults, onboarding).
 *
 *   reach_settings:read    GET   (creates the row with defaults on first read)
 *   reach_settings:update  PATCH (`completeOnboarding: true` closes the wizard)
 *
 * The entity-event catalog has no settings entity, so PATCH publishes nothing:
 * a settings change touches no campaign, mailbox or domain record.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { requirePermission } from '@weldsuite/permissions/server';
import { success } from '@weldsuite/worker-kit/response';
import { updateReachSettingsSchema } from '@weldsuite/app-api-client/schemas/reach';
import type { Env, Variables } from '../../types';
import { reachErrorHandler } from '../../services/reach-errors';
import { getOrCreateReachSettings, toReachSettingsDto, updateReachSettings } from '../../services/settings';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

app.onError(reachErrorHandler);

app.get('/', requirePermission('reach_settings:read'), async (c) => {
  return success(c, toReachSettingsDto(await getOrCreateReachSettings(c.get('tenantDb'))));
});

app.patch('/', requirePermission('reach_settings:update'), zValidator('json', updateReachSettingsSchema), async (c) => {
  const row = await updateReachSettings(c.get('tenantDb'), c.req.valid('json'));
  return success(c, toReachSettingsDto(row));
});

export default app;
