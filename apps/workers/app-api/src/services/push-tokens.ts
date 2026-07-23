/**
 * Push-tokens service — tenant-DB writes for push notification device
 * tokens. Pure functions over the tenant Drizzle client; no Hono context.
 */

import { and, eq } from 'drizzle-orm';
import { schema, type Database } from '../db';
import { generateId } from '../lib/id';

const { deviceTokens } = schema;

export interface RegisterPushTokenInput {
  token: string;
  platform: 'ios' | 'android' | 'web';
  deviceId: string;
  tokenType: 'expo' | 'fcm' | 'apns';
  appCode: string;
  deviceModel?: string;
  osVersion?: string;
  appVersion?: string;
}

/**
 * Upsert a device token keyed by `(userId, deviceId, appCode)`. Re-activates
 * a previously deactivated token (`isActive` null = active).
 */
export async function registerPushToken(
  db: Database,
  userId: string,
  input: RegisterPushTokenInput,
): Promise<void> {
  const now = new Date();
  await db
    .insert(deviceTokens)
    .values({
      id: generateId('dt'),
      userId,
      deviceId: input.deviceId,
      platform: input.platform,
      token: input.token,
      tokenType: input.tokenType,
      appCode: input.appCode,
      deviceModel: input.deviceModel,
      osVersion: input.osVersion,
      appVersion: input.appVersion,
      isActive: null,
      lastUsedAt: now,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [deviceTokens.userId, deviceTokens.deviceId, deviceTokens.appCode],
      set: {
        token: input.token,
        tokenType: input.tokenType,
        platform: input.platform,
        deviceModel: input.deviceModel,
        osVersion: input.osVersion,
        appVersion: input.appVersion,
        isActive: null,
        lastUsedAt: now,
        updatedAt: now,
      },
    });
}

/** Deactivate the caller's token for a device (sets `isActive` timestamp). */
export async function unregisterPushToken(
  db: Database,
  userId: string,
  deviceId: string,
): Promise<void> {
  await db
    .update(deviceTokens)
    .set({ isActive: new Date(), updatedAt: new Date() })
    .where(and(eq(deviceTokens.userId, userId), eq(deviceTokens.deviceId, deviceId)));
}
