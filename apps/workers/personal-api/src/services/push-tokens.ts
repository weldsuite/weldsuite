/**
 * Push-tokens service for PERSONAL (consumer WeldMail) accounts.
 *
 * Mirrors app-api's `services/push-tokens.ts`, but writes to the shared
 * personal DB instead of a tenant DB. Personal accounts have no Clerk org and
 * therefore no tenant, so the workspace table is unreachable for them — see
 * `personal_device_tokens` for why the separate home exists.
 *
 * Pure functions over the personal Drizzle client; no Hono context.
 */

import { and, eq } from 'drizzle-orm';
import { personalSchema, type PersonalDatabase } from '../db';
import { generateId } from '../lib/id';

const { personalDeviceTokens } = personalSchema;

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
 * Upsert a device token keyed by `(personalAccountId, deviceId, appCode)`.
 * Re-activates a previously deactivated token (`isActive` null = active), so a
 * reinstall or a token refresh replaces the row rather than accumulating dead
 * tokens that Expo would reject one at a time.
 */
export async function registerPersonalPushToken(
  db: PersonalDatabase,
  personalAccountId: string,
  clerkUserId: string,
  input: RegisterPushTokenInput,
): Promise<void> {
  const now = new Date();
  await db
    .insert(personalDeviceTokens)
    .values({
      id: generateId('pdt'),
      personalAccountId,
      clerkUserId,
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
      target: [
        personalDeviceTokens.personalAccountId,
        personalDeviceTokens.deviceId,
        personalDeviceTokens.appCode,
      ],
      set: {
        token: input.token,
        tokenType: input.tokenType,
        platform: input.platform,
        // Carried on update too: a device can outlive a Clerk user id change
        // (account merge), and the inbound worker pushes by clerkUserId.
        clerkUserId,
        deviceModel: input.deviceModel,
        osVersion: input.osVersion,
        appVersion: input.appVersion,
        isActive: null,
        lastUsedAt: now,
        updatedAt: now,
      },
    });
}

/** Deactivate the caller's token for a device (sets the `isActive` timestamp). */
export async function unregisterPersonalPushToken(
  db: PersonalDatabase,
  personalAccountId: string,
  deviceId: string,
): Promise<void> {
  const now = new Date();
  await db
    .update(personalDeviceTokens)
    .set({ isActive: now, updatedAt: now })
    .where(
      and(
        eq(personalDeviceTokens.personalAccountId, personalAccountId),
        eq(personalDeviceTokens.deviceId, deviceId),
      ),
    );
}
