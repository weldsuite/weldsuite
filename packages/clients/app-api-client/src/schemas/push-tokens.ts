/**
 * `/api/push-tokens` — register / deactivate Expo (or FCM/APNs) device
 * tokens for push notifications. Mirrors the inline zod in
 * `apps/workers/app-api/src/routes/push-tokens/index.ts`.
 */

import { z } from 'zod';

export const registerPushTokenSchema = z.object({
  token: z.string().min(1),
  platform: z.enum(['ios', 'android', 'web']),
  deviceId: z.string().min(1),
  tokenType: z.enum(['expo', 'fcm', 'apns']).default('expo'),
  appCode: z.string().min(1).default('weldsuite'),
  deviceModel: z.string().optional(),
  osVersion: z.string().optional(),
  appVersion: z.string().optional(),
});

export const unregisterPushTokenQuery = z.object({ deviceId: z.string().min(1) });

export type RegisterPushTokenInput = z.infer<typeof registerPushTokenSchema>;
export type UnregisterPushTokenQuery = z.infer<typeof unregisterPushTokenQuery>;
