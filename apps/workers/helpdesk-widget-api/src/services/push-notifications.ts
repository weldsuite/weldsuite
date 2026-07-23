/**
 * Push notification service for helpdesk widget API
 *
 * Sends push notifications to agents when customers create
 * conversations or send messages.
 * - ExponentPushToken → Expo Push API
 * - Raw FCM tokens → FCM HTTP API directly
 * Fire-and-forget — never blocks the response.
 */

import { isNull } from 'drizzle-orm';
import { sendExpoPush, type ExpoPushMessage } from '../lib/expo-push';
import { sendFcmPush } from '../lib/fcm-push';
import { schema } from '../db';
import type { Database } from '../db';

interface DeviceWithType {
  token: string;
  tokenType: string | null;
}

/**
 * Get all active device tokens with their type
 */
async function getActiveDevices(db: Database): Promise<DeviceWithType[]> {
  const devices = await db
    .select({
      token: schema.deviceTokens.token,
      tokenType: schema.deviceTokens.tokenType,
    })
    .from(schema.deviceTokens)
    .where(isNull(schema.deviceTokens.isActive));

  console.log(`[Push] Found ${devices.length} active device token(s) in database`);

  // Deduplicate by token
  const seen = new Set<string>();
  return devices.filter((d) => {
    if (seen.has(d.token)) return false;
    seen.add(d.token);
    return true;
  });
}

/**
 * Send push notifications to all devices, routing to the correct push service.
 * ExponentPushToken → Expo, raw FCM tokens → FCM directly.
 */
async function sendPushToDevices(
  devices: DeviceWithType[],
  notification: {
    title: string;
    body: string;
    data: Record<string, string>;
  },
  firebaseServiceAccount?: string
): Promise<void> {
  const expoTokens: string[] = [];
  const fcmTokens: string[] = [];

  for (const device of devices) {
    if (device.token.startsWith('ExponentPushToken[')) {
      expoTokens.push(device.token);
    } else if (device.tokenType === 'fcm' || !device.token.startsWith('ExponentPushToken[')) {
      fcmTokens.push(device.token);
    }
  }

  console.log(`[Push] Routing: ${expoTokens.length} Expo token(s), ${fcmTokens.length} FCM token(s)`);

  const promises: Promise<any>[] = [];

  if (expoTokens.length > 0) {
    const messages: ExpoPushMessage[] = expoTokens.map((token) => ({
      to: token,
      title: notification.title,
      body: notification.body,
      data: notification.data,
      sound: 'default' as const,
      channelId: 'helpdesk',
      priority: 'high' as const,
    }));
    promises.push(
      sendExpoPush(messages).then((result) => {
        console.log(`[Push] Expo result: ${result.tickets.length} ticket(s), ${result.invalidTokens.length} invalid`);
        result.tickets.forEach((ticket, i) => {
          if (ticket.status === 'error') {
            console.warn(`[Push] Expo ticket ${i}: error=${ticket.details?.error}, message=${ticket.message}`);
          }
        });
      })
    );
  }

  if (fcmTokens.length > 0) {
    promises.push(
      sendFcmPush(fcmTokens, notification, firebaseServiceAccount)
    );
  }

  await Promise.allSettled(promises);
}

/**
 * Notify all agents with registered devices about a new conversation.
 */
export async function notifyAgentsOfNewConversation(
  db: Database,
  conversation: {
    id: string;
    subject: string;
    customerName?: string;
    preview?: string;
  },
  firebaseServiceAccount?: string
): Promise<void> {
  try {
    const devices = await getActiveDevices(db);
    if (devices.length === 0) return;

    console.log(`[Push] Sending new conversation notification to ${devices.length} device(s)`);

    await sendPushToDevices(devices, {
      title: 'New Conversation',
      body: conversation.customerName
        ? `${conversation.customerName}: ${conversation.subject}`
        : conversation.subject,
      data: {
        type: 'helpdesk',
        action: 'new_conversation',
        conversationId: conversation.id,
      },
    }, firebaseServiceAccount);
  } catch (err) {
    console.error('[Push] Failed to notify agents of new conversation:', err);
  }
}

/**
 * Notify all agents with registered devices about an escalation request.
 */
export async function notifyAgentsOfEscalation(
  db: Database,
  escalation: {
    conversationId: string;
    customerName?: string;
    subject?: string;
    reason?: string;
  },
  firebaseServiceAccount?: string
): Promise<void> {
  try {
    const devices = await getActiveDevices(db);
    if (devices.length === 0) return;

    console.log(`[Push] Sending escalation notification to ${devices.length} device(s)`);

    const body = escalation.customerName
      ? `${escalation.customerName} needs human assistance${escalation.subject ? `: ${escalation.subject}` : ''}`
      : escalation.reason || 'A customer needs human assistance';

    await sendPushToDevices(devices, {
      title: 'Human Agent Requested',
      body,
      data: {
        type: 'helpdesk',
        action: 'escalation',
        conversationId: escalation.conversationId,
      },
    }, firebaseServiceAccount);
  } catch (err) {
    console.error('[Push] Failed to notify agents of escalation:', err);
  }
}

/**
 * Notify all agents with registered devices about a new message.
 */
export async function notifyAgentsOfNewMessage(
  db: Database,
  message: {
    conversationId: string;
    senderName?: string;
    preview?: string;
  },
  firebaseServiceAccount?: string
): Promise<void> {
  try {
    const devices = await getActiveDevices(db);
    if (devices.length === 0) return;

    console.log(`[Push] Sending new message notification to ${devices.length} device(s)`);

    await sendPushToDevices(devices, {
      title: message.senderName || 'New Message',
      body: message.preview?.substring(0, 200) || 'New message received',
      data: {
        type: 'helpdesk',
        action: 'new_message',
        conversationId: message.conversationId,
      },
    }, firebaseServiceAccount);
  } catch (err) {
    console.error('[Push] Failed to notify agents of new message:', err);
  }
}
