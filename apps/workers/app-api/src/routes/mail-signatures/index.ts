/**
 * Mail signature routes — /api/mail-signatures/*.
 *
 * Workspace-level signatures (no `accountId` column on the table); assign
 * via `accountIds` / `userIds` JSONB columns. Marking one as default
 * unsets every other live row's `isDefault` in one statement.
 *
 * Entity events: `mail_signature:created | updated | deleted` (uses the
 * generic record-style payload since the catalog doesn't strongly type
 * signature events).
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import type { Env, Variables } from '../../types';
import { cursorPagination, error, list, noContent, success } from '../../lib/response';
import * as signatures from '../../services/mail/signatures';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

const typeEnum = z.enum(['personal', 'company', 'department']);
const positionEnum = z.enum(['above', 'below']);

const listQuery = z.object({
  type: typeEnum.optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  cursor: z.string().optional(),
});

const baseBody = {
  name: z.string().min(1).max(255),
  content: z.string().min(1),
  isDefault: z.boolean().optional(),
  type: typeEnum.optional(),
  accountIds: z.array(z.string()).optional(),
  userIds: z.array(z.string()).optional(),
  includeInReplies: z.boolean().optional(),
  includeInForwards: z.boolean().optional(),
  position: positionEnum.optional(),
  tags: z.array(z.string()).optional(),
} as const;

const createBody = z.object(baseBody);
const updateBody = z.object(baseBody).partial();

app.get('/', requirePermission('accounts:read'), zValidator('query', listQuery), async (c) => {
  try {
    const result = await signatures.listSignatures(c.get('tenantDb'), c.req.valid('query'));
    return list(c, result.data, cursorPagination(result.totalCount, result.hasMore, result.cursor));
  } catch (err) {
    console.error('[app-api/mail-signatures] list failed:', err);
    return error.internal(c, 'Failed to list signatures');
  }
});

app.get('/:id', requirePermission('accounts:read'), async (c) => {
  const id = c.req.param('id');
  try {
    const row = await signatures.getSignature(c.get('tenantDb'), id);
    if (!row) return error.notFound(c, 'Signature', id);
    return success(c, row);
  } catch (err) {
    console.error('[app-api/mail-signatures] get failed:', err);
    return error.internal(c, 'Failed to fetch signature');
  }
});

app.post('/', requirePermission('accounts:create'), zValidator('json', createBody), async (c) => {
  try {
    const row = await signatures.createSignature(c.get('tenantDb'), c.req.valid('json'));
    publishEntityEvent({
      c,
      entityType: 'mail_signature',
      entityId: row.id,
      action: 'created',
      data: { id: row.id, name: row.name, isDefault: row.isDefault },
    });
    return success(c, row, 201);
  } catch (err) {
    console.error('[app-api/mail-signatures] create failed:', err);
    return error.internal(c, 'Failed to create signature');
  }
});

const updateRoute = async (
  c: import('hono').Context<{ Bindings: Env; Variables: Variables }>,
) => {
  const id = c.req.param('id');
  const data = c.req.valid('json' as never) as z.infer<typeof updateBody>;
  try {
    const result = await signatures.updateSignature(c.get('tenantDb'), id, data);
    if (!result) return error.notFound(c, 'Signature', id);
    publishEntityEvent({
      c,
      entityType: 'mail_signature',
      entityId: id,
      action: 'updated',
      data: { id, name: result.after.name, isDefault: result.after.isDefault },
    });
    return success(c, result.after);
  } catch (err) {
    console.error('[app-api/mail-signatures] update failed:', err);
    return error.internal(c, 'Failed to update signature');
  }
};

app.put('/:id', requirePermission('accounts:update'), zValidator('json', updateBody), updateRoute);
app.patch('/:id', requirePermission('accounts:update'), zValidator('json', updateBody), updateRoute);

app.delete('/:id', requirePermission('accounts:delete'), async (c) => {
  const id = c.req.param('id');
  try {
    const deleted = await signatures.softDeleteSignature(c.get('tenantDb'), id);
    if (!deleted) return error.notFound(c, 'Signature', id);
    publishEntityEvent({
      c,
      entityType: 'mail_signature',
      entityId: id,
      action: 'deleted',
      data: { id, name: deleted.name },
    });
    return noContent(c);
  } catch (err) {
    console.error('[app-api/mail-signatures] delete failed:', err);
    return error.internal(c, 'Failed to delete signature');
  }
});

export const mailSignaturesRoutes = app;
