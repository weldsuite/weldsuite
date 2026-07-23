/**
 * Mail folder routes — /api/mail-folders/*.
 *
 * IMAP-style folder hierarchy per account. Most of the inbox sidebar
 * actually renders labels; this route exists for provider-sync state and
 * for accounts that genuinely have nested folders.
 *
 * Entity events: `mail_folder:created | updated | deleted`.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import type { Env, Variables } from '../../types';
import { error, noContent, success } from '../../lib/response';
import * as folders from '../../services/mail/folders';
import { MailFolderError } from '../../services/mail/folders';
import { checkAccountAccess } from '../../services/mail/access';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

const folderTypeEnum = z.enum(['inbox', 'sent', 'drafts', 'spam', 'trash', 'archive', 'custom']);

const listQuery = z.object({ accountId: z.string().optional() });

const createBody = z.object({
  accountId: z.string().min(1),
  name: z.string().min(1).max(255),
  type: folderTypeEnum.optional(),
  parentId: z.string().optional(),
  path: z.string().max(1000).optional(),
  color: z.string().max(7).optional(),
  icon: z.string().max(50).optional(),
  position: z.number().int().optional(),
});

const updateBody = createBody.omit({ accountId: true }).partial();

function mapFolderError(c: Parameters<typeof error.badRequest>[0], err: MailFolderError) {
  switch (err.code) {
    case 'NOT_FOUND':
      return error.notFound(c, 'Folder');
    case 'SYSTEM_FOLDER_IMMUTABLE':
      return error.forbidden(c, err.message);
  }
}

app.get('/', requirePermission('accounts:read'), zValidator('query', listQuery), async (c) => {
  try {
    const db = c.get('tenantDb');
    const userId = c.get('userId');
    const { accountId } = c.req.valid('query');
    if (accountId) {
      const allowed = await checkAccountAccess(db, accountId, userId);
      if (!allowed) return error.forbidden(c, 'Access to this mail account is not allowed');
    }
    const rows = await folders.listFolders(db, accountId);
    return success(c, rows);
  } catch (err) {
    console.error('[app-api/mail-folders] list failed:', err);
    return error.internal(c, 'Failed to list folders');
  }
});

app.get('/:id', requirePermission('accounts:read'), async (c) => {
  const id = c.req.param('id');
  try {
    const db = c.get('tenantDb');
    const userId = c.get('userId');
    const row = await folders.getFolder(db, id);
    if (!row) return error.notFound(c, 'Folder', id);
    const allowed = await checkAccountAccess(db, row.accountId, userId);
    if (!allowed) return error.forbidden(c, 'Access to this mail account is not allowed');
    return success(c, row);
  } catch (err) {
    console.error('[app-api/mail-folders] get failed:', err);
    return error.internal(c, 'Failed to fetch folder');
  }
});

app.post('/', requirePermission('accounts:create'), zValidator('json', createBody), async (c) => {
  try {
    const db = c.get('tenantDb');
    const userId = c.get('userId');
    const data = c.req.valid('json');
    const allowed = await checkAccountAccess(db, data.accountId, userId);
    if (!allowed) return error.forbidden(c, 'Access to this mail account is not allowed');
    const row = await folders.createFolder(db, data);
    publishEntityEvent({
      c,
      entityType: 'mail_folder',
      entityId: row.id,
      action: 'created',
      data: { id: row.id, accountId: row.accountId, name: row.name, type: row.type },
    });
    return success(c, row, 201);
  } catch (err) {
    console.error('[app-api/mail-folders] create failed:', err);
    return error.internal(c, 'Failed to create folder');
  }
});

const updateRoute = async (
  c: import('hono').Context<{ Bindings: Env; Variables: Variables }>,
) => {
  const id = c.req.param('id');
  const data = c.req.valid('json' as never) as z.infer<typeof updateBody>;
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const existing = await folders.getFolder(db, id);
  if (!existing) return error.notFound(c, 'Folder', id);
  const allowed = await checkAccountAccess(db, existing.accountId, userId);
  if (!allowed) return error.forbidden(c, 'Access to this mail account is not allowed');
  try {
    const result = await folders.updateFolder(db, id, data);
    publishEntityEvent({
      c,
      entityType: 'mail_folder',
      entityId: id,
      action: 'updated',
      data: {
        id,
        accountId: result.after.accountId,
        name: result.after.name,
        type: result.after.type,
      },
    });
    return success(c, result.after);
  } catch (err) {
    if (err instanceof MailFolderError) return mapFolderError(c, err);
    console.error('[app-api/mail-folders] update failed:', err);
    return error.internal(c, 'Failed to update folder');
  }
};

app.put('/:id', requirePermission('accounts:update'), zValidator('json', updateBody), updateRoute);
app.patch('/:id', requirePermission('accounts:update'), zValidator('json', updateBody), updateRoute);

app.delete('/:id', requirePermission('accounts:delete'), async (c) => {
  const id = c.req.param('id');
  try {
    const db = c.get('tenantDb');
    const userId = c.get('userId');
    const existing = await folders.getFolder(db, id);
    if (!existing) return error.notFound(c, 'Folder', id);
    const allowed = await checkAccountAccess(db, existing.accountId, userId);
    if (!allowed) return error.forbidden(c, 'Access to this mail account is not allowed');
    const deleted = await folders.softDeleteFolder(db, id);
    if (!deleted) return error.notFound(c, 'Folder', id);
    publishEntityEvent({
      c,
      entityType: 'mail_folder',
      entityId: id,
      action: 'deleted',
      data: { id, accountId: deleted.accountId, name: deleted.name, type: deleted.type },
    });
    return noContent(c);
  } catch (err) {
    if (err instanceof MailFolderError) return mapFolderError(c, err);
    console.error('[app-api/mail-folders] delete failed:', err);
    return error.internal(c, 'Failed to delete folder');
  }
});

export const mailFoldersRoutes = app;
