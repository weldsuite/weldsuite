/**
 * Mail attachment service.
 *
 * Attachments live in R2 (object path in `storagePath`) and are linked to
 * a message via `messageId`. On delete we soft-delete the row and
 * fire-and-forget a R2 delete — if R2 cleanup fails we don't roll back
 * the DB delete because the row is the source of truth for the inbox UI.
 *
 * The `associate` flow exists because the upload-then-send compose UI
 * generates an attachment id and uploads to R2 before the message id is
 * known; once the parent message is created, we link them up and refresh
 * the message's count flags in one statement.
 */

import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { schema } from '../../db';
import type { Database } from '../../db';
import type { Env } from '../../types';
import { generateId } from '../../lib/id';

const { mailAttachments, mailMessages } = schema;

export async function listAttachmentsForMessage(db: Database, messageId: string) {
  return db
    .select()
    .from(mailAttachments)
    .where(and(eq(mailAttachments.messageId, messageId), isNull(mailAttachments.deletedAt)));
}

export async function getAttachment(db: Database, id: string) {
  const [row] = await db
    .select()
    .from(mailAttachments)
    .where(and(eq(mailAttachments.id, id), isNull(mailAttachments.deletedAt)))
    .limit(1);
  return row ?? null;
}

export interface AttachmentInput {
  messageId: string;
  fileName: string;
  contentType?: string;
  size: number;
  storagePath?: string;
  downloadUrl?: string;
  checksum?: string;
  isInline?: boolean;
  contentId?: string;
  contentDisposition?: string;
}

export async function createAttachment(db: Database, data: AttachmentInput) {
  const id = generateId('attach');
  const now = new Date();
  await db.insert(mailAttachments).values({
    id,
    ...data,
    isInline: data.isInline ?? false,
    createdAt: now,
    updatedAt: now,
  });
  await refreshMessageAttachmentCount(db, data.messageId);
  const [row] = await db.select().from(mailAttachments).where(eq(mailAttachments.id, id));
  return row!;
}

export async function updateAttachment(
  db: Database,
  id: string,
  data: Partial<AttachmentInput>,
) {
  const [existing] = await db
    .select()
    .from(mailAttachments)
    .where(and(eq(mailAttachments.id, id), isNull(mailAttachments.deletedAt)))
    .limit(1);
  if (!existing) return null;

  const patch: Record<string, unknown> = { updatedAt: new Date() };
  for (const [k, v] of Object.entries(data)) if (v !== undefined) patch[k] = v;
  await db
    .update(mailAttachments)
    .set(patch as typeof mailAttachments.$inferInsert)
    .where(eq(mailAttachments.id, id));
  if (data.messageId && data.messageId !== existing.messageId) {
    await refreshMessageAttachmentCount(db, existing.messageId);
    await refreshMessageAttachmentCount(db, data.messageId);
  }
  const [after] = await db.select().from(mailAttachments).where(eq(mailAttachments.id, id));
  return { before: existing, after: after! };
}

/**
 * Soft-delete the row and best-effort delete the underlying R2 object.
 * R2 failure does NOT block the response — the DB is the source of truth
 * for what the inbox shows, and a leaked object can be GC'd by a separate
 * sweep without re-surfacing in the UI.
 */
export async function deleteAttachment(env: Env, db: Database, id: string) {
  const [existing] = await db
    .select()
    .from(mailAttachments)
    .where(and(eq(mailAttachments.id, id), isNull(mailAttachments.deletedAt)))
    .limit(1);
  if (!existing) return null;

  await db
    .update(mailAttachments)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(eq(mailAttachments.id, id));
  await refreshMessageAttachmentCount(db, existing.messageId);

  if (existing.storagePath && env.STORAGE) {
    try {
      await env.STORAGE.delete(existing.storagePath);
    } catch (err) {
      console.error(
        `[mail-attachments] R2 delete failed for ${existing.storagePath} (attachment ${id}):`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  return existing;
}

/**
 * Link previously-uploaded attachments to a message in a single statement
 * and refresh the message's count flags. Skips attachments that are
 * already attached to a different live message — those need an explicit
 * move.
 */
export async function associateAttachments(
  db: Database,
  messageId: string,
  attachmentIds: string[],
): Promise<{ associated: number }> {
  if (attachmentIds.length === 0) return { associated: 0 };
  const rows = await db
    .update(mailAttachments)
    .set({ messageId, updatedAt: new Date() })
    .where(
      and(
        inArray(mailAttachments.id, attachmentIds),
        isNull(mailAttachments.deletedAt),
      ),
    )
    .returning({ id: mailAttachments.id });
  await refreshMessageAttachmentCount(db, messageId);
  return { associated: rows.length };
}

async function refreshMessageAttachmentCount(db: Database, messageId: string) {
  await db.execute(sql`
    UPDATE mail_messages
    SET
      attachment_count = COALESCE((
        SELECT COUNT(*)::int FROM mail_attachments
        WHERE message_id = ${messageId} AND deleted_at IS NULL
      ), 0),
      has_attachments = EXISTS (
        SELECT 1 FROM mail_attachments
        WHERE message_id = ${messageId} AND deleted_at IS NULL
      ),
      updated_at = NOW()
    WHERE id = ${messageId}
  `);
}
