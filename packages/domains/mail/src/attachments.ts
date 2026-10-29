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
import { schema } from '@weldsuite/worker-kit/db';
import type { Database } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import { deleteStoredObject } from '@weldsuite/worker-kit/storage';

const { mailAttachments } = schema;

/**
 * A mail attachment as an API returns it. `storagePath` and `downloadUrl` are
 * left out: the bucket's public URL serves a file to anyone holding the link,
 * with no session, signature or expiry, so a mail API never hands it out. The
 * bytes come from the mailbox-checked `GET /api/mail-attachments/:id/download`.
 */
export type PublicMailAttachment = Omit<typeof mailAttachments.$inferSelect, 'storagePath' | 'downloadUrl'>;

export function toPublicAttachment<T extends { storagePath?: unknown; downloadUrl?: unknown }>(
  row: T,
): Omit<T, 'storagePath' | 'downloadUrl'> {
  const rest: Partial<T> = { ...row };
  delete rest.storagePath;
  delete rest.downloadUrl;
  return rest as Omit<T, 'storagePath' | 'downloadUrl'>;
}

/**
 * True when an object key sits under this workspace's folder. A row's
 * `storagePath` is only ever read back through this check: a caller-supplied
 * key must not reach into another workspace's files.
 *
 * A workspace has two folders: compose uploads live under the Clerk org id
 * (`workspaces/org_…/`), inbound attachments under the master workspace id
 * (`workspaces/ws_…/`, mail-inbound-worker). Pass both.
 *
 * `mail/<workspaceId>/…` is the separate R2 layout for message bodies and raw
 * MIME (`store/bodies.ts`, docs/plans/weldmail-mailbox-store-design.md
 * decision 4) — a sibling top-level prefix, not nested under `workspaces/`.
 * It only ever uses the master `workspaces.id`, but the check is run against
 * whichever ids the caller passes (same as the `workspaces/` prefix above),
 * so a key still has to match one of them.
 */
export function isWorkspaceStorageKey(key: string, workspaceIds: string | readonly string[]): boolean {
  if (key.includes('..')) return false;
  const ids = (typeof workspaceIds === 'string' ? [workspaceIds] : workspaceIds).filter(Boolean);
  return ids.some((id) => key.startsWith(`workspaces/${id}/`) || key.startsWith(`mail/${id}/`));
}

/** The binding `deleteAttachment` reads (any worker Env with it fits). */
export interface MailAttachmentsEnv {
  STORAGE?: R2Bucket;
  PRIVATE_STORAGE?: R2Bucket;
}

export function listAttachmentsForMessage(db: Database, messageId: string) {
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

export async function createAttachment(db: Database, data: AttachmentInput & { id?: string }, now: Date = new Date()) {
  const { id: suppliedId, ...rest } = data;
  // Accept a pre-generated id (the store's `attachment.create` op, design task
  // B4, mints the id up front, like `ingest`) — defaulting to a fresh one
  // keeps every existing caller working unchanged.
  const id = suppliedId ?? generateId('attach');
  await db.insert(mailAttachments).values({
    id,
    ...rest,
    isInline: data.isInline ?? false,
    createdAt: now,
    updatedAt: now,
  });
  await refreshMessageAttachmentCount(db, data.messageId, now);
  const [row] = await db.select().from(mailAttachments).where(eq(mailAttachments.id, id));
  return row!;
}

export async function updateAttachment(
  db: Database,
  id: string,
  data: Partial<AttachmentInput>,
  now: Date = new Date(),
) {
  const [existing] = await db
    .select()
    .from(mailAttachments)
    .where(and(eq(mailAttachments.id, id), isNull(mailAttachments.deletedAt)))
    .limit(1);
  if (!existing) return null;

  const patch: Record<string, unknown> = { updatedAt: now };
  for (const [k, v] of Object.entries(data)) if (v !== undefined) patch[k] = v;
  await db
    .update(mailAttachments)
    .set(patch as typeof mailAttachments.$inferInsert)
    .where(eq(mailAttachments.id, id));
  if (data.messageId && data.messageId !== existing.messageId) {
    await refreshMessageAttachmentCount(db, existing.messageId, now);
    await refreshMessageAttachmentCount(db, data.messageId, now);
  }
  const [after] = await db.select().from(mailAttachments).where(eq(mailAttachments.id, id));
  return { before: existing, after: after! };
}

/**
 * The row-level half of a delete: soft-delete and refresh the parent
 * message's count flags, with no R2 involved. `deleteAttachment` below (the
 * live HTTP route) layers the best-effort R2 cleanup on top; the store's
 * `attachment.delete` op (design task B4) calls this directly and returns
 * `existing.storagePath` in its `OpResult.storagePaths` for the router to
 * delete instead — the store itself has no R2 binding (`PostgresMailboxStore`
 * takes only `db` and `ref`).
 */
export async function softDeleteAttachmentRow(db: Database, id: string, now: Date = new Date()) {
  const [existing] = await db
    .select()
    .from(mailAttachments)
    .where(and(eq(mailAttachments.id, id), isNull(mailAttachments.deletedAt)))
    .limit(1);
  if (!existing) return null;

  await db
    .update(mailAttachments)
    .set({ deletedAt: now, updatedAt: now })
    .where(eq(mailAttachments.id, id));
  await refreshMessageAttachmentCount(db, existing.messageId, now);
  return existing;
}

/**
 * Soft-delete the row and best-effort delete the underlying R2 object.
 * R2 failure does NOT block the response — the DB is the source of truth
 * for what the inbox shows, and a leaked object can be GC'd by a separate
 * sweep without re-surfacing in the UI.
 */
export async function deleteAttachment(env: MailAttachmentsEnv, db: Database, id: string) {
  const existing = await softDeleteAttachmentRow(db, id);
  if (!existing) return null;

  if (existing.storagePath && (env.STORAGE || env.PRIVATE_STORAGE)) {
    try {
      await deleteStoredObject(env, existing.storagePath);
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
  now: Date = new Date(),
): Promise<{ associated: number }> {
  if (attachmentIds.length === 0) return { associated: 0 };
  const rows = await db
    .update(mailAttachments)
    .set({ messageId, updatedAt: now })
    .where(
      and(
        inArray(mailAttachments.id, attachmentIds),
        isNull(mailAttachments.deletedAt),
      ),
    )
    .returning({ id: mailAttachments.id });
  await refreshMessageAttachmentCount(db, messageId, now);
  return { associated: rows.length };
}

async function refreshMessageAttachmentCount(db: Database, messageId: string, now: Date = new Date()) {
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
      updated_at = ${now}
    WHERE id = ${messageId}
  `);
}
