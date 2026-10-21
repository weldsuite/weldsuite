/**
 * Parsing for the silent "email read" push.
 *
 * The server (`@weldsuite/mail-domain/read-push`) sends it when an email is
 * read, trashed or deleted anywhere else, so the app can take that email's
 * new-email banner out of the tray and update the badge. It is data-only and
 * never shown. Like the new-email payload it round-trips through Expo, FCM and
 * APNs, so every id is validated before it is used.
 */

import { parseId } from '@/utils/notification-target';

/** `data.type` the server sets; see `EMAIL_READ_PUSH_TYPE` server side. */
export const EMAIL_READ_PUSH_TYPE = 'email_read';

/** The server sends at most 40 ids per push; anything past this is junk. */
const MAX_IDS = 100;

export type InboxTenantKind = 'workspace' | 'personal';

export interface MailReadPush {
  emailIds: string[];
  tenantKind: InboxTenantKind;
  /** Unread inbox count of that tenancy after the change, when the server sent it. */
  inboxUnread?: number;
}

/** Last known unread inbox count per tenancy; the badge is their sum. */
export type InboxUnreadCounts = Partial<Record<InboxTenantKind, number>>;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

function parseJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

/** A non-negative integer from a push field (sent as a string), else undefined. */
export function parseCount(value: unknown): number | undefined {
  // Number('') is 0: an empty field must not zero the badge.
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
  return Number.isInteger(n) && n >= 0 && n < 1_000_000 ? n : undefined;
}

function parseTenantKind(value: unknown): InboxTenantKind {
  return value === 'personal' ? 'personal' : 'workspace';
}

/** Parse a `data` blob as an "email read" push; null for anything else. */
export function parseMailReadPush(data: unknown): MailReadPush | null {
  const record = asRecord(data);
  if (!record || record.type !== EMAIL_READ_PUSH_TYPE) return null;
  const raw = typeof record.emailIds === 'string' ? record.emailIds.split(',') : [];
  const emailIds = [
    ...new Set(raw.slice(0, MAX_IDS).map((id) => parseId(id.trim())).filter((id): id is string => !!id)),
  ];
  if (emailIds.length === 0) return null;
  return {
    emailIds,
    tenantKind: parseTenantKind(record.tenantKind),
    inboxUnread: parseCount(record.inboxUnread),
  };
}

/**
 * The places a background-task payload may hold the push `data`. Where Expo
 * puts it differs by platform and version: on `data` itself, as JSON in
 * `data.dataString`, or as `data.body` (an object on iOS, a JSON string on
 * Android). A tap (a NotificationResponse) has none: taps are handled by
 * NotificationContext.
 */
function payloadCandidates(taskPayload: unknown): unknown[] {
  const payload = asRecord(taskPayload);
  if (!payload || 'actionIdentifier' in payload) return [];
  const data = asRecord(payload.data);
  return [data, parseJson(data?.dataString), parseJson(data?.body), parseJson(payload.body)];
}

/** The "email read" push in a background-task payload, if it is one. */
export function findMailReadPush(taskPayload: unknown): MailReadPush | null {
  for (const candidate of payloadCandidates(taskPayload)) {
    const parsed = parseMailReadPush(candidate);
    if (parsed) return parsed;
  }
  return null;
}

/**
 * The tenancy count a new-email push carries (`inboxUnread`, `tenantKind`),
 * so the badge stays a sum of both inboxes when the app sees that push.
 */
export function findNewEmailCount(taskPayload: unknown): { tenantKind: InboxTenantKind; inboxUnread: number } | null {
  for (const candidate of payloadCandidates(taskPayload)) {
    const record = asRecord(candidate);
    if (record?.type !== 'new_email') continue;
    const inboxUnread = parseCount(record.inboxUnread);
    if (inboxUnread !== undefined) return { tenantKind: parseTenantKind(record.tenantKind), inboxUnread };
  }
  return null;
}

/** The email a presented new-email notification is about, if any. */
export function presentedEmailId(data: unknown): string | undefined {
  const record = asRecord(data);
  if (!record || record.type === EMAIL_READ_PUSH_TYPE) return undefined;
  return parseId(record.emailId);
}

/**
 * Whether a new-email banner no longer matches its email: read, trashed,
 * spammed or moved out of the inbox. Mirrors when the server sends the
 * "email read" push, for the tray check the app runs when it opens.
 */
export function bannerIsStale(message: {
  isRead?: boolean | null;
  isTrash?: boolean | null;
  isSpam?: boolean | null;
  labels?: string[] | null;
}): boolean {
  if (message.isRead || message.isTrash || message.isSpam) return true;
  const labels = message.labels ?? [];
  // A row without labels is a legacy inbox row, not an archived one.
  return labels.length > 0 && !labels.includes('INBOX');
}

/**
 * Badge for a set of per-tenancy counts. A user with only one inbox has only
 * that count, so a missing tenancy counts as zero.
 */
export function badgeFromCounts(counts: InboxUnreadCounts): number {
  return (counts.workspace ?? 0) + (counts.personal ?? 0);
}
