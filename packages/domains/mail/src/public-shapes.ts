/**
 * Mail as the public surfaces return it: the public API (external-api's
 * `/v1/mail-*`) and the MCP server's copy of those routes. One definition for
 * both, so the wire shapes cannot drift; each worker's `lib/mail.ts`
 * re-exports these beside its own `mailPrincipal`.
 *
 * Reads go through `getWorkspaceMail` (design
 * weldsuite-documentation/plans/weldmail-mailbox-store-design.md, task D5), so
 * the shapes below also cover the store's row types (`MailMessageRecord`,
 * `MailMessageListRow`), which carry a `threadKey` field `mail_messages`
 * itself never had: stripped here, so the public wire shape does not depend
 * on which mode served the request.
 */

import type { MailMessage } from '@weldsuite/db/schema/mail-messages';
import type { schema } from '@weldsuite/worker-kit/db';
import type { MailMessageListRow, MailMessageRecord } from './store';

export { decodeMessageCursor, decodeThreadCursor, encodeMessageCursor, encodeThreadCursor } from './store/cursor';

type AttachmentRow = typeof schema.mailAttachments.$inferSelect;

/**
 * Either backend's row shape for one message, plus the store's `threadKey` and
 * the raw attachment rows `getMessage` puts on it in `postgres` mode.
 */
type AnyMessageRow = (MailMessage | MailMessageRecord) & { threadKey?: string; attachments?: unknown };

/** `obj` without `keys`: an explicit drop instead of destructuring into unused `_name` bindings. */
function omit<T extends object, K extends keyof T>(obj: T, keys: readonly K[]): Omit<T, K> {
  const copy = { ...obj };
  for (const key of keys) delete copy[key];
  return copy;
}

/**
 * A message as the API returns it. Drops the raw RFC 822 source (large, and it
 * is the unsanitized original), the provider bookkeeping columns, (when the
 * row came from the mailbox store) its internal `threadKey`, and the raw
 * attachment rows, which carry storage paths: a route that answers with a
 * message's files adds them through {@link publicAttachment}.
 */
export function publicMessage(row: MailMessage | MailMessageRecord) {
  return omit(row as AnyMessageRow, [
    'attachments',
    'rawMessage',
    'headers',
    'triggerRunId',
    'unsnoozeTriggerRunId',
    'mailgunMessageId',
    'mailcowMessageId',
    'providerMessageId',
    'sendProvider',
    'idempotencyKey',
    'customFields',
    'deletedAt',
    'threadKey',
  ]);
}

/**
 * A list row as the API returns it: the same narrow column set the legacy
 * `listMessages`/`listThreadsByLabel` queries always selected (no body, no raw
 * MIME, no provider bookkeeping), picked explicitly from the store's wider
 * `MailMessageListRow` (which, being `Omit<MailMessage, 'textBody' |
 * 'htmlBody' | 'rawMessage' | 'headers' | 'customFields' | 'clickedLinks'>`,
 * carries many columns this surface has never exposed) so switching a list
 * endpoint onto the store never widens its public response.
 */
export function publicListMessage(row: MailMessageListRow) {
  const {
    id,
    accountId,
    messageId,
    threadId,
    from,
    to,
    cc,
    subject,
    preview,
    sentDate,
    receivedDate,
    isRead,
    isStarred,
    isFlagged,
    isImportant,
    isDraft,
    hasAttachments,
    attachmentCount,
    priority,
    labels,
    sizeBytes,
    scheduledFor,
    sendStatus,
    createdAt,
  } = row;
  return {
    id,
    accountId,
    messageId,
    threadId,
    from,
    to,
    cc,
    subject,
    preview,
    sentDate,
    receivedDate,
    isRead,
    isStarred,
    isFlagged,
    isImportant,
    isDraft,
    hasAttachments,
    attachmentCount,
    priority,
    labels,
    sizeBytes,
    scheduledFor,
    sendStatus,
    createdAt,
  };
}

/** An attachment's metadata. Never the storage path or a download URL. */
export function publicAttachment(row: AttachmentRow) {
  return {
    id: row.id,
    messageId: row.messageId,
    fileName: row.fileName,
    contentType: row.contentType,
    size: row.size,
    isInline: row.isInline,
    contentId: row.contentId,
    createdAt: row.createdAt,
  };
}

/**
 * Thread lists page by offset; the cursor is that offset, opaque to callers.
 *
 * Still decoded for a cursor a client already holds (design §5: "legacy
 * `o:<offset>` is still decoded"); `mail-threads` mints `encodeThreadCursor`
 * for new pages, which works in every mailbox store mode.
 */
export function encodeOffsetCursor(offset: number): string {
  return btoa(`o:${offset}`).replace(/=+$/, '');
}

export function decodeOffsetCursor(cursor: string | undefined): number | null {
  if (!cursor) return 0;
  try {
    const match = /^o:(\d{1,9})$/.exec(atob(cursor));
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

/** `"true"` / `"false"` query flags. */
export function parseBoolFlag(value: string | undefined): boolean | undefined {
  if (value === 'true') return true;
  if (value === 'false') return false;
  return undefined;
}
