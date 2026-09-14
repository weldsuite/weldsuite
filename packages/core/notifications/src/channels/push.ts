/**
 * Expo Push HTTP client. Same behaviour as the original in
 * `apps/api-worker/src/lib/expo-push.ts` — works in any runtime, chunks
 * into batches of 100, surfaces invalid tokens for cleanup.
 *
 * IMPORTANT: Expo rejects an entire request with HTTP 400 when the batch
 * mixes tokens from different EAS projects (or includes non-Expo tokens).
 * Callers often collect `weldchat` + `weldsuite` (etc.) tokens together, so
 * we (a) drop non-Expo tokens, (b) on a multi-message 400 fall back to
 * per-message sends, and (c) always surface Expo's error body — never just
 * "HTTP 400".
 */

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
const MAX_PER_REQUEST = 100;

/** Expo push tokens only — raw FCM/APNs values make Expo return HTTP 400. */
const EXPO_PUSH_TOKEN_RE = /^(Exponent|Expo)PushToken\[.+\]$/;

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

export function isExpoPushToken(token: string): boolean {
  return EXPO_PUSH_TOKEN_RE.test(token);
}

/** Pull a human-readable reason out of Expo's non-2xx JSON/text body. */
export function formatExpoHttpError(status: number, bodyText: string): string {
  const trimmed = bodyText.trim();
  if (!trimmed) return `HTTP ${status}`;

  try {
    const parsed = JSON.parse(trimmed) as {
      errors?: Array<{ code?: string; message?: string }>;
      error?: string | { message?: string };
      message?: string;
    };
    const fromErrors = parsed.errors
      ?.map((e) => [e.code, e.message].filter(Boolean).join(': '))
      .filter(Boolean)
      .join('; ');
    if (fromErrors) return `HTTP ${status}: ${fromErrors}`;

    if (typeof parsed.error === 'string' && parsed.error) {
      return `HTTP ${status}: ${parsed.error}`;
    }
    if (parsed.error && typeof parsed.error === 'object' && parsed.error.message) {
      return `HTTP ${status}: ${parsed.error.message}`;
    }
    if (typeof parsed.message === 'string' && parsed.message) {
      return `HTTP ${status}: ${parsed.message}`;
    }
  } catch {
    // not JSON — fall through
  }

  return `HTTP ${status}: ${trimmed.slice(0, 300)}`;
}

async function postExpoChunk(
  chunk: ExpoPushMessage[],
  headers: Record<string, string>,
): Promise<ExpoPushTicket[]> {
  const response = await fetch(EXPO_PUSH_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify(chunk),
  });

  if (response.ok) {
    const result = (await response.json()) as { data: ExpoPushTicket[] };
    return result.data;
  }

  const bodyText = await response.text().catch(() => '');
  const message = formatExpoHttpError(response.status, bodyText);
  console.error(`[ExpoPush] API error: ${message}`);

  // Mixed EAS projects (or one bad token) fail the whole batch with 400.
  // Retry one-by-one so valid tokens in the same chunk still deliver.
  if (chunk.length > 1 && (response.status === 400 || response.status === 403)) {
    console.warn(
      `[ExpoPush] Retrying ${chunk.length} messages individually after batch ${response.status}`,
    );
    const tickets: ExpoPushTicket[] = [];
    for (const messageItem of chunk) {
      tickets.push(...(await postExpoChunk([messageItem], headers)));
    }
    return tickets;
  }

  return chunk.map(() => ({ status: 'error' as const, message }));
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
  const eligible: ExpoPushMessage[] = [];

  for (const message of messages) {
    if (!message.to || !isExpoPushToken(message.to)) {
      console.warn(
        `[ExpoPush] Skipping non-Expo push token (…${(message.to ?? '').slice(-12)}): Expo would reject the whole batch with HTTP 400`,
      );
      allTickets.push({
        status: 'error',
        message:
          'Not an Expo push token (ExponentPushToken[…]). Re-open the app to re-register.',
        details: { error: 'InvalidCredentials' },
      });
      if (message.to) invalidTokens.push(message.to);
      continue;
    }
    eligible.push(message);
  }

  if (eligible.length === 0) {
    return { tickets: allTickets, invalidTokens };
  }

  // NOTE: no `expo-project-id` header. This package serves multiple apps
  // (weldchat / weldmail / weldsuite …) whose Expo push tokens belong to
  // different EAS projects, so a single pinned project id would mismatch most
  // tokens and — with Expo project-ownership enforcement — get them rejected.
  // Expo routes by the token itself; the header is not required. Batches that
  // mix projects are split via the per-message retry in postExpoChunk.
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
  if (accessToken) {
    headers['Authorization'] = `Bearer ${accessToken}`;
  }

  for (let i = 0; i < eligible.length; i += MAX_PER_REQUEST) {
    const chunk = eligible.slice(i, i + MAX_PER_REQUEST);
    const tickets = await postExpoChunk(chunk, headers);
    allTickets.push(...tickets);

    tickets.forEach((ticket, idx) => {
      if (ticket.status === 'error' && ticket.details?.error === 'DeviceNotRegistered') {
        invalidTokens.push(chunk[idx]?.to ?? '');
      }
    });
  }

  return { tickets: allTickets, invalidTokens };
}
