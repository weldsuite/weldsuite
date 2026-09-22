/**
 * Mail labels — list, read, create.
 *
 * Mirrors `apps/workers/app-api/src/routes/mail-labels` for the three
 * operations the MCP surface needs. Renaming, recolouring and deleting stay in
 * the UI: `mail_messages.labels` stores label *names*, so a rename is a
 * data-migration of every message that carries it, and a delete silently
 * orphans them. Neither is something to do from a tool call.
 *
 * Permissions follow app-api rather than intuition: label CRUD there is gated
 * on `accounts:*`, not `messages:*`, because a label is account configuration.
 * Diverging would let MCP create labels for someone the UI refuses.
 *
 * Entity events: `mail_label:created`.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { and, eq, isNull, sql, type SQL } from 'drizzle-orm';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { schema } from '../../../db';
import type { HonoEnv } from '../../../types';
import { requireScope } from '../../../lib/scopes';
import { generateId } from '../../../lib/id';
import { error, list, success, cursorPagination } from '../../../lib/response';
import { listWithCursor } from '../../../lib/list-helpers';
import {
  accessibleAccountIds,
  accountScopeCondition,
  checkAccountAccess,
} from '../../../lib/mail-access';
import { createMailLabelSchema } from '../../../../schemas/mail';

const table = schema.mailLabels;

const listQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().min(1).max(200).optional(),
  accountId: z.string().optional(),
  search: z.string().optional(),
});

const app = new Hono<HonoEnv>();

app.get('/', requireScope('accounts:read'), zValidator('query', listQuery), async (c) => {
  const db = c.get('tenantDb');
  const q = c.req.valid('query');
  const userId = c.get('userId');

  if (q.accountId && !(await checkAccountAccess(db, q.accountId, userId))) {
    return error.notFound(c, 'MailAccount', q.accountId);
  }

  const where: (SQL | undefined)[] = [];
  const scope = accountScopeCondition(table.accountId, await accessibleAccountIds(db, userId));
  if (scope) where.push(scope);
  if (q.accountId) where.push(eq(table.accountId, q.accountId));
  // `search` is what `lib/proxy.ts` retries with when a tool was handed a label
  // name instead of an id, so this filter is load-bearing beyond convenience.
  if (q.search) where.push(sql`${table.name} ILIKE ${`%${q.search}%`}`);

  const result = await listWithCursor({ db, table, where, cursor: q.cursor, limit: q.limit });
  return list(
    c,
    result.data as Record<string, unknown>[],
    cursorPagination(result.totalCount, result.hasMore, result.cursor),
  );
});

app.get('/:id', requireScope('accounts:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');

  const [row] = await db
    .select()
    .from(table)
    .where(and(eq(table.id, id), isNull(table.deletedAt)))
    .limit(1);
  if (!row) return error.notFound(c, 'MailLabel', id);
  if (!(await checkAccountAccess(db, row.accountId, c.get('userId')))) {
    return error.forbidden(c, 'Access to this mail account is not allowed');
  }
  return success(c, row);
});

app.post('/', requireScope('accounts:write'), zValidator('json', createMailLabelSchema), async (c) => {
  const db = c.get('tenantDb');
  const body = c.req.valid('json');

  if (!(await checkAccountAccess(db, body.accountId, c.get('userId')))) {
    return error.forbidden(c, 'Access to this mail account is not allowed');
  }

  // Case-insensitive uniqueness per account, matching `createMailLabel` in
  // app-api. There is no DB constraint behind it, so skipping the check would
  // produce two labels that look identical and split a mailbox's mail in two.
  const [duplicate] = await db
    .select({ id: table.id })
    .from(table)
    .where(
      and(
        eq(table.accountId, body.accountId),
        sql`LOWER(${table.name}) = LOWER(${body.name})`,
        isNull(table.deletedAt),
      ),
    )
    .limit(1);
  if (duplicate) {
    return error.conflict(c, 'A label with this name already exists on this account');
  }

  const now = new Date();
  const id = generateId('label');
  const [row] = await db
    .insert(table)
    .values({
      id,
      accountId: body.accountId,
      name: body.name,
      color: body.color ?? null,
      messageCount: 0,
      aiEnabled: body.aiEnabled ?? false,
      aiKeywords: body.aiKeywords ?? null,
      aiDescription: body.aiDescription ?? null,
      aiConfidence: body.aiConfidence ?? 70,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  if (!row) return error.internal(c, 'Failed to create label');

  publishEntityEvent({
    c,
    entityType: 'mail_label',
    entityId: row.id,
    action: 'created',
    data: { id: row.id, accountId: row.accountId, name: row.name },
  });

  return success(c, row, 201);
});

export default app;
