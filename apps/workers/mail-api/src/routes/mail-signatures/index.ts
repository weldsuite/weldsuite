/**
 * Mail signature routes — /api/mail-signatures/*.
 *
 * Anyone who writes mail manages their own `personal` signatures; nobody else
 * sees them (another member's is a 404). Shared (`company` / `department`)
 * signatures are visible to everyone and changed with `accounts:update` /
 * `accounts:delete`, like the mailboxes themselves, and can't be made personal
 * (that would take them away from everyone). See the service for how defaults
 * and account assignment work.
 *
 * Entity events: `mail_signature:created | updated | deleted`.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { hasContextPermission, requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import type { Env, Variables } from '../../types';
import { cursorPagination, error, list, noContent, success } from '@weldsuite/worker-kit/response';
import * as signatures from '../../services/mail/signatures';

type Ctx = import('hono').Context<{ Bindings: Env; Variables: Variables }>;

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

const typeEnum = z.enum(['personal', 'company', 'department']);
const positionEnum = z.enum(['above', 'below']);

const listQuery = z.object({
  type: typeEnum.optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  cursor: z.string().optional(),
});

const baseBody = {
  name: z.string().trim().min(1).max(255),
  // Signatures are short; this keeps a pasted image (data URL) from bloating every mail.
  content: z.string().min(1).max(100_000),
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

/** Shared signatures take the mailbox-admin permission for the action. */
async function canChangeShared(c: Ctx, action: 'update' | 'delete'): Promise<boolean> {
  return hasContextPermission(c, `accounts:${action}`);
}

const forbidden = (c: Ctx) => error.forbidden(c, 'Only mail admins can change shared signatures');

app.get('/', requirePermission('accounts:read'), zValidator('query', listQuery), async (c) => {
  try {
    const result = await signatures.listSignatures(c.get('tenantDb'), c.get('userId'), c.req.valid('query'));
    return list(c, result.data, cursorPagination(result.totalCount, result.hasMore, result.cursor));
  } catch (err) {
    console.error('[mail-api/mail-signatures] list failed:', err);
    return error.internal(c, 'Failed to list signatures');
  }
});

app.get('/:id', requirePermission('accounts:read'), async (c) => {
  const id = c.req.param('id');
  try {
    const row = await signatures.getSignature(c.get('tenantDb'), c.get('userId'), id);
    if (!row) return error.notFound(c, 'Signature', id);
    return success(c, row);
  } catch (err) {
    console.error('[mail-api/mail-signatures] get failed:', err);
    return error.internal(c, 'Failed to fetch signature');
  }
});

app.post('/', requirePermission('messages:create'), zValidator('json', createBody), async (c) => {
  const data = c.req.valid('json');
  if (signatures.isSharedSignatureType(data.type ?? 'personal') && !(await canChangeShared(c, 'update'))) {
    return forbidden(c);
  }
  try {
    const row = await signatures.createSignature(c.get('tenantDb'), c.get('userId'), data);
    publishEntityEvent({
      c,
      entityType: 'mail_signature',
      entityId: row.id,
      action: 'created',
      data: { id: row.id, name: row.name, isDefault: row.isDefault },
    });
    return success(c, row, 201);
  } catch (err) {
    console.error('[mail-api/mail-signatures] create failed:', err);
    return error.internal(c, 'Failed to create signature');
  }
});

const updateRoute = async (c: import('hono').Context<{ Bindings: Env; Variables: Variables }, '/:id'>) => {
  const id = c.req.param('id');
  const data = c.req.valid('json' as never) as z.infer<typeof updateBody>;
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  try {
    const existing = await signatures.getSignature(db, userId, id);
    if (!existing) return error.notFound(c, 'Signature', id);
    const touchesShared =
      signatures.isSharedSignatureType(existing.type) ||
      signatures.isSharedSignatureType(data.type ?? existing.type);
    if (touchesShared && !(await canChangeShared(c, 'update'))) return forbidden(c);
    // Making it personal would hand a signature everyone uses to one member.
    if (signatures.isSharedSignatureType(existing.type) && data.type === 'personal') {
      return error.badRequest(c, 'A shared signature cannot be made personal');
    }

    const result = await signatures.updateSignature(db, userId, existing, data);
    publishEntityEvent({
      c,
      entityType: 'mail_signature',
      entityId: id,
      action: 'updated',
      data: { id, name: result.after.name, isDefault: result.after.isDefault },
    });
    return success(c, result.after);
  } catch (err) {
    console.error('[mail-api/mail-signatures] update failed:', err);
    return error.internal(c, 'Failed to update signature');
  }
};

app.put('/:id', requirePermission('messages:create'), zValidator('json', updateBody), updateRoute);
app.patch('/:id', requirePermission('messages:create'), zValidator('json', updateBody), updateRoute);

app.delete('/:id', requirePermission('messages:create'), async (c) => {
  const id = c.req.param('id');
  const db = c.get('tenantDb');
  try {
    const existing = await signatures.getSignature(db, c.get('userId'), id);
    if (!existing) return error.notFound(c, 'Signature', id);
    if (signatures.isSharedSignatureType(existing.type) && !(await canChangeShared(c, 'delete'))) {
      return forbidden(c);
    }
    await signatures.softDeleteSignature(db, existing);
    publishEntityEvent({
      c,
      entityType: 'mail_signature',
      entityId: id,
      action: 'deleted',
      data: { id, name: existing.name },
    });
    return noContent(c);
  } catch (err) {
    console.error('[mail-api/mail-signatures] delete failed:', err);
    return error.internal(c, 'Failed to delete signature');
  }
});

export const mailSignaturesRoutes = app;
