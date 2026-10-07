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
 */

import type { Context } from 'hono';
import { principalFromSession, type MailPrincipal } from '@weldsuite/mail-domain/access';
import type { schema } from '../db';
import type { HonoEnv } from '../types';

type MessageRow = typeof schema.mailMessages.$inferSelect;
type AttachmentRow = typeof schema.mailAttachments.$inferSelect;

export function mailPrincipal(c: Context<HonoEnv>): MailPrincipal {
  return principalFromSession(c.get('apiSession'));
}

/**
 * A message as the API returns it. Drops the raw RFC 822 source (large, and it
 * is the unsanitized original) and the provider bookkeeping columns.
 */
export function publicMessage(row: MessageRow) {
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
    ...rest
  } = row;
  return rest;
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

/** Thread lists page by offset; the cursor is that offset, opaque to callers. */
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
