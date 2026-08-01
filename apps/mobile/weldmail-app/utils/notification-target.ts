/**
 * Parsing for WeldMail push-notification payloads.
 *
 * The payload round-trips through Expo's push service before it reaches the
 * device, so every id is validated against the `generateId()` shape before it
 * is interpolated into a route path (path injection) or matched against the
 * account list.
 */

/** Shape of a `generateId()` id — see `packages/core/db` `lib/id`. */
const ID_PATTERN = /^[A-Za-z0-9_-]{1,40}$/;

export interface NotificationTarget {
  /** Message to open. Absent when the payload carries no usable message id. */
  emailId?: string;
  /** Mail account the message belongs to, so the mailbox can follow it. */
  accountId?: string;
}

/**
 * Turn the `data` blob of a notification into a navigation target, dropping any
 * id that doesn't look like one of ours. Returns null when there is nothing
 * usable to act on.
 */
export function parseNotificationTarget(data: unknown): NotificationTarget | null {
  if (!data || typeof data !== 'object') return null;
  const record = data as Record<string, unknown>;

  const rawEmailId = record.emailId;
  const rawAccountId = record.emailAccountId;

  const emailId =
    typeof rawEmailId === 'string' && ID_PATTERN.test(rawEmailId) ? rawEmailId : undefined;
  const accountId =
    typeof rawAccountId === 'string' && ID_PATTERN.test(rawAccountId) ? rawAccountId : undefined;

  if (!emailId && !accountId) return null;
  return { emailId, accountId };
}
