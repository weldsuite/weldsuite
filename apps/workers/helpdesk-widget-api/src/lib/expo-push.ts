/**
 * Expo Push Notification HTTP client for Cloudflare Workers
 *
 * Lightweight wrapper around the Expo Push API.
 * Works in any runtime (Node.js, Cloudflare Workers, Edge).
 * Supports both ExponentPushToken and native device tokens (FCM/APNs).
 *
 * @see https://docs.expo.dev/push-notifications/sending-notifications/
 */

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
const EXPO_PROJECT_ID = '6c2b366b-5406-4174-bdb0-b75b1f886d65';
const MAX_PER_REQUEST = 100;

export interface ExpoPushMessage {
  to: string;
  title?: string;
  body?: string;
  data?: Record<string, string>;
  sound?: 'default' | null;
  badge?: number;
  channelId?: string;
  priority?: 'default' | 'normal' | 'high';
}

export interface ExpoPushTicket {
  status: 'ok' | 'error';
  id?: string;
  message?: string;
  details?: { error?: string };
}

export interface SendExpoPushResult {
  tickets: ExpoPushTicket[];
  invalidTokens: string[];
}

/**
 * Send push notifications via the Expo Push API.
 * Automatically chunks into batches of 100.
 */
export async function sendExpoPush(
  messages: ExpoPushMessage[],
  accessToken?: string
): Promise<SendExpoPushResult> {
  if (messages.length === 0) {
    return { tickets: [], invalidTokens: [] };
  }

  const allTickets: ExpoPushTicket[] = [];
  const invalidTokens: string[] = [];

  for (let i = 0; i < messages.length; i += MAX_PER_REQUEST) {
    const chunk = messages.slice(i, i + MAX_PER_REQUEST);

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'expo-project-id': EXPO_PROJECT_ID,
    };
    if (accessToken) {
      headers['Authorization'] = `Bearer ${accessToken}`;
    }

    const response = await fetch(EXPO_PUSH_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify(chunk),
    });

    if (!response.ok) {
      console.error(`[ExpoPush] API error: ${response.status} ${response.statusText}`);
      for (const msg of chunk) {
        allTickets.push({ status: 'error', message: `HTTP ${response.status}` });
      }
      continue;
    }

    const result = await response.json() as { data: ExpoPushTicket[] };
    const tickets = result.data;
    allTickets.push(...tickets);

    tickets.forEach((ticket, idx) => {
      if (ticket.status === 'error' && ticket.details?.error === 'DeviceNotRegistered') {
        invalidTokens.push(chunk[idx]?.to ?? '');
      }
    });
  }

  return { tickets: allTickets, invalidTokens };
}
