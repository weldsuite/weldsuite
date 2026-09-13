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
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { sendExpoPush } from '@weldsuite/notifications';
import type { Env, Variables } from '../../types';
import { error, success } from '../../lib/response';
import { schema } from '../../db';
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
// GET / — list the caller's active tokens (masked) so the mobile Settings
// screen can show whether registration actually stuck.
// ============================================================================

app.get('/', async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');

  try {
    const rows = await db
      .select({
        deviceId: schema.deviceTokens.deviceId,
        platform: schema.deviceTokens.platform,
        appCode: schema.deviceTokens.appCode,
        token: schema.deviceTokens.token,
        lastUsedAt: schema.deviceTokens.lastUsedAt,
        updatedAt: schema.deviceTokens.updatedAt,
      })
      .from(schema.deviceTokens)
      .where(and(eq(schema.deviceTokens.userId, userId), isNull(schema.deviceTokens.isActive)));

    return success(
      c,
      rows.map((r) => ({
        deviceId: r.deviceId,
        platform: r.platform,
        appCode: r.appCode,
        // Mask the token so the Settings screen can confirm presence without
        // leaking a full ExponentPushToken into screenshots / support chats.
        tokenSuffix: r.token?.slice(-12) ?? null,
        lastUsedAt: r.lastUsedAt,
        updatedAt: r.updatedAt,
      })),
    );
  } catch (err) {
    console.error('[app-api/push-tokens] list failed:', err);
    return error.internal(c, 'Failed to list push tokens');
  }
});

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
// POST /test — send a real Expo push to the caller's registered devices.
// Used by WeldChat Settings to prove FCM/APNs delivery independently of chat.
// ============================================================================

app.post('/test', async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');

  try {
    // Match the WeldChat DM orchestrator filter (weldchat + weldsuite app codes).
    const rows = await db
      .select({ token: schema.deviceTokens.token, appCode: schema.deviceTokens.appCode })
      .from(schema.deviceTokens)
      .where(
        and(
          eq(schema.deviceTokens.userId, userId),
          isNull(schema.deviceTokens.isActive),
          inArray(schema.deviceTokens.appCode, ['weldchat', 'weldsuite']),
        ),
      );

    const tokens = rows.map((r) => r.token).filter(Boolean);
    if (tokens.length === 0) {
      return error.badRequest(
        c,
        'No active WeldChat push token registered for this account. Open WeldChat, grant notification permission, then try again.',
      );
    }

    const { tickets, invalidTokens } = await sendExpoPush(
      tokens.map((to) => ({
        to,
        title: 'WeldChat test',
        body: 'If you see this, push delivery works.',
        sound: 'default' as const,
        priority: 'high' as const,
        channelId: 'chat',
        data: {
          notificationType: 'push_test',
          actionUrl: '',
          entityType: '',
          entityId: '',
        },
      })),
    );

    const toDeactivate = invalidTokens.filter(Boolean);
    if (toDeactivate.length > 0) {
      await db
        .update(schema.deviceTokens)
        .set({ isActive: new Date(), updatedAt: new Date() })
        .where(inArray(schema.deviceTokens.token, toDeactivate));
    }

    const ok = tickets.filter((t) => t.status === 'ok').length;
    const failed = tickets.filter((t) => t.status === 'error');
    if (ok === 0) {
      console.error('[app-api/push-tokens] test push failed:', failed);
      return error.internal(
        c,
        failed[0]?.message || failed[0]?.details?.error || 'Expo rejected the test push',
      );
    }

    return success(c, {
      sent: ok,
      failed: failed.length,
      errors: failed.map((t) => t.details?.error || t.message || 'error'),
    });
  } catch (err) {
    console.error('[app-api/push-tokens] test failed:', err);
    return error.internal(c, 'Failed to send test push');
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
