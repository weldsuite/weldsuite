/**
 * Knowledge routes — /api/knowledge/* backing the WeldKnow workspace wiki.
 *
 * Surface: teamspaces + each person's private space (CRUD, members, join,
 * leave), nested pages (tree metadata / detail / create / metadata patch /
 * content autosave / move / soft-delete subtree / trash / restore), throttled
 * version history, and per-user favorites.
 *
 * Two layers of access, both required:
 *   - workspace permissions: knowledge:read | create | update | delete, plus
 *     knowledge:manage to see and fix every teamspace;
 *   - teamspace membership, resolved in @weldsuite/know-domain/access (viewer
 *     reads, editor writes, owner manages; open teamspaces are readable by all).
 */

import { Hono, type Context } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, asc, desc, eq, inArray, isNull, isNotNull, sql } from 'drizzle-orm';
import { hasContextPermission, requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import {
  createKnowledgeSpaceSchema,
  updateKnowledgeSpaceSchema,
  addKnowledgeSpaceMemberSchema,
  updateKnowledgeSpaceMemberSchema,
  createKnowledgePageSchema,
  updateKnowledgePageSchema,
  saveKnowledgePageContentSchema,
  moveKnowledgePageSchema,
  createKnowledgePageVersionSchema,
  addKnowledgeFavoriteSchema,
} from '@weldsuite/core-api-client/schemas/knowledge';
import type { Env, Variables } from '../../types';
import { error, list, noContent, success } from '@weldsuite/worker-kit/response';
import { generateId } from '@weldsuite/worker-kit/id';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import {
  createPageVersion,
  getPageVersion,
  listPageVersions,
  maybeAutoSnapshotPage,
} from '../../services/knowledge-versions';
import {
  SpaceAccessError,
  SpaceConflictError,
  SpaceNotFoundError,
  addEveryoneToSpace,
  addSpaceMember,
  assertCanManage,
  assertCanWrite,
  ensurePersonalSpace,
  joinDefaultSpaces,
  joinSpace,
  listSpaceMembers,
  listSpaces,
  listTeammates,
  readableSpaceIds,
  removeSpaceMember,
  requireSpace,
  setSpaceMemberRole,
  writableSpaceIds,
  type SpaceAccess,
} from '@weldsuite/know-domain/access';

type KnowledgeEnv = { Bindings: Env; Variables: Variables };
type KnowledgeContext = Context<KnowledgeEnv>;

const app = new Hono<KnowledgeEnv>();
const spaces = schema.knowledgeSpaces;
const pages = schema.knowledgePages;
const favorites = schema.knowledgeFavorites;

/** Map the access service's errors onto the response envelope. */
function accessError(c: KnowledgeContext, err: unknown, fallback: string) {
  if (err instanceof SpaceNotFoundError) return error.notFound(c, err.resource, err.id);
  if (err instanceof SpaceAccessError) return error.forbidden(c, err.message);
  if (err instanceof SpaceConflictError) return error.conflict(c, err.message);
  console.error(`[know-api/knowledge] ${fallback}:`, err);
  return error.internal(c, fallback);
}

const canManageAll = (c: KnowledgeContext) => hasContextPermission(c, 'knowledge:manage');

/** The `:id` space, resolved for this caller. */
async function spaceFor(c: KnowledgeContext, spaceId: string): Promise<SpaceAccess> {
  return requireSpace(c.get('tenantDb'), c.get('userId'), spaceId, { canManageAll: await canManageAll(c) });
}

/**
 * Load a live page plus the caller's access to its space. A page in a space
 * the caller cannot read is reported as missing.
 */
async function loadPage(db: Database, id: string, userId: string) {
  const [page] = await db
    .select()
    .from(pages)
    .where(and(eq(pages.id, id), isNull(pages.deletedAt)))
    .limit(1);
  if (!page) throw new SpaceNotFoundError('Page', id);
  let access: SpaceAccess;
  try {
    access = await requireSpace(db, userId, page.spaceId);
  } catch (err) {
    if (err instanceof SpaceNotFoundError) throw new SpaceNotFoundError('Page', id);
    throw err;
  }
  if (!access.canRead) throw new SpaceNotFoundError('Page', id);
  return { page, access };
}

/** A page the caller may write: readable, and they have the editor role. */
async function loadWritablePage(db: Database, id: string, userId: string) {
  const loaded = await loadPage(db, id, userId);
  assertCanWrite(loaded.access);
  return loaded;
}

/** A space the caller may add pages to. */
async function writableSpace(db: Database, spaceId: string, userId: string) {
  const access = await requireSpace(db, userId, spaceId);
  assertCanWrite(access);
  return access;
}

/** Next sibling position under a parent (append semantics). */
async function nextPosition(db: Database, spaceId: string, parentId: string | null) {
  const [row] = await db
    .select({ max: sql<number>`coalesce(max(${pages.position}), -1)` })
    .from(pages)
    .where(
      and(
        eq(pages.spaceId, spaceId),
        parentId === null ? isNull(pages.parentId) : eq(pages.parentId, parentId),
        isNull(pages.deletedAt),
      ),
    );
  return Number(row?.max ?? -1) + 1;
}

/** Collect the ids of a page and all its live descendants (BFS). */
async function collectSubtreeIds(db: Database, rootId: string): Promise<string[]> {
  const all: string[] = [rootId];
  let frontier = [rootId];
  while (frontier.length > 0) {
    const children = await db
      .select({ id: pages.id })
      .from(pages)
      .where(and(inArray(pages.parentId, frontier), isNull(pages.deletedAt)));
    frontier = children.map((r) => r.id);
    all.push(...frontier);
  }
  return all;
}

/** True when `candidateAncestorId` is `pageId` itself or one of its descendants — i.e. moving there would create a cycle. */
async function wouldCreateCycle(db: Database, pageId: string, newParentId: string) {
  if (pageId === newParentId) return true;
  // Walk up from the new parent; if we hit the page being moved, it's a cycle.
  let current: string | null = newParentId;
  const seen = new Set<string>();
  while (current) {
    if (current === pageId) return true;
    if (seen.has(current)) return true; // defensive: corrupt tree
    seen.add(current);
    const [row] = await db
      .select({ parentId: pages.parentId })
      .from(pages)
      .where(eq(pages.id, current))
      .limit(1);
    current = row?.parentId ?? null;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Spaces
// ---------------------------------------------------------------------------

/**
 * Every space the caller can see, with what they may do in each. Creates their
 * personal space on first use and adds them to default teamspaces they have
 * never been in.
 */
app.get('/spaces', requirePermission('knowledge:read'), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  try {
    if (await hasContextPermission(c, 'knowledge:create')) await ensurePersonalSpace(db, userId);
    await joinDefaultSpaces(db, userId);
    const rows = await listSpaces(db, userId, { canManageAll: await canManageAll(c) });
    return list(c, rows, { totalCount: rows.length, hasMore: false, cursor: null });
  } catch (err) {
    return accessError(c, err, 'Failed to list spaces');
  }
});

app.post('/spaces', requirePermission('knowledge:create'), zValidator('json', createKnowledgeSpaceSchema), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const data = c.req.valid('json');
  const id = generateId('kspc');
  const now = new Date();
  try {
    if (data.isDefault && !(await canManageAll(c))) {
      return error.forbidden(c, 'Only workspace admins can make a teamspace default.');
    }
    let sortOrder = data.sortOrder;
    if (sortOrder === undefined) {
      const [row] = await db
        .select({ max: sql<number>`coalesce(max(${spaces.sortOrder}), -1)` })
        .from(spaces)
        .where(isNull(spaces.deletedAt));
      sortOrder = Number(row?.max ?? -1) + 1;
    }
    await db.insert(spaces).values({
      id,
      name: data.name,
      description: data.description ?? null,
      icon: data.icon ?? null,
      color: data.color ?? null,
      kind: 'team',
      visibility: data.visibility ?? 'open',
      isDefault: data.isDefault ?? false,
      sortOrder,
      createdBy: userId,
      createdAt: now,
      updatedAt: now,
    });
    // The creator is the teamspace's first owner.
    await addSpaceMember(db, id, { userId, role: 'owner', addedBy: userId });
    if (data.isDefault) await addEveryoneToSpace(db, id, userId);

    publishEntityEvent({ c, entityType: 'knowledge_space', entityId: id, action: 'created', data: { id, name: data.name } });
    const [row] = await db.select().from(spaces).where(eq(spaces.id, id)).limit(1);
    return success(c, row, 201);
  } catch (err) {
    return accessError(c, err, 'Failed to create space');
  }
});

app.patch('/spaces/:id', requirePermission('knowledge:update'), zValidator('json', updateKnowledgeSpaceSchema), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const id = c.req.param('id');
  const data = c.req.valid('json');
  try {
    const access = await spaceFor(c, id);
    assertCanManage(access);
    const turnsDefaultOn = data.isDefault === true && !access.space.isDefault;
    if (data.isDefault !== undefined && data.isDefault !== access.space.isDefault && !(await canManageAll(c))) {
      return error.forbidden(c, 'Only workspace admins can change which teamspaces are default.');
    }

    const update: Record<string, unknown> = { updatedAt: new Date() };
    for (const key of ['name', 'description', 'icon', 'color', 'visibility', 'isDefault', 'sortOrder'] as const) {
      if (data[key] !== undefined) update[key] = data[key];
    }
    await db.update(spaces).set(update).where(eq(spaces.id, id));
    if (turnsDefaultOn) await addEveryoneToSpace(db, id, userId);

    publishEntityEvent({ c, entityType: 'knowledge_space', entityId: id, action: 'updated', data: { id, name: (update.name as string | undefined) ?? access.space.name } });
    const [row] = await db.select().from(spaces).where(eq(spaces.id, id)).limit(1);
    return success(c, row);
  } catch (err) {
    return accessError(c, err, 'Failed to update space');
  }
});

