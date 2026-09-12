/**
 * Tiny bridge so NotificationProvider (outer) can hand an incoming-call push
 * to CallProvider (inner) without reversing the provider tree.
 *
 * CallProvider registers a handler on mount; NotificationContext invokes
 * `presentIncomingCallFromPush` when a `chat_incoming_call` push arrives or
 * is tapped. If the handler is not registered yet (cold start), the payload
 * is queued until CallProvider mounts.
 */

export type IncomingCallPushPayload = {
  callId: string;
  channelId: string;
  callType: 'voice' | 'video';
  callerName: string;
  callerAvatar?: string;
};

type Handler = (payload: IncomingCallPushPayload) => void;

let handler: Handler | null = null;
let pending: IncomingCallPushPayload | null = null;

export function setIncomingCallPushHandler(next: Handler | null): void {
  handler = next;
  if (next && pending) {
    const queued = pending;
    pending = null;
    next(queued);
  }
}

export function presentIncomingCallFromPush(payload: IncomingCallPushPayload): void {
  if (handler) {
    handler(payload);
    return;
  }
  pending = payload;
}

/** Parse Expo notification `data` into a ring payload, or null if incomplete. */
export function incomingCallPayloadFromNotificationData(
  data: Record<string, unknown>,
): IncomingCallPushPayload | null {
  if (data.notificationType !== 'chat_incoming_call') return null;

  const callId = typeof data.entityId === 'string' ? data.entityId : '';
  if (!/^[A-Za-z0-9_-]+$/.test(callId)) return null;

  const channelId =
    typeof data.chatChannelId === 'string'
      ? data.chatChannelId
      : typeof data.channelId === 'string'
        ? data.channelId
      : typeof data.actionUrl === 'string'
        ? (data.actionUrl.match(/\/weldchat\/(?:dm\/)?([^/?#]+)/)?.[1] ?? '')
        : '';
  if (!channelId) return null;

  const callType = data.callType === 'video' ? 'video' : 'voice';
  const callerName =
    typeof data.callerName === 'string' && data.callerName.trim()
      ? data.callerName.trim()
      : 'Incoming call';
  const callerAvatar =
    typeof data.callerAvatar === 'string' && data.callerAvatar ? data.callerAvatar : undefined;

  return { callId, channelId, callType, callerName, callerAvatar };
}
