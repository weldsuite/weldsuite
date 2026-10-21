/**
 * The server's native call pushes (`@weldsuite/notifications` call-push):
 * `chat_call_ring` starts the native ring, `chat_call_cancel` stops it. On
 * Android they arrive as data-only Expo pushes in the background task
 * (`call-push-task.ts`); on iOS as VoIP pushes, handled natively.
 */

import type { IncomingCallPushPayload } from './incoming-call-bridge';

export const CALL_RING_TYPE = 'chat_call_ring';
export const CALL_CANCEL_TYPE = 'chat_call_cancel';

export type CallPush =
  | { kind: 'ring'; payload: Record<string, string> }
  | { kind: 'cancel'; callId: string; reason: string };

const ID_RE = /^[A-Za-z0-9_-]+$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parseJsonRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'string') return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * The push `data` out of an expo-notifications background-task payload. Expo
 * hands it over as a JSON string (`dataString`, or `body` on older clients),
 * or as plain keys. Null for a notification-response payload (a tap).
 */
export function callPushData(taskData: unknown): Record<string, unknown> | null {
  if (!isRecord(taskData) || 'actionIdentifier' in taskData) return null;
  const data = taskData.data;
  if (!isRecord(data)) return null;
  return parseJsonRecord(data.dataString) ?? parseJsonRecord(data.body) ?? data;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function parseCallPush(data: Record<string, unknown> | null): CallPush | null {
  if (!data) return null;
  const callId = str(data.callId) || str(data.entityId);
  if (!ID_RE.test(callId)) return null;

  if (data.notificationType === CALL_CANCEL_TYPE) {
    return { kind: 'cancel', callId, reason: str(data.reason) || 'ended' };
  }
  if (data.notificationType !== CALL_RING_TYPE) return null;

  const channelId = str(data.chatChannelId) || str(data.channelId);
  if (!ID_RE.test(channelId)) return null;
  const payload: Record<string, string> = {
    callId,
    channelId,
    callType: data.callType === 'video' ? 'video' : 'voice',
    callerName: str(data.callerName),
  };
  for (const key of ['callerAvatar', 'declineToken', 'expiresAt'] as const) {
    const value = str(data[key]);
    if (value) payload[key] = value;
  }
  return { kind: 'ring', payload };
}

/** A native ring payload as the app's incoming-call shape. */
export function incomingFromNativePayload(payload: Record<string, string>): IncomingCallPushPayload | null {
  const callId = payload.callId ?? '';
  const channelId = payload.channelId ?? '';
  if (!ID_RE.test(callId) || !ID_RE.test(channelId)) return null;
  return {
    callId,
    channelId,
    callType: payload.callType === 'video' ? 'video' : 'voice',
    callerName: payload.callerName || 'Incoming call',
    callerAvatar: payload.callerAvatar || undefined,
  };
}

/** The app's incoming-call shape as a native ring payload (rings from the socket). */
export function nativePayloadFromIncoming(incoming: IncomingCallPushPayload): Record<string, string> {
  return {
    callId: incoming.callId,
    channelId: incoming.channelId,
    callType: incoming.callType,
    callerName: incoming.callerName,
    ...(incoming.callerAvatar ? { callerAvatar: incoming.callerAvatar } : {}),
  };
}