app.delete('/spaces/:id', requirePermission('knowledge:delete'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const access = await spaceFor(c, id);
    assertCanManage(access);

    const now = new Date();
    await db.update(spaces).set({ deletedAt: now, updatedAt: now }).where(eq(spaces.id, id));
    // Soft-delete every live page in the space so they surface in trash.
    await db
      .update(pages)
      .set({ deletedAt: now, updatedAt: now })
      .where(and(eq(pages.spaceId, id), isNull(pages.deletedAt)));
    publishEntityEvent({ c, entityType: 'knowledge_space', entityId: id, action: 'deleted', data: { id } });
    return noContent(c);
  } catch (err) {
    return accessError(c, err, 'Failed to delete space');
  }
});

// ---------------------------------------------------------------------------
// Teamspace members
// ---------------------------------------------------------------------------

/** People a teamspace can be shared with. */
app.get('/teammates', requirePermission('knowledge:read'), async (c) => {
  try {
    const rows = await listTeammates(c.get('tenantDb'));
    return list(c, rows, { totalCount: rows.length, hasMore: false, cursor: null });
  } catch (err) {
    return accessError(c, err, 'Failed to list teammates');
  }
});

/** Anyone who can see a teamspace can see who is in it, and so who to ask. */
app.get('/spaces/:id/members', requirePermission('knowledge:read'), async (c) => {
  const id = c.req.param('id');
  try {
    const access = await spaceFor(c, id);
    if (access.space.kind === 'personal') return list(c, [], { totalCount: 0, hasMore: false, cursor: null });
    const rows = await listSpaceMembers(c.get('tenantDb'), id);
    return list(c, rows, { totalCount: rows.length, hasMore: false, cursor: null });
  } catch (err) {
    return accessError(c, err, 'Failed to list members');
  }
});

