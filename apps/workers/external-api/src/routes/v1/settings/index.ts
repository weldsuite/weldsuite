import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { eq, isNull } from 'drizzle-orm';
import { schema } from '../../../db';
import type { HonoEnv } from '../../../types';
import { requireScope } from '../../../lib/scopes';
import { error, list, success, cursorPagination } from '../../../lib/response';
import { listWithCursor } from '../../../lib/list-helpers';

const listMembersQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().min(1).max(200).optional(),
});

const app = new Hono<HonoEnv>();

app.get('/workspace', requireScope('settings:read'), async (c) => {
  const db = c.get('tenantDb');
  const rows = await db
    .select()
    .from(schema.workspaceSettings)
    .where(isNull(schema.workspaceSettings.deletedAt))
    .limit(1);
  return success(c, rows[0] ?? null);
});

app.get('/members', requireScope('members:read'), zValidator('query', listMembersQuery), async (c) => {
  const db = c.get('tenantDb');
  const q = c.req.valid('query');
  const result = await listWithCursor({
    db,
    table: schema.workspaceMembers,
    cursor: q.cursor,
    limit: q.limit,
  });
  return list(c, result.data as Record<string, unknown>[], cursorPagination(result.totalCount, result.hasMore, result.cursor));
});

app.get('/members/:id', requireScope('members:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const [row] = await db
    .select()
    .from(schema.workspaceMembers)
    .where(eq(schema.workspaceMembers.id, id))
    .limit(1);
  if (!row) return error.notFound(c, 'Member', id);
  return success(c, row);
});

export default app;
