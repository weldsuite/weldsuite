/**
 * Shared pieces of the v1 mail routes.
 *
 * Kept identical to mcp-server's copy (`src/api/lib/mail.ts`), like the route
 * files that use it, so the two surfaces can be diffed when routes change.
 *
 * Every mail route resolves a {@link MailPrincipal} from the session before it
 * touches a mailbox. A personal key or an MCP user acts as that person and gets
 * exactly the mailboxes they can open in WeldMail. A workspace key or a WeldApp
 * token has no person behind it and acts as the workspace: shared mailboxes
 * only. A mailbox outside the principal's reach answers 404, never 403, so a
 * key cannot probe which private mailboxes exist.
 *
 * Reads and organize ops go through `getWorkspaceMail` (design
 * docs/plans/weldmail-mailbox-store-design.md, task D5) via
 * `./mail-store-context`'s `workspaceMailFromContext`, so the shapes below also
 * cover the store's row types (`MailMessageRecord`/`MailMessageListRow`), which
 * carry a `threadKey` field `mail_messages` itself never had — stripped here so
 * the public wire shape is unaffected by which mode served the request.
 */

import type { Context } from 'hono';
import { principalFromSession, type MailPrincipal } from '@weldsuite/mail-domain/access';
import type { MailMessageListRow, MailMessageRecord } from '@weldsuite/mail-domain/store';
import {
  decodeMessageCursor,
  decodeThreadCursor,
  encodeMessageCursor,
  encodeThreadCursor,
} from '@weldsuite/mail-domain/store/cursor';
import type { schema } from '../db';
import type { HonoEnv } from '../types';

type MessageRow = typeof schema.mailMessages.$inferSelect;
type AttachmentRow = typeof schema.mailAttachments.$inferSelect;

/** Either backend's row shape for one message, plus the store's `threadKey`. */
type AnyMessageRow = (MessageRow | MailMessageRecord) & { threadKey?: string };

export { encodeMessageCursor, decodeMessageCursor, encodeThreadCursor, decodeThreadCursor };

export function mailPrincipal(c: Context<HonoEnv>): MailPrincipal {
  return principalFromSession(c.get('apiSession'));
}

/**
 * A message as the API returns it. Drops the raw RFC 822 source (large, and it
 * is the unsanitized original), the provider bookkeeping columns, and (when
 * the row came from the mailbox store) its internal `threadKey`.
 */
export function publicMessage(row: MessageRow | MailMessageRecord) {
  const {
    rawMessage: _raw,
    headers: _headers,
    triggerRunId: _trigger,
    unsnoozeTriggerRunId: _unsnooze,
    mailgunMessageId: _mailgun,
    mailcowMessageId: _mailcow,
    providerMessageId: _provider,
    sendProvider: _sendProvider,
    idempotencyKey: _idempotency,
    customFields: _custom,
    deletedAt: _deleted,
    threadKey: _threadKey,
    ...rest
  } = row as AnyMessageRow;
  return rest;
}

/**
 * A list row as the API returns it: the same narrow column set the legacy
 * `listMessages`/`listThreadsByLabel` queries always selected (no body, no raw
 * MIME, no provider bookkeeping) — picked explicitly from the store's wider
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
 * `o:<offset>` is still decoded"); `mail-threads` now mints
 * `encodeThreadCursor` (above) for new pages, which works in every mailbox
 * store mode, not just `postgres`/`shadow`.
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
