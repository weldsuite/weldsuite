/**
 * Mail accounts — read-only.
 *
 * Exists so the other mail tools have something to scope to: every message,
 * label and draft hangs off an `accountId`, and a caller that cannot list its
 * mailboxes cannot use any of them. Creating and configuring accounts stays in
 * the platform UI, so there is no write surface here.
 *
 * The column projection is explicit and deliberate — `mail_accounts` holds
 * `accessToken`, `refreshToken`, `apiKey` and `passwordHash`, none of which may
 * ever reach a tool result. A `select()` here would leak all four.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { and, eq, ilike, isNull, or, type SQL } from 'drizzle-orm';
import { schema } from '../../../db';
import type { HonoEnv } from '../../../types';
import { requireScope } from '../../../lib/scopes';
import { error, list, success, cursorPagination } from '../../../lib/response';
import { listWithCursor } from '../../../lib/list-helpers';
import { accountScopeCondition, accessibleAccountIds, checkAccountAccess } from '../../../lib/mail-access';

const listQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().min(1).max(200).optional(),
  search: z.string().optional(),
  status: z.string().optional(),
});

const table = schema.mailAccounts;

/** Safe subset of `mail_accounts` — never the credential columns. */
function publicAccount(row: typeof table.$inferSelect) {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    displayName: row.displayName,
    provider: row.provider,
    status: row.status,
    isDefault: row.isDefault,
    isShared: row.isShared,
    syncEnabled: row.syncEnabled,
    syncStatus: row.syncStatus,
    lastSyncAt: row.lastSyncAt,
    createdAt: row.createdAt,
  };
}

const app = new Hono<HonoEnv>();

app.get('/', requireScope('accounts:read'), zValidator('query', listQuery), async (c) => {
  const db = c.get('tenantDb');
  const q = c.req.valid('query');

  const where: (SQL | undefined)[] = [];
  const scope = accountScopeCondition(table.id, await accessibleAccountIds(db, c.get('userId')));
  if (scope) where.push(scope);
  if (q.search) {
    const term = `%${q.search}%`;
    where.push(or(ilike(table.name, term), ilike(table.email, term), ilike(table.displayName, term)));
  }
  if (q.status) where.push(eq(table.status, q.status as typeof table.$inferSelect.status));

  const result = await listWithCursor<typeof table, typeof table.$inferSelect>({
    db,
    table,
    where,
    cursor: q.cursor,
    limit: q.limit,
    mapRow: publicAccount,
  });
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
  // 404 rather than 403 for an account the caller cannot reach — see
  // `checkAccountAccess`; existence itself is privileged here.
  if (!row || !(await checkAccountAccess(db, id, c.get('userId')))) {
    return error.notFound(c, 'MailAccount', id);
  }
  return success(c, publicAccount(row));
});

export default app;
