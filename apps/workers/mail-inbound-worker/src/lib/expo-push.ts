/**
 * Expo Push Notification HTTP client for Cloudflare Workers
 *
 * Lightweight wrapper around the Expo Push API.
 * Works in any runtime (Node.js, Cloudflare Workers, Edge).
 *
 * @see https://docs.expo.dev/push-notifications/sending-notifications/
 */

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
const EXPO_RECEIPTS_URL = 'https://exp.host/--/api/v2/push/getReceipts';
const MAX_PER_REQUEST = 100;
const MAX_RECEIPTS_PER_REQUEST = 1000;
const MAX_RETRY_ATTEMPTS = 3;
const BASE_RETRY_DELAY_MS = 500;

/**
 * Known EAS project IDs per WeldSuite app.
 * Pass the appropriate one when calling sendExpoPush() so the
 * expo-project-id header targets the correct FCM/APNs credentials.
 */
export const EXPO_PROJECT_IDS = {
  weldsuite: '6c2b366b-5406-4174-bdb0-b75b1f886d65',
  weldmail: '07f1af16-fb8b-4a5d-95c1-0b8554016309',
} as const;

export type ExpoAppKey = keyof typeof EXPO_PROJECT_IDS;

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

export interface ExpoPushReceipt {
  status: 'ok' | 'error';
  message?: string;
  details?: { error?: string };
}

export interface SendExpoPushOptions {
  /** Expo access token for enhanced delivery. Optional. */
  accessToken?: string;
  /**
   * The `expo-project-id` header value. Determines which FCM/APNs
   * credentials Expo uses. Defaults to the weldsuite project ID for
   * backward compatibility — pass the correct app-specific ID instead.
   */
  projectId?: string;
}

export interface SendExpoPushResult {
  tickets: ExpoPushTicket[];
  invalidTokens: string[];
  /** Receipt IDs from ok tickets — pass to checkExpoPushReceipts() later. */
  receiptIds: string[];
}

/**
 * Sleep for `ms` milliseconds (capped to keep within Worker CPU limits).
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Parse the Retry-After header value (seconds or HTTP-date) into milliseconds.
 * Falls back to `defaultMs` if the header is absent or unparseable.
 */
function parseRetryAfterMs(header: string | null, defaultMs: number): number {
  if (!header) return defaultMs;
  const seconds = Number(header);
  if (!Number.isNaN(seconds) && seconds > 0) return seconds * 1000;
  const date = Date.parse(header);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return defaultMs;
}

/**
 * POST a single chunk to the Expo Push API with exponential backoff retry
 * on transient HTTP failures (429 / 5xx).
 */
async function sendChunkWithRetry(
  chunk: ExpoPushMessage[],
  headers: Record<string, string>,
): Promise<ExpoPushTicket[]> {
  let attempt = 0;

  while (attempt < MAX_RETRY_ATTEMPTS) {
    const response = await fetch(EXPO_PUSH_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify(chunk),
    });

    if (response.ok) {
      const result = (await response.json()) as { data: ExpoPushTicket[] };
      return result.data;
    }

    const isRetryable = response.status === 429 || response.status >= 500;

    if (!isRetryable || attempt === MAX_RETRY_ATTEMPTS - 1) {
      console.error(
        `[ExpoPush] API error (attempt ${attempt + 1}/${MAX_RETRY_ATTEMPTS}): ${response.status} ${response.statusText}`,
      );
      // Return synthetic error tickets so callers always get a full-length array.
      return chunk.map(() => ({
        status: 'error' as const,
        message: `HTTP ${response.status}`,
      }));
    }

    const delayMs = parseRetryAfterMs(
      response.headers.get('Retry-After'),
      BASE_RETRY_DELAY_MS * 2 ** attempt,
    );
    console.warn(
      `[ExpoPush] Transient error ${response.status}, retrying in ${delayMs}ms (attempt ${attempt + 1}/${MAX_RETRY_ATTEMPTS})`,
    );
    await sleep(delayMs);
    attempt++;
  }

  // Unreachable — the loop always returns inside, but TypeScript needs this.
  return chunk.map(() => ({ status: 'error' as const, message: 'Max retries exceeded' }));
}

