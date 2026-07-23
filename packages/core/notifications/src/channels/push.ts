/**
 * Expo Push HTTP client. Same behaviour as the original in
 * `apps/api-worker/src/lib/expo-push.ts` — works in any runtime, chunks
 * into batches of 100, surfaces invalid tokens for cleanup.
 */

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
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

export async function sendExpoPush(
  messages: ExpoPushMessage[],
  accessToken?: string,
): Promise<SendExpoPushResult> {
  if (messages.length === 0) {
    return { tickets: [], invalidTokens: [] };
  }

  const allTickets: ExpoPushTicket[] = [];
  const invalidTokens: string[] = [];

  for (let i = 0; i < messages.length; i += MAX_PER_REQUEST) {
    const chunk = messages.slice(i, i + MAX_PER_REQUEST);

    // NOTE: no `expo-project-id` header. This package serves multiple apps
    // (weldchat / weldmail / weldsuite …) whose Expo push tokens belong to
    // different EAS projects, so a single pinned project id would mismatch most
    // tokens and — with Expo project-ownership enforcement — get them rejected.
    // Expo routes by the token itself; the header is not required.
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
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
      for (const _ of chunk) {
        allTickets.push({ status: 'error', message: `HTTP ${response.status}` });
      }
      continue;
    }

    const result = (await response.json()) as { data: ExpoPushTicket[] };
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