/** Add a teammate, or change their role if they are already in. Owners only. */
app.post('/spaces/:id/members', requirePermission('knowledge:read'), zValidator('json', addKnowledgeSpaceMemberSchema), async (c) => {
  const id = c.req.param('id');
  const data = c.req.valid('json');
  try {
    const access = await spaceFor(c, id);
    assertCanManage(access);
    const { created } = await addSpaceMember(c.get('tenantDb'), id, {
      userId: data.userId,
      role: data.role,
      addedBy: c.get('userId'),
    });
    publishEntityEvent({
      c,
      entityType: 'knowledge_space_member',
      entityId: id,
      action: created ? 'added' : 'updated',
      data: { spaceId: id, userId: data.userId, role: data.role },
    });
    return success(c, { spaceId: id, userId: data.userId, role: data.role }, created ? 201 : 200);
  } catch (err) {
    return accessError(c, err, 'Failed to add member');
  }
});

app.patch('/spaces/:id/members/:userId', requirePermission('knowledge:read'), zValidator('json', updateKnowledgeSpaceMemberSchema), async (c) => {
  const id = c.req.param('id');
  const memberId = c.req.param('userId');
  const { role } = c.req.valid('json');
  try {
    const access = await spaceFor(c, id);
    assertCanManage(access);
    await setSpaceMemberRole(c.get('tenantDb'), id, memberId, role);
    publishEntityEvent({ c, entityType: 'knowledge_space_member', entityId: id, action: 'updated', data: { spaceId: id, userId: memberId, role } });
    return success(c, { spaceId: id, userId: memberId, role });
  } catch (err) {
    return accessError(c, err, 'Failed to change member role');
  }
});

