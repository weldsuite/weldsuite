/**
 * Native incoming-call delivery — the WhatsApp-style ring.
 *
 * A WeldChat build with native call support registers a second "call" token
 * per device next to its Expo token, under deviceId `<deviceId>:call`:
 *   - iOS: the PushKit VoIP token (`tokenType: 'voip'`). Rung through APNs
 *     directly; the app reports it to CallKit, which shows the system
 *     incoming-call screen (lock screen included) and plays the ringtone.
 *   - Android: the device's Expo token again (`tokenType: 'expo_call'`). Rung
 *     with a data-only, high-priority Expo push; the app's background task
 *     turns it into a full-screen call notification that keeps ringing.
 *
 * A device that has a call token gets the native ring INSTEAD of the ordinary
 * "Incoming call" banner; a device without one (older builds) keeps the banner.
 * Call tokens never receive any other notification: an Android `expo_call`
 * token is the same Expo token as the device's normal row, and a VoIP token is
 * not an Expo token at all (Expo would reject it and we would deactivate it).
 *
 * Every ring is followed by a cancel push when the call stops ringing for that
 * user (answered on another device, declined, hung up, timed out), so the
 * phone stops ringing even while the app is not running.
 */

import { and, eq, inArray, isNull, or } from 'drizzle-orm';
import * as schema from '@weldsuite/db/schema';
import { getChannelPreferences } from '../preferences';
import type { Database, NotificationEnv } from '../types';
import { apnsConfigFromEnv, sendApnsVoipPush, type ApnsConfig } from './apns';
import { isExpoPushToken, sendExpoPush, type ExpoPushMessage } from './push';

/** Suffix on `device_tokens.device_id` for a device's call token. */
export const CALL_DEVICE_SUFFIX = ':call';

export type CallTokenType = 'voip' | 'expo_call';
const CALL_TOKEN_TYPES: readonly string[] = ['voip', 'expo_call'] satisfies CallTokenType[];

/**
 * How long a ring stays valid on the device. Longer than the server's ring
 * timeout (chat-domain `RING_TIMEOUT_MS`), whose cancel push normally ends the
 * ring first; this only bounds a ring whose cancel never arrives.
 */
export const CALL_RING_TTL_MS = 60_000;

/** `notificationType` of the native ring and cancel pushes (in the push data). */
export const CALL_RING_TYPE = 'chat_call_ring';
export const CALL_CANCEL_TYPE = 'chat_call_cancel';

/** PushKit topic per app (`<bundle id>.voip`). Only WeldChat has CallKit. */
const VOIP_TOPICS: Record<string, string> = {
  weldchat: 'com.weldsuite.weldchat.voip',
};

/** Why a call stopped ringing on this user's devices. */
export type CallCancelReason = 'answered' | 'declined' | 'ended';

export interface DeviceTokenRow {
  token: string | null;
  appCode: string;
  deviceId: string;
  tokenType: string;
}

export function isCallToken(row: Pick<DeviceTokenRow, 'tokenType'>): boolean {
  return CALL_TOKEN_TYPES.includes(row.tokenType);
}

/** The device a call token belongs to (its `deviceId` without the suffix). */
export function callTokenDeviceId(deviceId: string): string {
  return deviceId.endsWith(CALL_DEVICE_SUFFIX) ? deviceId.slice(0, -CALL_DEVICE_SUFFIX.length) : deviceId;
}

export interface CallPushResult {
  /** Devices (base deviceId) the native push was handed to. */
  deliveredDeviceIds: Set<string>;
  /** Tokens the push service says are dead. */
  invalidTokens: string[];
}

async function sendVoip(
  config: ApnsConfig | null,
  rows: DeviceTokenRow[],
  payload: Record<string, unknown>,
  expiration: number,
  result: CallPushResult,
): Promise<void> {
  await Promise.all(
    rows.map(async (row) => {
      const topic = VOIP_TOPICS[row.appCode];
      if (!config || !topic || !row.token) return;
      const sent = await sendApnsVoipPush(config, { deviceToken: row.token, topic, payload, expiration });
      if (sent.status === 'ok') {
        result.deliveredDeviceIds.add(callTokenDeviceId(row.deviceId));
      } else if (sent.status === 'invalid-token') {
        result.invalidTokens.push(row.token);
      } else {
        console.error(`[CallPush] VoIP push failed device=${row.deviceId}: ${sent.reason}`);
      }
    }),
  );
}

