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
 * cannot read the attachment gets a 404 there, like for a missing one.
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
import * as attachments from '@weldsuite/mail-domain/attachments';
import { toPublicAttachment, isWorkspaceStorageKey } from '@weldsuite/mail-domain/attachments';
import { getMessageAccountId } from '@weldsuite/mail-domain/messages';
import { checkAccountAccess } from '@weldsuite/mail-domain/access';
import { getWorkspaceForOrg } from '@weldsuite/worker-kit/db';

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

/**
 * The ids the workspace's storage folders are named after: the Clerk org id
 * (compose uploads) and the master workspace id (inbound mail, written by
 * mail-inbound-worker). The master id comes from the KV-cached lookup the
 * tenant DB middleware already warmed.
 */
async function workspaceStorageIds(c: AppContext): Promise<string[]> {
  const orgId = c.get('workspaceId');
  try {
    const { id } = await getWorkspaceForOrg(c.env, orgId);
    return [orgId, id];
  } catch (err) {
    console.warn('[mail-attachments] master workspace id lookup failed:', err instanceof Error ? err.message : err);
    return [orgId];
  }
}

/** 400 body when a storagePath points outside the workspace's folder. */
async function foreignStoragePath(c: AppContext, path: string | undefined) {
  if (path === undefined || isWorkspaceStorageKey(path, await workspaceStorageIds(c))) return null;
  return error.badRequest(c, 'storagePath must be a file in this workspace');
}

const associateBody = z.object({
  messageId: z.string().min(1),
  attachmentIds: z.array(z.string()).min(1).max(100),
});

app.get('/message/:messageId', requirePermission('messages:read'), async (c) => {
  const messageId = c.req.param('messageId');
  try {
    const db = c.get('tenantDb');
    const userId = c.get('userId');
    const accountId = await getMessageAccountId(db, messageId);
    if (!accountId) return error.notFound(c, 'Message', messageId);
    const allowed = await checkAccountAccess(db, accountId, userId);
    if (!allowed) return error.forbidden(c, 'Access to this mail account is not allowed');
    const rows = await attachments.listAttachmentsForMessage(db, messageId);
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
    const userId = c.get('userId');
    const accountId = await getMessageAccountId(db, messageId);
    if (!accountId) return error.notFound(c, 'Message', messageId);
    const allowed = await checkAccountAccess(db, accountId, userId);
    if (!allowed) return error.forbidden(c, 'Access to this mail account is not allowed');
    // Only attachments of mailboxes the caller can open: an id from a private
    // mailbox must not be movable into a message the caller does control.
    const movable: Array<{ id: string; fileName: string }> = [];
    const checked = new Map<string, boolean>();
    for (const attachmentId of new Set(attachmentIds)) {
      const row = await attachments.getAttachment(db, attachmentId);
      if (!row) continue;
      const owner = await getMessageAccountId(db, row.messageId);
      if (!owner) continue;
      if (!checked.has(owner)) checked.set(owner, await checkAccountAccess(db, owner, userId));
      if (checked.get(owner)) movable.push({ id: row.id, fileName: row.fileName });
    }
    const result = await attachments.associateAttachments(
      db,
      messageId,
      movable.map((a) => a.id),
    );
    if (result.associated > 0) {
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
    return success(c, { messageId, ...result });
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
    const db = c.get('tenantDb');
    const userId = c.get('userId');
    const row = await attachments.getAttachment(db, id);
    if (!row) return error.notFound(c, 'Attachment', id);
    const accountId = await getMessageAccountId(db, row.messageId);
    if (!accountId) return error.notFound(c, 'Attachment', id);
    // Not readable = not found: the response must not tell an attachment of a
    // private mailbox apart from one that does not exist.
    const allowed = await checkAccountAccess(db, accountId, userId);
    if (!allowed) return error.notFound(c, 'Attachment', id);
    if (!c.env.STORAGE) {
      return c.json(
        { error: { code: 'STORAGE_BINDING_MISSING', message: 'Storage binding not configured' } },
        503,
      );
    }
    // A key outside the workspace's folder is never served, whatever the row says.
    const object =
      row.storagePath && isWorkspaceStorageKey(row.storagePath, await workspaceStorageIds(c))
        ? await c.env.STORAGE.get(row.storagePath)
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
    const db = c.get('tenantDb');
    const userId = c.get('userId');
    const row = await attachments.getAttachment(db, id);
    if (!row) return error.notFound(c, 'Attachment', id);
    const accountId = await getMessageAccountId(db, row.messageId);
    if (!accountId) return error.notFound(c, 'Attachment', id);
    const allowed = await checkAccountAccess(db, accountId, userId);
    if (!allowed) return error.notFound(c, 'Attachment', id);
    return success(c, toPublicAttachment(row));
  } catch (err) {
    console.error('[app-api/mail-attachments] get failed:', err);
    return error.internal(c, 'Failed to fetch attachment');
  }
});

app.post('/', requirePermission('messages:create'), zValidator('json', createBody), async (c) => {
  try {
    const db = c.get('tenantDb');
    const userId = c.get('userId');
    const data = c.req.valid('json');
    const foreign = await foreignStoragePath(c, data.storagePath);
    if (foreign) return foreign;
    const accountId = await getMessageAccountId(db, data.messageId);
    if (!accountId) return error.notFound(c, 'Message', data.messageId);
    const allowed = await checkAccountAccess(db, accountId, userId);
    if (!allowed) return error.forbidden(c, 'Access to this mail account is not allowed');
    const row = await attachments.createAttachment(db, data);
    publishEntityEvent({
      c,
      entityType: 'mail_attachment',
      entityId: row.id,
      action: 'created',
      data: { id: row.id, messageId: row.messageId, fileName: row.fileName },
    });
    return success(c, toPublicAttachment(row), 201);
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
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const existing = await attachments.getAttachment(db, id);
  if (!existing) return error.notFound(c, 'Attachment', id);
  const accountId = await getMessageAccountId(db, existing.messageId);
  if (!accountId) return error.notFound(c, 'Attachment', id);
  const allowed = await checkAccountAccess(db, accountId, userId);
  if (!allowed) return error.forbidden(c, 'Access to this mail account is not allowed');
  try {
    const result = await attachments.updateAttachment(db, id, data);
    if (!result) return error.notFound(c, 'Attachment', id);
    publishEntityEvent({
      c,
      entityType: 'mail_attachment',
      entityId: id,
      action: 'updated',
      data: { id, messageId: result.after.messageId, fileName: result.after.fileName },
    });
    return success(c, toPublicAttachment(result.after));
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
    const userId = c.get('userId');
    const existing = await attachments.getAttachment(db, id);
    if (!existing) return error.notFound(c, 'Attachment', id);
    const accountId = await getMessageAccountId(db, existing.messageId);
    if (!accountId) return error.notFound(c, 'Attachment', id);
    const allowed = await checkAccountAccess(db, accountId, userId);
    if (!allowed) return error.forbidden(c, 'Access to this mail account is not allowed');
    const deleted = await attachments.deleteAttachment(c.env, db, id);
    if (!deleted) return error.notFound(c, 'Attachment', id);
    publishEntityEvent({
      c,
      entityType: 'mail_attachment',
      entityId: id,
      action: 'deleted',
      data: { id, messageId: deleted.messageId, fileName: deleted.fileName },
    });
    return noContent(c);
  } catch (err) {
    console.error('[app-api/mail-attachments] delete failed:', err);
    return error.internal(c, 'Failed to delete attachment');
  }
});

export const mailAttachmentsRoutes = app;