/** Remove a member. Owners (and admins) remove anyone; anyone may remove themselves. */
app.delete('/spaces/:id/members/:userId', requirePermission('knowledge:read'), async (c) => {
  const id = c.req.param('id');
  const memberId = c.req.param('userId');
  try {
    const access = await spaceFor(c, id);
    if (memberId !== c.get('userId')) assertCanManage(access);
    await removeSpaceMember(c.get('tenantDb'), id, memberId);
    publishEntityEvent({ c, entityType: 'knowledge_space_member', entityId: id, action: 'removed', data: { spaceId: id, userId: memberId } });
    return noContent(c);
  } catch (err) {
    return accessError(c, err, 'Failed to remove member');
  }
});

/** Join an open teamspace as an editor. Admins holding knowledge:manage may join any teamspace. */
app.post('/spaces/:id/join', requirePermission('knowledge:read'), async (c) => {
  const userId = c.get('userId');
  const id = c.req.param('id');
  try {
    const access = await spaceFor(c, id);
    if (access.role) return success(c, { spaceId: id, userId, role: access.role });
    await joinSpace(c.get('tenantDb'), access, userId);
    publishEntityEvent({ c, entityType: 'knowledge_space_member', entityId: id, action: 'added', data: { spaceId: id, userId, role: 'editor' } });
    return success(c, { spaceId: id, userId, role: 'editor' });
  } catch (err) {
    return accessError(c, err, 'Failed to join teamspace');
  }
});

/** Leave a teamspace. The last owner has to hand over first. */
app.post('/spaces/:id/leave', requirePermission('knowledge:read'), async (c) => {
  const userId = c.get('userId');
  const id = c.req.param('id');
  try {
    await spaceFor(c, id);
    await removeSpaceMember(c.get('tenantDb'), id, userId);
    publishEntityEvent({ c, entityType: 'knowledge_space_member', entityId: id, action: 'removed', data: { spaceId: id, userId } });
    return noContent(c);
  } catch (err) {
    return accessError(c, err, 'Failed to leave teamspace');
  }
});

// ---------------------------------------------------------------------------
// Pages — tree, trash, detail, CRUD
// ---------------------------------------------------------------------------

