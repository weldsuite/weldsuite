/**
 * Mail attachment routes — /api/mail-attachments/*.
 *
 * Attachments are persisted in R2 and indexed in `mail_attachments`. The
 * compose UI uploads to R2 first (via the storage worker's signed-URL
 * route), then calls `POST /associate` once the parent message exists
 * to wire them together. Delete cleans up both the row and the R2 object
 * (best-effort — R2 failure doesn't block).
 *
 * Responses never carry `storagePath` or `downloadUrl` (the bucket's public URL
 * serves a file without authentication): the bytes are only served by
 * `GET /:id/download`, which checks access to the mailbox, and a caller that
 * cannot read the attachment gets a 404 there, like for a missing one — this
 * one pair (`GET /:id/download`, `GET /:id`) has always answered 404 for both
 * "missing" and "inaccessible", in every mode. Every other mutating route
 * here (`POST /`, `PUT`/`PATCH /:id`, `DELETE /:id`, `GET /message/:messageId`,
 * `POST /associate`'s own message check) answered 403 for "exists, but
 * closed to you" — kept exactly as-is in `postgres`/`shadow`; `object`/
 * `object-only` collapse it to 404 too (design §5's "Locate": "a message
 * outside the caller's reach is a 404, where today it is a 403 — no
 * existence leak").
 *
 * Every read/write goes through `workspaceMailFromContext`'s `store`/`access`
 * (design docs/plans/weldmail-mailbox-store-design.md, task D2).
 *
 * Entity events: `mail_attachment:created | updated | deleted`.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import type { Env, Variables } from '../../types';
import { error, noContent, success } from '@weldsuite/worker-kit/response';
import { toPublicAttachment, isWorkspaceStorageKey, getAttachment as getAttachmentRowUnscoped } from '@weldsuite/mail-domain/attachments';
import { getMessageAccountId } from '@weldsuite/mail-domain/messages';
import { getStoredObject, deleteStoredObject } from '@weldsuite/worker-kit/storage';
import { generateId } from '@weldsuite/worker-kit/id';
import { workspaceMailFromContext } from '../../lib/mail-store-context';
import type { Database } from '@weldsuite/worker-kit/db';
import type { MailAccess, MailAttachmentRecord, MailStoreMode, WorkspaceMailStore } from '@weldsuite/mail-domain/store';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

const createBody = z.object({
  messageId: z.string().min(1),
  fileName: z.string().min(1).max(500),
  contentType: z.string().max(255).optional(),
  size: z.number().int().nonnegative(),
  // Must be an object under the caller's workspace folder (checked in the
  // handlers). `downloadUrl` is no longer accepted: a public URL is never stored.
  storagePath: z.string().max(1000).optional(),
  checksum: z.string().max(64).optional(),
  isInline: z.boolean().optional(),
  contentId: z.string().max(255).optional(),
  contentDisposition: z.string().max(100).optional(),
});

const updateBody = createBody.partial();

type AppContext = import('hono').Context<{ Bindings: Env; Variables: Variables }>;

/** `obj` without `keys` — an explicit drop instead of destructuring into an unused `_name` binding. */
function omit<T extends object, K extends keyof T>(obj: T, keys: readonly K[]): Omit<T, K> {
  const copy = { ...obj };
  for (const key of keys) delete copy[key];
  return copy;
}

/**
 * The ids the workspace's storage folders are named after: the Clerk org id
 * (compose uploads) and the master workspace id (inbound mail, written by
 * mail-inbound-worker). Both come from the request context.
 */
function workspaceStorageIds(c: AppContext): string[] {
  return [c.get('clerkOrgId'), c.get('workspaceId')];
}

/** 400 body when a storagePath points outside the workspace's folder. */
async function foreignStoragePath(c: AppContext, path: string | undefined) {
  if (path === undefined || isWorkspaceStorageKey(path, workspaceStorageIds(c))) return null;
  return error.badRequest(c, 'storagePath must be a file in this workspace');
}

