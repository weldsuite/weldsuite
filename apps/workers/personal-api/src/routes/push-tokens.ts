/**
 * Push token routes — /api/push-tokens.
 *
 * Register / deactivate device tokens so a personal `@weldmail.com` address
 * can raise a push notification on inbound mail. The workspace equivalent is
 * app-api's `/api/push-tokens`, which writes to the tenant DB; personal
 * accounts have no tenant, so the WeldMail app registers here instead when the
 * signed-in user is using a personal address.
 *
 * Authentication is enforced by the `/api/*` Clerk + personal-account
 * middleware, and every row is scoped to the caller's own personal account.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { getPersonalDb } from '../db';
import { error, success } from '../lib/response';
import {
  registerPersonalPushToken,
  unregisterPersonalPushToken,
} from '../services/push-tokens';
import type { Env, Variables } from '../types';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

const registerBody = z.object({
  token: z.string().min(1),
  platform: z.enum(['ios', 'android', 'web']),
  deviceId: z.string().min(1),
  tokenType: z.enum(['expo', 'fcm', 'apns']).default('expo'),
  appCode: z.string().min(1).default('weldmail'),
  deviceModel: z.string().optional(),
  osVersion: z.string().optional(),
  appVersion: z.string().optional(),
});

const unregisterQuery = z.object({ deviceId: z.string().min(1) });

app.post('/', zValidator('json', registerBody), async (c) => {
  const personalAccountId = c.get('personalAccountId');
  if (!personalAccountId) return error.personalAccountRequired(c);

  const data = c.req.valid('json');

  try {
    const personalDb = getPersonalDb(c.env);
    await registerPersonalPushToken(personalDb, personalAccountId, c.get('userId'), data);
    return success(c, { deviceId: data.deviceId, platform: data.platform, registered: true });
  } catch (err) {
    console.error('[personal-api/push-tokens] register failed:', err);
    return error.internal(c, 'Failed to register push token');
  }
});

app.delete('/', zValidator('query', unregisterQuery), async (c) => {
  const personalAccountId = c.get('personalAccountId');
  if (!personalAccountId) return error.personalAccountRequired(c);

  const { deviceId } = c.req.valid('query');

  try {
    const personalDb = getPersonalDb(c.env);
    await unregisterPersonalPushToken(personalDb, personalAccountId, deviceId);
    return success(c, { deviceId, unregistered: true });
  } catch (err) {
    console.error('[personal-api/push-tokens] unregister failed:', err);
    return error.internal(c, 'Failed to unregister push token');
  }
});

export const pushTokensRoutes = app;