/** Tree metadata for the sidebar — no content payloads. */
app.get('/pages/tree', requirePermission('knowledge:read'), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const spaceIdFilter = c.req.query('spaceId');
  try {
    const spaceIds = await readableSpaceIds(db, userId);
    const scope = spaceIdFilter ? spaceIds.filter((s) => s === spaceIdFilter) : spaceIds;
    if (scope.length === 0) return list(c, [], { totalCount: 0, hasMore: false, cursor: null });

    const rows = await db
      .select({
        id: pages.id,
        spaceId: pages.spaceId,
        parentId: pages.parentId,
        position: pages.position,
        title: pages.title,
        icon: pages.icon,
        updatedAt: pages.updatedAt,
      })
      .from(pages)
      .where(and(inArray(pages.spaceId, scope), isNull(pages.deletedAt)))
      .orderBy(asc(pages.position), asc(pages.createdAt));
    return list(c, rows, { totalCount: rows.length, hasMore: false, cursor: null });
  } catch (err) {
    console.error('[app-api/knowledge] page tree failed:', err);
    return error.internal(c, 'Failed to load page tree');
  }
});

/** Soft-deleted pages in spaces the caller can write to (and so restore in), newest first. */
app.get('/trash', requirePermission('knowledge:read'), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  try {
    const spaceIds = await writableSpaceIds(db, userId);
    if (spaceIds.length === 0) return list(c, [], { totalCount: 0, hasMore: false, cursor: null });
    const rows = await db
      .select({
        id: pages.id,
        spaceId: pages.spaceId,
        parentId: pages.parentId,
        title: pages.title,
        icon: pages.icon,
        deletedAt: pages.deletedAt,
      })
      .from(pages)
      .where(and(inArray(pages.spaceId, spaceIds), isNotNull(pages.deletedAt)))
      .orderBy(desc(pages.deletedAt))
      .limit(200);
    return list(c, rows, { totalCount: rows.length, hasMore: false, cursor: null });
  } catch (err) {
    console.error('[app-api/knowledge] trash failed:', err);
    return error.internal(c, 'Failed to load trash');
  }
});

app.get('/pages/:id', requirePermission('knowledge:read'), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const id = c.req.param('id');
  try {
    const { page } = await loadPage(db, id, userId);
    return success(c, page);
  } catch (err) {
    return accessError(c, err, 'Failed to fetch page');
  }
});

app.post('/pages', requirePermission('knowledge:create'), zValidator('json', createKnowledgePageSchema), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const data = c.req.valid('json');
  const id = generateId('kpag');
  const now = new Date();
  try {
    await writableSpace(db, data.spaceId, userId);

    if (data.parentId) {
      const { page: parent } = await loadPage(db, data.parentId, userId);
      if (parent.spaceId !== data.spaceId) {
        return error.badRequest(c, 'Parent page belongs to a different space');
      }
    }

    const position = await nextPosition(db, data.spaceId, data.parentId ?? null);
    await db.insert(pages).values({
      id,
      spaceId: data.spaceId,
      parentId: data.parentId ?? null,
      position,
      title: data.title && data.title.length > 0 ? data.title : 'Untitled',
      icon: data.icon ?? null,
      coverImage: data.coverImage ?? null,
      contentJson: data.contentJson ?? [],
      contentText: '',
      createdBy: userId,
      lastEditedBy: userId,
      createdAt: now,
      updatedAt: now,
    });
    publishEntityEvent({ c, entityType: 'knowledge_page', entityId: id, action: 'created', data: { id, spaceId: data.spaceId, parentId: data.parentId ?? null, title: data.title ?? 'Untitled' } });
    const [row] = await db.select().from(pages).where(eq(pages.id, id)).limit(1);
    return success(c, row, 201);
  } catch (err) {
    return accessError(c, err, 'Failed to create page');
  }
});

