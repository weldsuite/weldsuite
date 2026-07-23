/**
 * Push token routes — /api/push-tokens.
 *
 * Register / deactivate Expo (or FCM/APNs) device tokens for push
 * notifications. Tokens live in the tenant `device_tokens` table, keyed by
 * `(userId, deviceId, appCode)`. Like the dashboard's checklist-dismiss
 * mutation, this is device-plumbing rather than a business-object lifecycle
 * change, so it intentionally does not publish an entity event — it would
 * only add noise to audit logging / workflow / agent dispatch. Authentication
 * + tenant resolution is enforced by the `/api/*` Clerk + workspace-db
 * middleware.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import type { Env, Variables } from '../../types';
import { error, success } from '../../lib/response';
import { registerPushToken, unregisterPushToken } from '../../services/push-tokens';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

const registerBody = z.object({
  token: z.string().min(1),
  platform: z.enum(['ios', 'android', 'web']),
  deviceId: z.string().min(1),
  tokenType: z.enum(['expo', 'fcm', 'apns']).default('expo'),
  appCode: z.string().min(1).default('weldsuite'),
  deviceModel: z.string().optional(),
  osVersion: z.string().optional(),
  appVersion: z.string().optional(),
});

const unregisterQuery = z.object({ deviceId: z.string().min(1) });

// ============================================================================
// POST / — upsert a device token (re-activates if previously deactivated)
// ============================================================================

app.post('/', zValidator('json', registerBody), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const data = c.req.valid('json');

  try {
    await registerPushToken(db, userId, data);
    return success(c, { deviceId: data.deviceId, platform: data.platform, registered: true });
  } catch (err) {
    console.error('[app-api/push-tokens] register failed:', err);
    return error.internal(c, 'Failed to register push token');
  }
});

// ============================================================================
// DELETE /?deviceId= — deactivate the caller's token for a device
// ============================================================================

app.delete('/', zValidator('query', unregisterQuery), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const { deviceId } = c.req.valid('query');

  try {
    await unregisterPushToken(db, userId, deviceId);
    return success(c, { deviceId, unregistered: true });
  } catch (err) {
    console.error('[app-api/push-tokens] unregister failed:', err);
    return error.internal(c, 'Failed to unregister push token');
  }
});

export const pushTokensRoutes = app;