async function sendAndroidData(
  rows: DeviceTokenRow[],
  data: Record<string, string>,
  ttlSeconds: number,
  result: CallPushResult,
): Promise<void> {
  const eligible: DeviceTokenRow[] = [];
  for (const row of rows) {
    if (row.token && isExpoPushToken(row.token)) eligible.push(row);
    else if (row.token) result.invalidTokens.push(row.token);
  }
  // One batch per app: Expo rejects a batch that mixes EAS projects.
  const byAppCode = new Map<string, DeviceTokenRow[]>();
  for (const row of eligible) byAppCode.set(row.appCode, [...(byAppCode.get(row.appCode) ?? []), row]);

  await Promise.all(
    [...byAppCode.values()].map(async (appRows) => {
      // Data-only (no title/body/sound): Android hands it to the app's
      // background task instead of drawing a banner. High priority wakes the
      // device from Doze; the ttl drops a ring that could not arrive in time.
      const messages: ExpoPushMessage[] = appRows.map((row) => ({
        to: row.token as string,
        data,
        priority: 'high',
        ttl: ttlSeconds,
      }));
      const { tickets, invalidTokens } = await sendExpoPush(messages);
      result.invalidTokens.push(...invalidTokens.filter(Boolean));
      // Every message here is an Expo token, so tickets line up with rows.
      tickets.forEach((ticket, i) => {
        const row = appRows[i];
        if (ticket.status === 'ok' && row) result.deliveredDeviceIds.add(callTokenDeviceId(row.deviceId));
        else if (ticket.status === 'error') console.error(`[CallPush] Expo call push failed: ${ticket.message}`);
      });
    }),
  );
}

async function sendToCallTokens(
  env: NotificationEnv,
  rows: DeviceTokenRow[],
  data: Record<string, string>,
  ttlMs: number,
): Promise<CallPushResult> {
  const result: CallPushResult = { deliveredDeviceIds: new Set(), invalidTokens: [] };
  const expiration = Math.floor((Date.now() + ttlMs) / 1000);
  await Promise.all([
    sendVoip(
      apnsConfigFromEnv(env),
      rows.filter((r) => r.tokenType === 'voip'),
      { aps: {}, weldchat: data },
      expiration,
      result,
    ),
    sendAndroidData(
      rows.filter((r) => r.tokenType === 'expo_call'),
      data,
      Math.ceil(ttlMs / 1000),
      result,
    ),
  ]);
  return result;
}

/**
 * Ring the call tokens among `rows` with the incoming-call push `data` (the
 * orchestrator's push data: entityId = callId, chatChannelId, callType,
 * callerName, callerAvatar, declineToken). Never throws.
 */
export async function sendCallRing(
  env: NotificationEnv,
  rows: DeviceTokenRow[],
  data: Record<string, string>,
): Promise<CallPushResult> {
  try {
    return await sendToCallTokens(
      env,
      rows.filter(isCallToken),
      {
        ...data,
        notificationType: CALL_RING_TYPE,
        callId: data.entityId ?? '',
        expiresAt: String(Date.now() + CALL_RING_TTL_MS),
      },
      CALL_RING_TTL_MS,
    );
  } catch (err) {
    console.error('[CallPush] Ring failed:', err);
    return { deliveredDeviceIds: new Set(), invalidTokens: [] };
  }
}

/** Mark dead tokens inactive so we stop sending to them. */
export async function deactivateDeviceTokens(db: Database, tokens: string[]): Promise<void> {
  if (tokens.length === 0) return;
  await db
    .update(schema.deviceTokens)
    .set({ isActive: new Date(), updatedAt: new Date() })
    .where(inArray(schema.deviceTokens.token, tokens));
}

export interface CancelIncomingCallParams {
  db: Database;
  env: NotificationEnv;
  userId: string;
  callId: string;
  reason: CallCancelReason;
}

/**
 * Stop a ring on every device of `userId`. Sent when a call stops ringing for
 * them; a device that is not ringing for this call ignores it. Skipped when
 * the user's WeldChat pushes are off, since no ring went out then. Never throws.
 */
export async function cancelIncomingCallPush(params: CancelIncomingCallParams): Promise<void> {
  const { db, env, userId, callId, reason } = params;
  try {
    const prefs = await getChannelPreferences(db, userId, 'weldchat');
    if (!prefs.push) return;

    const rows = await db
      .select({
        token: schema.deviceTokens.token,
        appCode: schema.deviceTokens.appCode,
        deviceId: schema.deviceTokens.deviceId,
        tokenType: schema.deviceTokens.tokenType,
      })
      .from(schema.deviceTokens)
      .where(
        and(
          eq(schema.deviceTokens.userId, userId),
          isNull(schema.deviceTokens.isActive),
          or(eq(schema.deviceTokens.tokenType, 'voip'), eq(schema.deviceTokens.tokenType, 'expo_call')),
        ),
      );
    if (rows.length === 0) return;

    const { invalidTokens } = await sendToCallTokens(
      env,
      rows,
      { notificationType: CALL_CANCEL_TYPE, callId, reason },
      CALL_RING_TTL_MS,
    );
    await deactivateDeviceTokens(db, invalidTokens);
  } catch (err) {
    console.error('[CallPush] Cancel failed:', err);
  }
}
