/**
 * Mail folders — a mailbox's folder tree.
 *
 * System folders (inbox, sent, trash, …) can be recoloured, repositioned or
 * hidden, but not renamed, moved or deleted: their identity is what provider
 * sync matches on. Custom folders are free.
 */

import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { accessibleAccountIds, canOpenAccount } from '@weldsuite/mail-domain/access';
import {
  createFolder,
  getFolder,
  listFolders,
  MailFolderError,
  softDeleteFolder,
  updateFolder,
} from '@weldsuite/mail-domain/folders';
import type { HonoEnv } from '../../../types';
import { requireScope } from '../../../lib/scopes';
import { error, list, noContent, success, cursorPagination } from '../../../lib/response';
import { mailPrincipal } from '../../../lib/mail';

const listQuery = z.object({ accountId: z.string().optional() });

const folderFields = {
  name: z.string().trim().min(1).max(255),
  parentId: z.string().optional(),
  path: z.string().max(1000).optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Use a hex colour such as #4F46E5').optional(),
  icon: z.string().max(50).optional(),
  position: z.number().int().optional(),
};
const createBody = z.object({ accountId: z.string().min(1), ...folderFields });
const updateBody = z
  .object({ ...folderFields, name: folderFields.name.optional() })
  .refine((b) => Object.values(b).some((v) => v !== undefined), 'Nothing to update');

const app = new Hono<HonoEnv>();

/** The folder when it exists in a mailbox the caller can open. */
async function reachableFolder(c: Context<HonoEnv>, id: string) {
  const db = c.get('tenantDb');
  const folder = await getFolder(db, id);
  if (!folder || !(await canOpenAccount(db, folder.accountId, mailPrincipal(c)))) return null;
  return folder;
}

function folderErrorResponse(c: Context<HonoEnv>, err: unknown, id?: string) {
  if (err instanceof MailFolderError) {
    if (err.code === 'NOT_FOUND') return error.notFound(c, 'MailFolder', id);
    return error.conflict(c, err.message);
  }
  throw err;
}

/** A parent folder must be in the same mailbox. */
async function parentIsValid(c: Context<HonoEnv>, parentId: string | undefined, accountId: string) {
  if (!parentId) return true;
  const parent = await getFolder(c.get('tenantDb'), parentId);
  return parent?.accountId === accountId;
}

app.get('/', requireScope('mail_folders:read'), zValidator('query', listQuery), async (c) => {
  const db = c.get('tenantDb');
  const { accountId } = c.req.valid('query');
  const principal = mailPrincipal(c);
  if (accountId && !(await canOpenAccount(db, accountId, principal))) {
    return error.notFound(c, 'MailAccount', accountId);
  }
  const rows = await listFolders(db, accountId, accountId ? undefined : await accessibleAccountIds(db, principal));
  return list(c, rows, cursorPagination(rows.length, false, null));
});

app.get('/:id', requireScope('mail_folders:read'), async (c) => {
  const id = c.req.param('id');
  const folder = await reachableFolder(c, id);
  if (!folder) return error.notFound(c, 'MailFolder', id);
  return success(c, folder);
});

app.post('/', requireScope('mail_folders:write'), zValidator('json', createBody), async (c) => {
  const db = c.get('tenantDb');
  const body = c.req.valid('json');
  if (!(await canOpenAccount(db, body.accountId, mailPrincipal(c)))) {
    return error.notFound(c, 'MailAccount', body.accountId);
  }
  if (!(await parentIsValid(c, body.parentId, body.accountId))) {
    return error.badRequest(c, 'parentId must be a folder of the same mail account');
  }
  const row = await createFolder(db, { ...body, type: 'custom' });
  publishEntityEvent({
    c,
    entityType: 'mail_folder',
    entityId: row.id,
    action: 'created',
    data: { id: row.id, accountId: row.accountId, name: row.name, type: row.type },
  });
  return success(c, row, 201);
});

app.patch('/:id', requireScope('mail_folders:write'), zValidator('json', updateBody), async (c) => {
  const id = c.req.param('id');
  const folder = await reachableFolder(c, id);
  if (!folder) return error.notFound(c, 'MailFolder', id);
  const body = c.req.valid('json');
  if (!(await parentIsValid(c, body.parentId, folder.accountId))) {
    return error.badRequest(c, 'parentId must be a folder of the same mail account');
  }
  try {
    const { after } = await updateFolder(c.get('tenantDb'), id, body);
    publishEntityEvent({
      c,
      entityType: 'mail_folder',
      entityId: id,
      action: 'updated',
      data: { id, accountId: after.accountId, name: after.name, type: after.type },
    });
    return success(c, after);
  } catch (err) {
    return folderErrorResponse(c, err, id);
  }
});

app.delete('/:id', requireScope('mail_folders:write'), async (c) => {
  const id = c.req.param('id');
  if (!(await reachableFolder(c, id))) return error.notFound(c, 'MailFolder', id);
  try {
    const deleted = await softDeleteFolder(c.get('tenantDb'), id);
    if (!deleted) return error.notFound(c, 'MailFolder', id);
    publishEntityEvent({
      c,
      entityType: 'mail_folder',
      entityId: id,
      action: 'deleted',
      data: { id, accountId: deleted.accountId, name: deleted.name, type: deleted.type },
    });
    return noContent(c);
  } catch (err) {
    return folderErrorResponse(c, err, id);
  }
});

export default app;