app.patch('/pages/:id', requirePermission('knowledge:update'), zValidator('json', updateKnowledgePageSchema), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const id = c.req.param('id');
  const data = c.req.valid('json');
  try {
    const { page } = await loadWritablePage(db, id, userId);

    const update: Record<string, unknown> = { updatedAt: new Date(), lastEditedBy: userId };
    for (const key of ['title', 'icon', 'coverImage', 'isLocked'] as const) {
      if (data[key] !== undefined) update[key] = data[key];
    }
    await db.update(pages).set(update).where(eq(pages.id, id));
    publishEntityEvent({ c, entityType: 'knowledge_page', entityId: id, action: 'updated', data: { id, spaceId: page.spaceId, title: (update.title as string | undefined) ?? page.title } });
    const [row] = await db.select().from(pages).where(eq(pages.id, id)).limit(1);
    return success(c, row);
  } catch (err) {
    return accessError(c, err, 'Failed to update page');
  }
});

/** Autosave content. Locked pages reject edits. */
app.put('/pages/:id/content', requirePermission('knowledge:update'), zValidator('json', saveKnowledgePageContentSchema), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const id = c.req.param('id');
  const data = c.req.valid('json');
  try {
    const { page } = await loadWritablePage(db, id, userId);
    if (page.isLocked) return error.conflict(c, 'Page is locked');

    await db
      .update(pages)
      .set({
        contentJson: data.contentJson as Record<string, unknown>[],
        contentText: data.contentText ?? page.contentText,
        lastEditedBy: userId,
        updatedAt: new Date(),
      })
      .where(eq(pages.id, id));
    await maybeAutoSnapshotPage(db, id, data.contentJson as Record<string, unknown>[], userId);
    publishEntityEvent({ c, entityType: 'knowledge_page', entityId: id, action: 'updated', data: { id, spaceId: page.spaceId, title: page.title } });
    return success(c, { id });
  } catch (err) {
    return accessError(c, err, 'Failed to save page content');
  }
});

/** Re-parent / reorder / move-to-space. Moving a page moves its whole subtree. */
app.post('/pages/:id/move', requirePermission('knowledge:update'), zValidator('json', moveKnowledgePageSchema), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const id = c.req.param('id');
  const data = c.req.valid('json');
  try {
    const { page } = await loadWritablePage(db, id, userId);

    const targetSpaceId = data.spaceId ?? page.spaceId;
    if (targetSpaceId !== page.spaceId) await writableSpace(db, targetSpaceId, userId);

    if (data.parentId) {
      const { page: parent } = await loadPage(db, data.parentId, userId);
      if (parent.spaceId !== targetSpaceId) {
        return error.badRequest(c, 'Parent page belongs to a different space');
      }
      if (await wouldCreateCycle(db, id, data.parentId)) {
        return error.badRequest(c, 'Cannot move a page under itself or one of its sub-pages');
      }
    }

    const position = data.position ?? (await nextPosition(db, targetSpaceId, data.parentId ?? null));
    const now = new Date();
    await db
      .update(pages)
      .set({ parentId: data.parentId, spaceId: targetSpaceId, position, lastEditedBy: userId, updatedAt: now })
      .where(eq(pages.id, id));

    // A cross-space move carries the whole subtree along.
    if (targetSpaceId !== page.spaceId) {
      const subtree = await collectSubtreeIds(db, id);
      const descendants = subtree.filter((sid) => sid !== id);
      if (descendants.length > 0) {
        await db.update(pages).set({ spaceId: targetSpaceId, updatedAt: now }).where(inArray(pages.id, descendants));
      }
    }

    publishEntityEvent({ c, entityType: 'knowledge_page', entityId: id, action: 'moved', data: { id, spaceId: targetSpaceId, parentId: data.parentId, position } });
    const [row] = await db.select().from(pages).where(eq(pages.id, id)).limit(1);
    return success(c, row);
  } catch (err) {
    return accessError(c, err, 'Failed to move page');
  }
});

