/**
 * Parsing for WeldMail push-notification payloads.
 *
 * The payload round-trips through Expo's push service before it reaches the
 * device, so every id is validated against the `generateId()` shape before it
 * is interpolated into a route path (path injection) or matched against the
 * account list. Preview strings are truncated so they fit in both the FCM
 * data blob and expo-router search params.
 */

/** Shape of a `generateId()` id — see `packages/core/db` `lib/id`. */
const ID_PATTERN = /^[A-Za-z0-9_-]{1,40}$/;

const FROM_TITLE = /^New email from (.+)$/;
const NAME_MAX = 80;
const SUBJECT_MAX = 120;
const PREVIEW_MAX = 160;

export interface NotificationTarget {
  /** Message to open. Absent when the payload carries no usable message id. */
  emailId?: string;
  /** Mail account the message belongs to, so the mailbox can follow it. */
  accountId?: string;
  /** Sender display name — paints the detail chrome before the body loads. */
  fromName?: string;
  fromEmail?: string;
  subject?: string;
  preview?: string;
}

/** Route params for `/[id]` when opening from a notification. */
export interface EmailOpenParams {
  id: string;
  fromName?: string;
  fromEmail?: string;
  subject?: string;
  preview?: string;
  fromNotification?: '1';
}

/**
 * Clip an untrusted string from a push payload. Drops non-strings, strips
 * control chars, and caps length so we never stuff a huge blob into a route.
 */
export function clipPreviewString(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.replace(/[\u0000-\u001F\u007F]/g, ' ').trim();
  if (!trimmed) return undefined;
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

function parseId(value: unknown): string | undefined {
  return typeof value === 'string' && ID_PATTERN.test(value) ? value : undefined;
}

/**
 * Turn the `data` blob of a notification into a navigation target, dropping any
 * id that doesn't look like one of ours. Returns null when there is nothing
 * usable to act on.
 */
export function parseNotificationTarget(data: unknown): NotificationTarget | null {
  if (!data || typeof data !== 'object') return null;
  const record = data as Record<string, unknown>;

  const emailId = parseId(record.emailId);
  const accountId = parseId(record.emailAccountId);

  if (!emailId && !accountId) return null;

  return {
    emailId,
    accountId,
    fromName: clipPreviewString(record.fromName, NAME_MAX),
    fromEmail: clipPreviewString(record.fromEmail, SUBJECT_MAX),
    subject: clipPreviewString(record.subject, SUBJECT_MAX),
    preview: clipPreviewString(record.preview, PREVIEW_MAX),
  };
}

export interface NotificationContent {
  data?: unknown;
  title?: string | null;
  body?: string | null;
}

/**
 * Parse a tap, filling in from/subject from the visible title/body when the
 * data blob doesn't carry them (older payloads, or a clipped FCM data field).
 */
export function parseNotificationContent(content: NotificationContent): NotificationTarget | null {
  const target = parseNotificationTarget(content.data);
  if (!target) return null;

  if (!target.fromName && typeof content.title === 'string') {
    const match = FROM_TITLE.exec(content.title.trim());
    if (match?.[1]) target.fromName = clipPreviewString(match[1], NAME_MAX);
  }
  if (!target.subject && typeof content.body === 'string') {
    target.subject = clipPreviewString(content.body, SUBJECT_MAX);
  }
  return target;
}

/** Params for `router.push` / `replace` onto the email screen. */
export function emailOpenParams(target: NotificationTarget): EmailOpenParams | null {
  if (!target.emailId) return null;
  const params: EmailOpenParams = { id: target.emailId, fromNotification: '1' };
  if (target.fromName) params.fromName = target.fromName;
  if (target.fromEmail) params.fromEmail = target.fromEmail;
  if (target.subject) params.subject = target.subject;
  if (target.preview) params.preview = target.preview;
  return params;
}

/**
 * A minimal message object so the detail chrome (subject, sender, preview)
 * can paint before `mailMessages.get` returns. Gmail/Outlook do the same
 * with the notification payload.
 */
export function stubEmailFromTarget(
  emailId: string,
  preview: Pick<NotificationTarget, 'fromName' | 'fromEmail' | 'subject' | 'preview'>,
): Record<string, unknown> | null {
  if (!preview.fromName && !preview.fromEmail && !preview.subject && !preview.preview) {
    return null;
  }
  const fromName = preview.fromName || preview.fromEmail || '';
  return {
    id: emailId,
    from: { name: fromName, email: preview.fromEmail || '' },
    fromName,
    fromEmail: preview.fromEmail || '',
    subject: preview.subject || '',
    preview: preview.preview || '',
    snippet: preview.preview || '',
    body: preview.preview || '',
    isRead: false,
    _fromNotification: true,
  };
}

/** expo-router may pass a param as `string | string[]`. */
export function firstParam(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw && raw.length > 0 ? raw : undefined;
}

/**
 * Backoff (ms) used when a notification tap opens the app before the new
 * message has shown up in the inbox list. First fetch is immediate (via
 * refreshMail); these delays cover a couple of follow-up tries.
 */
export const NOTIFICATION_LIST_RETRY_DELAYS_MS = [400, 1000, 2000] as const;

/** Delay for the next inbox re-fetch, or null once retries are exhausted. */
export function nextNotificationListRetryMs(attempt: number): number | null {
  return NOTIFICATION_LIST_RETRY_DELAYS_MS[attempt] ?? null;
}

/** Whether the inbox page we just loaded already contains this message. */
export function listContainsEmailId(
  messages: ReadonlyArray<{ id: string }>,
  emailId: string,
): boolean {
  return messages.some((m) => m.id === emailId);
}
