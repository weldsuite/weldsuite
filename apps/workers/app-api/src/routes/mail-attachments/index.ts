/**
 * Mail attachment routes — /api/mail-attachments/*.
 *
 * Attachments are persisted in R2 and indexed in `mail_attachments`. The
 * compose UI uploads to R2 first (via the storage worker's signed-URL
 * route), then calls `POST /associate` once the parent message exists
 * to wire them together. Delete cleans up both the row and the R2 object
 * (best-effort — R2 failure doesn't block).
 *
 * Entity events: `mail_attachment:created | updated | deleted`.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import type { Env, Variables } from '../../types';
import { error, noContent, success } from '../../lib/response';
import * as attachments from '../../services/mail/attachments';
import { getMessageAccountId } from '../../services/mail/messages';
import { checkAccountAccess } from '../../services/mail/access';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

const createBody = z.object({
  messageId: z.string().min(1),
  fileName: z.string().min(1).max(500),
  contentType: z.string().max(255).optional(),
  size: z.number().int().nonnegative(),
  storagePath: z.string().max(1000).optional(),
  downloadUrl: z.string().optional(),
  checksum: z.string().max(64).optional(),
  isInline: z.boolean().optional(),
  contentId: z.string().max(255).optional(),
  contentDisposition: z.string().max(100).optional(),
});

const updateBody = createBody.partial();

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
    return success(c, rows);
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
    const result = await attachments.associateAttachments(db, messageId, attachmentIds);
    return success(c, { messageId, ...result });
  } catch (err) {
    console.error('[app-api/mail-attachments] associate failed:', err);
    return error.internal(c, 'Failed to associate attachments');
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
    if (!allowed) return error.forbidden(c, 'Access to this mail account is not allowed');
    return success(c, row);
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
    return success(c, row, 201);
  } catch (err) {
    console.error('[app-api/mail-attachments] create failed:', err);
    return error.internal(c, 'Failed to create attachment');
  }
});

const updateRoute = async (
  c: import('hono').Context<{ Bindings: Env; Variables: Variables }>,
) => {
  const id = c.req.param('id');
  const data = c.req.valid('json' as never) as z.infer<typeof updateBody>;
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
    return success(c, result.after);
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