const associateBody = z.object({
  messageId: z.string().min(1),
  attachmentIds: z.array(z.string()).min(1).max(100),
});

type LocateResult = { ok: true; accountId: string } | { ok: false; response: Response };

/**
 * `GET /message/:messageId`, `POST /associate`, `POST /` — the message-owner
 * check that answered 404 for a missing message and 403 for an inaccessible
 * one. `postgres`/`shadow` keep exactly that (a true, access-unscoped lookup
 * decides which); `object`/`object-only` collapse both to 404.
 */
async function locateMessageOrRespond(
  c: AppContext,
  db: Database,
  store: WorkspaceMailStore,
  access: MailAccess,
  mode: MailStoreMode,
  messageId: string,
): Promise<LocateResult> {
  const accessibleIds = await access.accessibleAccountIds();
  if (accessibleIds.length > 0) {
    const located = await store.locateMessages([messageId], accessibleIds);
    const accountId = located.get(messageId);
    if (accountId) return { ok: true, accountId };
  }
  if (mode === 'postgres' || mode === 'shadow') {
    const trueAccountId = await getMessageAccountId(db, messageId);
    if (!trueAccountId) return { ok: false, response: error.notFound(c, 'Message', messageId) };
    return { ok: false, response: error.forbidden(c, 'Access to this mail account is not allowed') };
  }
  return { ok: false, response: error.notFound(c, 'Message', messageId) };
}

type LocateAttachmentResult =
  | { ok: true; accountId: string; attachment: MailAttachmentRecord }
  | { ok: false; response: Response };

/**
 * `PUT`/`PATCH /:id`, `DELETE /:id` — same 404-missing/403-inaccessible split
 * as `locateMessageOrRespond`, for the attachment itself rather than a
 * message id. `GET /:id` and `GET /:id/download` do NOT use this: they
 * already answered 404 for both cases in every mode (see this file's header
 * comment), so they just call `store.locateAttachment` directly.
 */
async function locateAttachmentOrRespond(
  c: AppContext,
  db: Database,
  store: WorkspaceMailStore,
  access: MailAccess,
  mode: MailStoreMode,
  id: string,
): Promise<LocateAttachmentResult> {
  const accessibleIds = await access.accessibleAccountIds();
  const located = accessibleIds.length > 0 ? await store.locateAttachment(id, accessibleIds) : null;
  if (located) return { ok: true, accountId: located.accountId, attachment: located.attachment };
  if (mode === 'postgres' || mode === 'shadow') {
    const existing = await getAttachmentRowUnscoped(db, id);
    if (!existing) return { ok: false, response: error.notFound(c, 'Attachment', id) };
    const trueAccountId = await getMessageAccountId(db, existing.messageId);
    if (!trueAccountId) return { ok: false, response: error.notFound(c, 'Attachment', id) };
    return { ok: false, response: error.forbidden(c, 'Access to this mail account is not allowed') };
  }
  return { ok: false, response: error.notFound(c, 'Attachment', id) };
}

app.get('/message/:messageId', requirePermission('messages:read'), async (c) => {
  const messageId = c.req.param('messageId');
  try {
    const db = c.get('tenantDb');
    const { store, access, mode } = await workspaceMailFromContext(c);
    const located = await locateMessageOrRespond(c, db, store, access, mode, messageId);
    if (!located.ok) return located.response;
    const rows = await store.mailbox(located.accountId).listAttachments(messageId);
    return success(c, rows.map(toPublicAttachment));
  } catch (err) {
    console.error('[app-api/mail-attachments] list-for-message failed:', err);
    return error.internal(c, 'Failed to list attachments');
  }
});

