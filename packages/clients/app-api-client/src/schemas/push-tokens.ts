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
  // voip / expo_call: a WeldChat device's call token (deviceId `<id>:call`),
  // used only for the native incoming-call ring (@weldsuite/notifications call-push).
  tokenType: z.enum(['expo', 'fcm', 'apns', 'voip', 'expo_call']).default('expo'),
  appCode: z.string().min(1).default('weldsuite'),
  deviceModel: z.string().optional(),
  osVersion: z.string().optional(),
  appVersion: z.string().optional(),
});

export const unregisterPushTokenQuery = z.object({ deviceId: z.string().min(1) });

export type RegisterPushTokenInput = z.infer<typeof registerPushTokenSchema>;
export type UnregisterPushTokenQuery = z.infer<typeof unregisterPushTokenQuery>;

/** `GET /`: an active token, masked to its last 12 characters. */
export const pushTokenSchema = z.object({
  deviceId: z.string(),
  platform: z.string(),
  appCode: z.string(),
  tokenSuffix: z.string().nullable(),
  lastUsedAt: z.string().nullable(),
  updatedAt: z.string(),
});

/** `GET /` answers `{ data: PushToken[] }`, without pagination. */
export const pushTokenListSchema = z.array(pushTokenSchema);

/** `POST /`. */
export const pushTokenRegisteredSchema = z.object({
  deviceId: z.string(),
  platform: z.enum(['ios', 'android', 'web']),
  registered: z.literal(true),
});

/** `DELETE /?deviceId=`. */
export const pushTokenUnregisteredSchema = z.object({
  deviceId: z.string(),
  unregistered: z.literal(true),
});

/** `POST /test`: the delivered and failed counts, Expo's reasons. */
export const pushTestResultSchema = z.object({
  sent: z.number().int(),
  failed: z.number().int(),
  errors: z.array(z.string()),
});

export type PushToken = z.infer<typeof pushTokenSchema>;
export type PushTestResult = z.infer<typeof pushTestResultSchema>;
