import type { MailMessageRow } from '@weldsuite/app-api-client/domains/mail-messages';

/**
 * A mail message as rendered in the inbox / search lists.
 *
 * Extends the app-api `MailMessageRow` (the wire shape returned by
 * `appApi.mailMessages.list`) with the handful of UI-only fields the list
 * screens synthesise or fall back to. Typing list items with this instead of
 * `any` is what catches field-name typos — e.g. `hasAttachment` (singular)
 * vs the API's `hasAttachments` — at compile time.
 */
export interface EmailListItem extends MailMessageRow {
  /** Messages in the thread; drives the thread-count badge (added client-side). */
  threadCount?: number;
  /** Unread messages within the thread. */
  unreadCount?: number;
  /** Legacy fallback for `from.name` on some payloads. */
  fromName?: string | null;
  /** Legacy fallback for `preview`. */
  snippet?: string | null;
}