app.post('/associate', requirePermission('messages:update'), zValidator('json', associateBody), async (c) => {
  const { messageId, attachmentIds } = c.req.valid('json');
  try {
    const db = c.get('tenantDb');
    const { store, access, mode } = await workspaceMailFromContext(c);
    const located = await locateMessageOrRespond(c, db, store, access, mode, messageId);
    if (!located.ok) return located.response;
    const accessibleIds = await access.accessibleAccountIds();

    // Only attachments of mailboxes the caller can open: an id from a private
    // mailbox must not be movable into a message the caller does control.
    // Unreachable ids are silently excluded (unchanged — the route never
    // errored for those, only skipped them).
    const movable: Array<{ id: string; fileName: string }> = [];
    for (const attachmentId of new Set(attachmentIds)) {
      const owner = await store.locateAttachment(attachmentId, accessibleIds);
      if (owner) movable.push({ id: owner.attachment.id, fileName: owner.attachment.fileName });
    }
    const result = await store.mailbox(located.accountId).apply({
      kind: 'attachment.associate',
      messageId,
      attachmentIds: movable.map((a) => a.id),
    });
    if (result.applied.length > 0) {
      for (const moved of movable) {
        publishEntityEvent({
          c,
          entityType: 'mail_attachment',
          entityId: moved.id,
          action: 'updated',
          data: { id: moved.id, messageId, fileName: moved.fileName },
        });
      }
    }
    return success(c, { messageId, associated: result.applied.length });
  } catch (err) {
    console.error('[app-api/mail-attachments] associate failed:', err);
    return error.internal(c, 'Failed to associate attachments');
  }
});

/**
 * GET /:id/download — the attachment's bytes, for members who can read the
 * mailbox it belongs to. This is the download path the apps use: the object's
 * storage URL carries no session, signature or expiry, so it must not be the
 * thing a mail client links to.
 */
