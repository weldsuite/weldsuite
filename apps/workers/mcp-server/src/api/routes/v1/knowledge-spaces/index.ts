import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, eq, isNull, sql } from 'drizzle-orm';
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
import {
  SpaceNotFoundError,
  addSpaceMember,
  listSpaces,
  requireSpace,
} from '@weldsuite/know-domain/access';

const spaces = schema.knowledgeSpaces;
const pages = schema.knowledgePages;
const app = new Hono<HonoEnv>();

type Db = HonoEnv['Variables']['tenantDb'];

/**
 * Teamspace rules are shared with know-api (@weldsuite/know-domain/access).
 * A workspace API key has no user behind it, so it reaches open teamspaces
 * only — never a closed, private or personal space. A user token follows that
 * user's teamspace memberships.
 */
async function spaceAccess(db: Db, spaceId: string, userId: string | null | undefined) {
  try {
    return await requireSpace(db, userId ?? null, spaceId);
  } catch (err) {
    if (err instanceof SpaceNotFoundError) return null;
    throw err;
  }
}

const DEFAULT_ONLY_IN_APP = 'Default teamspaces are set in WeldKnow by a workspace admin.';
const NOT_OWNER = 'This needs the owner role in the teamspace.';

app.get('/', requireScope('knowledge:read'), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('apiSession').userId;
  const visible = await listSpaces(db, userId ?? null);
  return list(c, visible, cursorPagination(visible.length, false, null));
});

app.get('/:id', requireScope('knowledge:read'), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('apiSession').userId;
  const id = c.req.param('id');
  const access = await spaceAccess(db, id, userId);
  if (!access) return error.notFound(c, 'Knowledge space', id);
  return success(c, access.space);
});

app.post('/', requireScope('knowledge:write'), zValidator('json', createKnowledgeSpaceSchema), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('apiSession').userId;
  const body = c.req.valid('json');
  if (body.isDefault) return error.forbidden(c, DEFAULT_ONLY_IN_APP);
  // A key without a user would create a closed teamspace nobody is in.
  if (!userId && body.visibility && body.visibility !== 'open') {
    return error.badRequest(c, 'An API key can only create open teamspaces.');
  }
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
      kind: 'team',
      visibility: body.visibility ?? 'open',
      sortOrder,
      createdBy: userId ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  if (!row) return error.internal(c, 'Failed to create knowledge space');
  // The creator is the teamspace's first owner.
  if (userId) await addSpaceMember(db, id, { userId, role: 'owner', addedBy: userId });
  publishEntityEvent({ c, entityType: 'knowledge_space', entityId: id, action: 'created', data: { id, name: row.name } });
  return success(c, row, 201);
});

app.patch('/:id', requireScope('knowledge:write'), zValidator('json', updateKnowledgeSpaceSchema), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('apiSession').userId;
  const id = c.req.param('id');
  const body = c.req.valid('json');

  const access = await spaceAccess(db, id, userId);
  if (!access) return error.notFound(c, 'Knowledge space', id);
  if (!access.canManage) return error.forbidden(c, NOT_OWNER);
  if (body.isDefault !== undefined && body.isDefault !== access.space.isDefault) {
    return error.forbidden(c, DEFAULT_ONLY_IN_APP);
  }
  if (!userId && body.visibility && body.visibility !== 'open') {
    return error.badRequest(c, 'An API key cannot close a teamspace off; an owner does that in WeldKnow.');
  }

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

  const access = await spaceAccess(db, id, userId);
  if (!access) return error.notFound(c, 'Knowledge space', id);
  if (!access.canManage) return error.forbidden(c, NOT_OWNER);

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
