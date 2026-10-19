/**
 * The R2 key and `mail_attachments` row for one inbound attachment of a
 * workspace mailbox. Pure, so it can be tested without R2 or a database.
 *
 * No `downloadUrl` (TASK-905): the bucket's public URL serves a file to anyone
 * holding the link, so it is never stored. The bytes are read through
 * mail-api, which checks the mailbox (`/api/mail-attachments/:id/download`),
 * and inline images through short-lived URLs mail-api mints when the message
 * is read, found by the `contentId` kept here. The stored HTML keeps its
 * `cid:` references for that.
 */

export interface InboundAttachmentInput {
  fileName: string;
  contentType?: string;
  content: Uint8Array;
  contentId?: string;
  disposition?: string;
}

export interface InboundAttachmentRecord {
  r2Key: string;
  contentType: string;
  row: {
    id: string;
    messageId: string;
    fileName: string;
    contentType: string;
    size: number;
    storagePath: string;
    isInline: boolean;
    contentId: string | null;
  };
}

/** `<image001.png@01D>` → `image001.png@01D`; null when there is none. */
export function bareContentId(contentId: string | undefined): string | null {
  const bare = (contentId ?? '').trim().replace(/^</, '').replace(/>$/, '').trim();
  return bare ? bare.slice(0, 255) : null;
}

export function inboundAttachmentRecord(
  workspaceId: string,
  messageId: string,
  index: number,
  attachment: InboundAttachmentInput,
  id: string,
): InboundAttachmentRecord {
  const contentType = attachment.contentType || 'application/octet-stream';
  // workspaces/{workspaceId}/mail/attachments/{messageId}/{n}_{filename}
  const sanitizedName = attachment.fileName.replaceAll(/[^a-zA-Z0-9._-]/g, '_');
  const r2Key = `workspaces/${workspaceId}/mail/attachments/${messageId}/${index + 1}_${sanitizedName}`;
  return {
    r2Key,
    contentType,
    row: {
      id,
      messageId,
      fileName: attachment.fileName,
      contentType,
      size: attachment.content.length,
      storagePath: r2Key,
      isInline: attachment.disposition === 'inline',
      contentId: bareContentId(attachment.contentId),
    },
  };
}