/** Soft-delete a page and its whole subtree (recoverable from trash). */
app.delete('/pages/:id', requirePermission('knowledge:delete'), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const id = c.req.param('id');
  try {
    const { page } = await loadWritablePage(db, id, userId);

    const subtree = await collectSubtreeIds(db, id);
    const now = new Date();
    await db.update(pages).set({ deletedAt: now, updatedAt: now }).where(inArray(pages.id, subtree));
    publishEntityEvent({ c, entityType: 'knowledge_page', entityId: id, action: 'deleted', data: { id, spaceId: page.spaceId } });
    return noContent(c);
  } catch (err) {
    return accessError(c, err, 'Failed to delete page');
  }
});

/** Restore a trashed page (and its trashed descendants). Re-roots when the old parent is gone. */
app.post('/pages/:id/restore', requirePermission('knowledge:update'), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const id = c.req.param('id');
  try {
    const [page] = await db
      .select()
      .from(pages)
      .where(and(eq(pages.id, id), isNotNull(pages.deletedAt)))
      .limit(1);
    if (!page) return error.notFound(c, 'Page', id);
    const [space] = await db
      .select({ id: spaces.id })
      .from(spaces)
      .where(and(eq(spaces.id, page.spaceId), isNull(spaces.deletedAt)))
      .limit(1);
    if (!space) return error.conflict(c, 'The space this page belonged to no longer exists');
    try {
      await writableSpace(db, page.spaceId, userId);
    } catch (err) {
      if (err instanceof SpaceNotFoundError) return error.notFound(c, 'Page', id);
      throw err;
    }

    // Restore the page plus its deleted descendants (BFS over deleted rows).
    const toRestore: string[] = [id];
    let frontier = [id];
    while (frontier.length > 0) {
      const children = await db
        .select({ id: pages.id })
        .from(pages)
        .where(and(inArray(pages.parentId, frontier), isNotNull(pages.deletedAt)));
      frontier = children.map((r) => r.id);
      toRestore.push(...frontier);
    }

    const now = new Date();
    // If the original parent is gone (still deleted), re-root at the space top level.
    let parentId = page.parentId;
    if (parentId) {
      const [parent] = await db
        .select({ id: pages.id })
        .from(pages)
        .where(and(eq(pages.id, parentId), isNull(pages.deletedAt)))
        .limit(1);
      if (!parent) parentId = null;
    }

    await db.update(pages).set({ deletedAt: null, updatedAt: now }).where(inArray(pages.id, toRestore));
    await db
      .update(pages)
      .set({ parentId, position: await nextPosition(db, page.spaceId, parentId), updatedAt: now })
      .where(eq(pages.id, id));

    publishEntityEvent({ c, entityType: 'knowledge_page', entityId: id, action: 'restored', data: { id, spaceId: page.spaceId } });
    const [row] = await db.select().from(pages).where(eq(pages.id, id)).limit(1);
    return success(c, row);
  } catch (err) {
    return accessError(c, err, 'Failed to restore page');
  }
});

// ---------------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------------

app.get('/pages/:id/versions', requirePermission('knowledge:read'), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const id = c.req.param('id');
  try {
    await loadPage(db, id, userId);
    const rows = await listPageVersions(db, id);
    return list(c, rows, { totalCount: rows.length, hasMore: false, cursor: null });
  } catch (err) {
    return accessError(c, err, 'Failed to list versions');
  }
});

app.post('/pages/:id/versions', requirePermission('knowledge:update'), zValidator('json', createKnowledgePageVersionSchema), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const id = c.req.param('id');
  const data = c.req.valid('json');
  try {
    const { page } = await loadWritablePage(db, id, userId);
    const row = await createPageVersion(db, id, page.contentJson ?? [], userId, data.label ?? null);
    return success(c, row, 201);
  } catch (err) {
    return accessError(c, err, 'Failed to create version');
  }
});