/**
 * Send push notifications via the Expo Push API.
 * Automatically chunks into batches of 100 and retries transient failures.
 *
 * @param messages - List of push messages to send.
 * @param optsOrAccessToken - Options object (preferred) or legacy bare access
 *   token string (kept for backward compatibility).
 */
export async function sendExpoPush(
  messages: ExpoPushMessage[],
  optsOrAccessToken?: SendExpoPushOptions | string,
): Promise<SendExpoPushResult> {
  if (messages.length === 0) {
    return { tickets: [], invalidTokens: [], receiptIds: [] };
  }

  // Normalise the second argument — legacy callers pass a bare string.
  const opts: SendExpoPushOptions =
    typeof optsOrAccessToken === 'string'
      ? { accessToken: optsOrAccessToken }
      : (optsOrAccessToken ?? {});

  const projectId = opts.projectId ?? EXPO_PROJECT_IDS.weldsuite;
  const accessToken = opts.accessToken;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'expo-project-id': projectId,
  };
  if (accessToken) {
    headers['Authorization'] = `Bearer ${accessToken}`;
  }

  const allTickets: ExpoPushTicket[] = [];
  const invalidTokens: string[] = [];
  const receiptIds: string[] = [];

  for (let i = 0; i < messages.length; i += MAX_PER_REQUEST) {
    const chunk = messages.slice(i, i + MAX_PER_REQUEST);
    const tickets = await sendChunkWithRetry(chunk, headers);

    allTickets.push(...tickets);

    tickets.forEach((ticket, idx) => {
      if (ticket.status === 'ok' && ticket.id) {
        receiptIds.push(ticket.id);
      }
      if (ticket.status === 'error') {
        const errorCode = ticket.details?.error;
        if (errorCode === 'DeviceNotRegistered') {
          invalidTokens.push(chunk[idx]?.to ?? '');
        }
      }
    });
  }

  return { tickets: allTickets, invalidTokens, receiptIds };
}

/**
 * Poll the Expo receipts endpoint for delivery confirmations.
 *
 * Expo recommends waiting ~15 minutes after sending before checking receipts.
 * This function is intended to be called from a scheduled cron handler or a
 * queue consumer — not inline in the send path.
 *
 * @see https://docs.expo.dev/push-notifications/sending-notifications/#receipt-format
 *
 * @param receiptIds - IDs returned in ok tickets from sendExpoPush().
 * @param accessToken - Optional Expo access token.
 * @returns Map of receiptId -> receipt object.
 */
export async function checkExpoPushReceipts(
  receiptIds: string[],
  accessToken?: string,
): Promise<Map<string, ExpoPushReceipt>> {
  const result = new Map<string, ExpoPushReceipt>();

  if (receiptIds.length === 0) return result;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
  if (accessToken) {
    headers['Authorization'] = `Bearer ${accessToken}`;
  }

  for (let i = 0; i < receiptIds.length; i += MAX_RECEIPTS_PER_REQUEST) {
    const ids = receiptIds.slice(i, i + MAX_RECEIPTS_PER_REQUEST);

    let attempt = 0;
    while (attempt < MAX_RETRY_ATTEMPTS) {
      const response = await fetch(EXPO_RECEIPTS_URL, {
        method: 'POST',
        headers,
        body: JSON.stringify({ ids }),
      });

      if (response.ok) {
        const body = (await response.json()) as { data: Record<string, ExpoPushReceipt> };
        for (const [id, receipt] of Object.entries(body.data)) {
          result.set(id, receipt);
        }
        break;
      }

      const isRetryable = response.status === 429 || response.status >= 500;
      if (!isRetryable || attempt === MAX_RETRY_ATTEMPTS - 1) {
        console.error(
          `[ExpoPush] Receipts API error (attempt ${attempt + 1}/${MAX_RETRY_ATTEMPTS}): ${response.status} ${response.statusText}`,
        );
        break;
      }

      const delayMs = parseRetryAfterMs(
        response.headers.get('Retry-After'),
        BASE_RETRY_DELAY_MS * 2 ** attempt,
      );
      console.warn(
        `[ExpoPush] Receipts transient error ${response.status}, retrying in ${delayMs}ms`,
      );
      await sleep(delayMs);
      attempt++;
    }
  }

  return result;
}