app.get('/:id/download', requirePermission('messages:read'), async (c) => {
  const id = c.req.param('id');
  try {
    const { store, access } = await workspaceMailFromContext(c);
    const accessibleIds = await access.accessibleAccountIds();
    // Not readable = not found: the response must not tell an attachment of a
    // private mailbox apart from one that does not exist (unchanged from
    // today, in every mode — see this route's own header comment).
    const located = accessibleIds.length > 0 ? await store.locateAttachment(id, accessibleIds) : null;
    if (!located) return error.notFound(c, 'Attachment', id);
    const row = located.attachment;
    if (!c.env.STORAGE && !c.env.PRIVATE_STORAGE) {
      return c.json(
        { error: { code: 'STORAGE_BINDING_MISSING', message: 'Storage binding not configured' } },
        503,
      );
    }
    // A key outside the workspace's folder is never served, whatever the row says.
    const object =
      row.storagePath && isWorkspaceStorageKey(row.storagePath, workspaceStorageIds(c))
        ? await getStoredObject(c.env, row.storagePath)
        : null;
    if (!object) return error.notFound(c, 'Attachment', id);
    return new Response(object.body, {
      headers: {
        'Content-Type': row.contentType || object.httpMetadata?.contentType || 'application/octet-stream',
        // Always a download, never rendered on the API origin (the file is
        // whatever a stranger mailed in).
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(row.fileName)}`,
        'Content-Length': String(object.size),
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (err) {
    console.error('[app-api/mail-attachments] download failed:', err);
    return error.internal(c, 'Failed to download attachment');
  }
});

app.get('/:id', requirePermission('messages:read'), async (c) => {
  const id = c.req.param('id');
  try {
    const { store, access } = await workspaceMailFromContext(c);
    const accessibleIds = await access.accessibleAccountIds();
    const located = accessibleIds.length > 0 ? await store.locateAttachment(id, accessibleIds) : null;
    if (!located) return error.notFound(c, 'Attachment', id);
    return success(c, toPublicAttachment(located.attachment));
  } catch (err) {
    console.error('[app-api/mail-attachments] get failed:', err);
    return error.internal(c, 'Failed to fetch attachment');
  }
});

app.post('/', requirePermission('messages:create'), zValidator('json', createBody), async (c) => {
  try {
    const data = c.req.valid('json');
    const foreign = await foreignStoragePath(c, data.storagePath);
    if (foreign) return foreign;
    const db = c.get('tenantDb');
    const { store, access, mode } = await workspaceMailFromContext(c);
    const located = await locateMessageOrRespond(c, db, store, access, mode, data.messageId);
    if (!located.ok) return located.response;
    const id = generateId('attach');
    await store.mailbox(located.accountId).apply({ kind: 'attachment.create', attachment: { id, ...data } });
    const row = await store.mailbox(located.accountId).getAttachment(id);
    if (!row) return error.internal(c, 'Failed to create attachment');
    publishEntityEvent({
      c,
      entityType: 'mail_attachment',
      entityId: row.id,
      action: 'created',
      data: { id: row.id, messageId: row.messageId, fileName: row.fileName },
    });
    // `MailboxStore.getAttachment` adds `accountId` on top of the plain row
    // (it joins through the message to answer that); strip it back out so the
    // response shape matches `GET /:id`'s (today's route never had this field).
    return success(c, toPublicAttachment(omit(row, ['accountId'])), 201);
  } catch (err) {
    console.error('[app-api/mail-attachments] create failed:', err);
    return error.internal(c, 'Failed to create attachment');
  }
});

const updateRoute = async (
  c: import('hono').Context<{ Bindings: Env; Variables: Variables }, '/:id'>,
) => {
  const id = c.req.param('id');
  const data = c.req.valid('json' as never) as z.infer<typeof updateBody>;
  const foreign = await foreignStoragePath(c, data.storagePath);
  if (foreign) return foreign;
  try {
    const db = c.get('tenantDb');
    const { store, access, mode } = await workspaceMailFromContext(c);
    const located = await locateAttachmentOrRespond(c, db, store, access, mode, id);
    if (!located.ok) return located.response;
    const result = await store.mailbox(located.accountId).apply({ kind: 'attachment.update', id, patch: data });
    if (!result.applied.includes(id)) return error.notFound(c, 'Attachment', id);
    const after = await store.mailbox(located.accountId).getAttachment(id);
    if (!after) return error.notFound(c, 'Attachment', id);
    publishEntityEvent({
      c,
      entityType: 'mail_attachment',
      entityId: id,
      action: 'updated',
      data: { id, messageId: after.messageId, fileName: after.fileName },
    });
    return success(c, toPublicAttachment(omit(after, ['accountId'])));
  } catch (err) {
    console.error('[app-api/mail-attachments] update failed:', err);
    return error.internal(c, 'Failed to update attachment');
  }
};

app.put('/:id', requirePermission('messages:update'), zValidator('json', updateBody), updateRoute);
app.patch('/:id', requirePermission('messages:update'), zValidator('json', updateBody), updateRoute);

app.delete('/:id', requirePermission('messages:delete'), async (c) => {
  const id = c.req.param('id');
  try {
    const db = c.get('tenantDb');
    const { store, access, mode } = await workspaceMailFromContext(c);
    const located = await locateAttachmentOrRespond(c, db, store, access, mode, id);
    if (!located.ok) return located.response;
    const { messageId, fileName } = located.attachment;
    const result = await store.mailbox(located.accountId).apply({ kind: 'attachment.delete', id });
    if (!result.applied.includes(id)) return error.notFound(c, 'Attachment', id);
    // Best-effort R2 cleanup, same as today's `deleteAttachment` — a failure
    // here never fails the request; the row is already gone.
    for (const path of result.storagePaths ?? []) {
      if (!c.env.STORAGE && !c.env.PRIVATE_STORAGE) break;
      try {
        await deleteStoredObject(c.env, path);
      } catch (storageErr) {
        console.error(`[app-api/mail-attachments] R2 delete failed for ${path} (attachment ${id}):`, storageErr);
      }
    }
    publishEntityEvent({
      c,
      entityType: 'mail_attachment',
      entityId: id,
      action: 'deleted',
      data: { id, messageId, fileName },
    });
    return noContent(c);
  } catch (err) {
    console.error('[app-api/mail-attachments] delete failed:', err);
    return error.internal(c, 'Failed to delete attachment');
  }
});

export const mailAttachmentsRoutes = app;