app.get('/pages/:id/versions/:versionId', requirePermission('knowledge:read'), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const id = c.req.param('id');
  const versionId = c.req.param('versionId');
  try {
    await loadPage(db, id, userId);
    const row = await getPageVersion(db, id, versionId);
    if (!row) return error.notFound(c, 'Version', versionId);
    return success(c, row);
  } catch (err) {
    return accessError(c, err, 'Failed to fetch version');
  }
});

/** Restore a snapshot onto the live page, keeping a pre-restore backup version. */
app.post('/pages/:id/versions/:versionId/restore', requirePermission('knowledge:update'), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const id = c.req.param('id');
  const versionId = c.req.param('versionId');
  try {
    const { page } = await loadWritablePage(db, id, userId);
    if (page.isLocked) return error.conflict(c, 'Page is locked');
    const version = await getPageVersion(db, id, versionId);
    if (!version) return error.notFound(c, 'Version', versionId);

    await createPageVersion(db, id, page.contentJson ?? [], userId, 'Before restore');
    await db
      .update(pages)
      .set({ contentJson: version.content, lastEditedBy: userId, updatedAt: new Date() })
      .where(eq(pages.id, id));
    publishEntityEvent({ c, entityType: 'knowledge_page', entityId: id, action: 'updated', data: { id, spaceId: page.spaceId, title: page.title } });
    const [row] = await db.select().from(pages).where(eq(pages.id, id)).limit(1);
    return success(c, row);
  } catch (err) {
    return accessError(c, err, 'Failed to restore version');
  }
});

// ---------------------------------------------------------------------------
// Favorites (always scoped to the authenticated user)
// ---------------------------------------------------------------------------

/** Favorites in spaces the caller can still read — leaving a teamspace hides its pages here too. */
app.get('/favorites', requirePermission('knowledge:read'), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  try {
    const spaceIds = await readableSpaceIds(db, userId);
    if (spaceIds.length === 0) return list(c, [], { totalCount: 0, hasMore: false, cursor: null });
    const rows = await db
      .select({
        id: favorites.id,
        pageId: favorites.pageId,
        position: favorites.position,
        title: pages.title,
        icon: pages.icon,
        spaceId: pages.spaceId,
      })
      .from(favorites)
      .innerJoin(pages, eq(favorites.pageId, pages.id))
      .where(and(eq(favorites.userId, userId), isNull(pages.deletedAt), inArray(pages.spaceId, spaceIds)))
      .orderBy(asc(favorites.position), asc(favorites.createdAt));
    return list(c, rows, { totalCount: rows.length, hasMore: false, cursor: null });
  } catch (err) {
    return accessError(c, err, 'Failed to list favorites');
  }
});

app.post('/favorites', requirePermission('knowledge:read'), zValidator('json', addKnowledgeFavoriteSchema), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const { pageId } = c.req.valid('json');
  try {
    await loadPage(db, pageId, userId);
    const [existing] = await db
      .select({ id: favorites.id })
      .from(favorites)
      .where(and(eq(favorites.pageId, pageId), eq(favorites.userId, userId)))
      .limit(1);
    if (existing) return success(c, { id: existing.id, pageId });

    const [posRow] = await db
      .select({ max: sql<number>`coalesce(max(${favorites.position}), -1)` })
      .from(favorites)
      .where(eq(favorites.userId, userId));
    const id = generateId('kfav');
    await db.insert(favorites).values({
      id,
      pageId,
      userId,
      position: Number(posRow?.max ?? -1) + 1,
      createdAt: new Date(),
    });
    return success(c, { id, pageId }, 201);
  } catch (err) {
    return accessError(c, err, 'Failed to add favorite');
  }
});

app.delete('/favorites/:pageId', requirePermission('knowledge:read'), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const pageId = c.req.param('pageId');
  try {
    await db.delete(favorites).where(and(eq(favorites.pageId, pageId), eq(favorites.userId, userId)));
    return noContent(c);
  } catch (err) {
    console.error('[app-api/knowledge] remove favorite failed:', err);
    return error.internal(c, 'Failed to remove favorite');
  }
});

export const knowledgeRoutes = app;
