/**
 * Mail draft routes — /api/mail-drafts/*.
 *
 * Unsent compositions. The send path lives on `mail-accounts/:id/send`;
 * this surface is read/write of the holding table, plus a list filtered
 * by `accountId` for the compose-resume UI.
 *
 * Entity events: `mail_draft:created | updated | deleted`.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import type { Env, Variables } from '../../types';
import { cursorPagination, error, list, noContent, success } from '../../lib/response';
import * as drafts from '../../services/mail/drafts';
import { checkAccountAccess } from '../../services/mail/access';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

const listQuery = z.object({
  accountId: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  cursor: z.string().optional(),
});

const baseBody = {
  subject: z.string().max(998).optional(),
  to: z.array(z.string()).optional(),
  cc: z.array(z.string()).optional(),
  bcc: z.array(z.string()).optional(),
  replyTo: z.array(z.string()).optional(),
  body: z.string().optional(),
  htmlBody: z.string().optional(),
  importance: z.enum(['low', 'normal', 'high']).optional(),
  labels: z.array(z.string()).optional(),
  attachmentIds: z.array(z.string()).optional(),
  inReplyTo: z.string().max(500).optional(),
  originalMessageId: z.string().optional(),
  isReply: z.boolean().optional(),
  isForward: z.boolean().optional(),
} as const;

const createBody = z.object({ accountId: z.string().min(1), ...baseBody });
const updateBody = z.object(baseBody).partial();

app.get('/', requirePermission('messages:read'), zValidator('query', listQuery), async (c) => {
  try {
    const db = c.get('tenantDb');
    const userId = c.get('userId');
    const filters = c.req.valid('query');
    if (filters.accountId) {
      const allowed = await checkAccountAccess(db, filters.accountId, userId);
      if (!allowed) return error.forbidden(c, 'Access to this mail account is not allowed');
    }
    const result = await drafts.listDrafts(db, filters);
    return list(c, result.data, cursorPagination(result.totalCount, result.hasMore, result.cursor));
  } catch (err) {
    console.error('[app-api/mail-drafts] list failed:', err);
    return error.internal(c, 'Failed to list drafts');
  }
});

app.get('/:id', requirePermission('messages:read'), async (c) => {
  const id = c.req.param('id');
  try {
    const db = c.get('tenantDb');
    const userId = c.get('userId');
    const row = await drafts.getDraft(db, id);
    if (!row) return error.notFound(c, 'Draft', id);
    const allowed = await checkAccountAccess(db, row.accountId, userId);
    if (!allowed) return error.forbidden(c, 'Access to this mail account is not allowed');
    return success(c, row);
  } catch (err) {
    console.error('[app-api/mail-drafts] get failed:', err);
    return error.internal(c, 'Failed to fetch draft');
  }
});

app.post('/', requirePermission('messages:create'), zValidator('json', createBody), async (c) => {
  try {
    const db = c.get('tenantDb');
    const userId = c.get('userId');
    const data = c.req.valid('json');
    const allowed = await checkAccountAccess(db, data.accountId, userId);
    if (!allowed) return error.forbidden(c, 'Access to this mail account is not allowed');
    const row = await drafts.createDraft(db, data);
    publishEntityEvent({
      c,
      entityType: 'mail_draft',
      entityId: row.id,
      action: 'created',
      data: { id: row.id, accountId: row.accountId, subject: row.subject ?? null },
    });
    return success(c, row, 201);
  } catch (err) {
    console.error('[app-api/mail-drafts] create failed:', err);
    return error.internal(c, 'Failed to create draft');
  }
});

const updateRoute = async (
  c: import('hono').Context<{ Bindings: Env; Variables: Variables }>,
) => {
  const id = c.req.param('id');
  const data = c.req.valid('json' as never) as z.infer<typeof updateBody>;
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const existing = await drafts.getDraft(db, id);
  if (!existing) return error.notFound(c, 'Draft', id);
  const allowed = await checkAccountAccess(db, existing.accountId, userId);
  if (!allowed) return error.forbidden(c, 'Access to this mail account is not allowed');
  try {
    const result = await drafts.updateDraft(db, id, data);
    if (!result) return error.notFound(c, 'Draft', id);
    publishEntityEvent({
      c,
      entityType: 'mail_draft',
      entityId: id,
      action: 'updated',
      data: { id, accountId: result.after.accountId, subject: result.after.subject ?? null },
    });
    return success(c, result.after);
  } catch (err) {
    console.error('[app-api/mail-drafts] update failed:', err);
    return error.internal(c, 'Failed to update draft');
  }
};

app.put('/:id', requirePermission('messages:update'), zValidator('json', updateBody), updateRoute);
app.patch('/:id', requirePermission('messages:update'), zValidator('json', updateBody), updateRoute);

app.delete('/:id', requirePermission('messages:delete'), async (c) => {
  const id = c.req.param('id');
  try {
    const db = c.get('tenantDb');
    const userId = c.get('userId');
    const existing = await drafts.getDraft(db, id);
    if (!existing) return error.notFound(c, 'Draft', id);
    const allowed = await checkAccountAccess(db, existing.accountId, userId);
    if (!allowed) return error.forbidden(c, 'Access to this mail account is not allowed');
    const deleted = await drafts.softDeleteDraft(db, id);
    if (!deleted) return error.notFound(c, 'Draft', id);
    publishEntityEvent({
      c,
      entityType: 'mail_draft',
      entityId: id,
      action: 'deleted',
      data: { id, accountId: deleted.accountId, subject: null },
    });
    return noContent(c);
  } catch (err) {
    console.error('[app-api/mail-drafts] delete failed:', err);
    return error.internal(c, 'Failed to delete draft');
  }
});

export const mailDraftsRoutes = app;
