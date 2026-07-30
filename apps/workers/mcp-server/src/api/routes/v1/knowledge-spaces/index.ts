import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { schema } from '../../../db';
import type { HonoEnv } from '../../../types';
import { requireScope } from '../../../lib/scopes';
import { generateId } from '../../../lib/id';
import { error, list, noContent, success, cursorPagination } from '../../../lib/response';
import {
  createKnowledgeSpaceSchema,
  updateKnowledgeSpaceSchema,
} from '@weldsuite/core-api-client/schemas/knowledge';

const spaces = schema.knowledgeSpaces;
const pages = schema.knowledgePages;
const app = new Hono<HonoEnv>();

/**
 * Private spaces are only visible to their creator. Workspace API keys have
 * no user identity, so they never see private spaces.
 */
function canAccessSpace(
  space: { visibility: string; createdBy: string | null },
  userId: string | null | undefined,
): boolean {
  return space.visibility !== 'private' || (!!userId && space.createdBy === userId);
}

app.get('/', requireScope('knowledge:read'), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('apiSession').userId;
  const rows = await db
    .select()
    .from(spaces)
    .where(isNull(spaces.deletedAt))
    .orderBy(asc(spaces.sortOrder), asc(spaces.createdAt));
  const visible = rows.filter((s) => canAccessSpace(s, userId));
  return list(c, visible, cursorPagination(visible.length, false, null));
});

app.get('/:id', requireScope('knowledge:read'), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('apiSession').userId;
  const id = c.req.param('id');
  const [row] = await db
    .select()
    .from(spaces)
    .where(and(eq(spaces.id, id), isNull(spaces.deletedAt)))
    .limit(1);
  if (!row || !canAccessSpace(row, userId)) return error.notFound(c, 'Knowledge space', id);
  return success(c, row);
});

app.post('/', requireScope('knowledge:write'), zValidator('json', createKnowledgeSpaceSchema), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('apiSession').userId;
  const body = c.req.valid('json');
  const id = generateId('kspc');
  const now = new Date();

  let sortOrder = body.sortOrder;
  if (sortOrder === undefined) {
    const [row] = await db
      .select({ max: sql<number>`coalesce(max(${spaces.sortOrder}), -1)` })
      .from(spaces)
      .where(isNull(spaces.deletedAt));
    sortOrder = Number(row?.max ?? -1) + 1;
  }

  const [row] = await db
    .insert(spaces)
    .values({
      id,
      name: body.name,
      description: body.description ?? null,
      icon: body.icon ?? null,
      color: body.color ?? null,
      visibility: body.visibility ?? 'workspace',
      sortOrder,
      createdBy: userId ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  if (!row) return error.internal(c, 'Failed to create knowledge space');
  publishEntityEvent({ c, entityType: 'knowledge_space', entityId: id, action: 'created', data: { id, name: row.name } });
  return success(c, row, 201);
});

app.patch('/:id', requireScope('knowledge:write'), zValidator('json', updateKnowledgeSpaceSchema), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('apiSession').userId;
  const id = c.req.param('id');
  const body = c.req.valid('json');

  const [existing] = await db
    .select()
    .from(spaces)
    .where(and(eq(spaces.id, id), isNull(spaces.deletedAt)))
    .limit(1);
  if (!existing || !canAccessSpace(existing, userId)) return error.notFound(c, 'Knowledge space', id);

  const update: Record<string, unknown> = { updatedAt: new Date() };
  for (const key of ['name', 'description', 'icon', 'color', 'visibility', 'sortOrder'] as const) {
    if (body[key] !== undefined) update[key] = body[key];
  }
  const [row] = await db.update(spaces).set(update).where(eq(spaces.id, id)).returning();
  if (!row) return error.notFound(c, 'Knowledge space', id);
  publishEntityEvent({ c, entityType: 'knowledge_space', entityId: id, action: 'updated', data: { id, name: row.name } });
  return success(c, row);
});

app.delete('/:id', requireScope('knowledge:write'), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('apiSession').userId;
  const id = c.req.param('id');

  const [existing] = await db
    .select()
    .from(spaces)
    .where(and(eq(spaces.id, id), isNull(spaces.deletedAt)))
    .limit(1);
  if (!existing || !canAccessSpace(existing, userId)) return error.notFound(c, 'Knowledge space', id);

  const now = new Date();
  await db.update(spaces).set({ deletedAt: now, updatedAt: now }).where(eq(spaces.id, id));
  // Soft-delete every live page in the space so they surface in the platform trash.
  await db
    .update(pages)
    .set({ deletedAt: now, updatedAt: now })
    .where(and(eq(pages.spaceId, id), isNull(pages.deletedAt)));
  publishEntityEvent({ c, entityType: 'knowledge_space', entityId: id, action: 'deleted', data: { id } });
  return noContent(c);
});

export default app;
