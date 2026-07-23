/**
 * Knowledge routes — /api/knowledge/* backing the WeldKnow workspace wiki.
 *
 * Surface: spaces CRUD, nested pages (tree metadata / detail / create /
 * metadata patch / content autosave / move / soft-delete subtree / trash /
 * restore), throttled version history, and per-user favorites.
 *
 * Permissions: knowledge:read | knowledge:create | knowledge:update | knowledge:delete.
 * Private spaces (visibility='private') are only visible to their creator.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, asc, desc, eq, inArray, isNull, isNotNull, sql } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import {
  createKnowledgeSpaceSchema,
  updateKnowledgeSpaceSchema,
  createKnowledgePageSchema,
  updateKnowledgePageSchema,
  saveKnowledgePageContentSchema,
  moveKnowledgePageSchema,
  createKnowledgePageVersionSchema,
  addKnowledgeFavoriteSchema,
} from '@weldsuite/core-api-client/schemas/knowledge';
import type { Env, Variables } from '../../types';
import { error, list, noContent, success } from '../../lib/response';
import { generateId } from '../../lib/id';
import { schema, type Database } from '../../db';
import {
  createPageVersion,
  getPageVersion,
  listPageVersions,
  maybeAutoSnapshotPage,
} from '../../services/knowledge-versions';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
const spaces = schema.knowledgeSpaces;
const pages = schema.knowledgePages;
const favorites = schema.knowledgeFavorites;

/** A private space is only accessible to its creator. */
function canAccessSpace(space: { visibility: string; createdBy: string | null }, userId: string) {
  return space.visibility !== 'private' || space.createdBy === userId;
}

/** IDs of all spaces the user may see (workspace spaces + own private spaces). */
async function accessibleSpaceIds(db: Database, userId: string): Promise<string[]> {
  const rows = await db
    .select({ id: spaces.id, visibility: spaces.visibility, createdBy: spaces.createdBy })
    .from(spaces)
    .where(isNull(spaces.deletedAt));
  return rows.filter((s) => canAccessSpace(s, userId)).map((s) => s.id);
}

/** Load a live page and verify the caller may access its space. */
async function loadAccessiblePage(db: Database, id: string, userId: string) {
  const [page] = await db
    .select()
    .from(pages)
    .where(and(eq(pages.id, id), isNull(pages.deletedAt)))
    .limit(1);
  if (!page) return null;
  const [space] = await db.select().from(spaces).where(eq(spaces.id, page.spaceId)).limit(1);
  if (!space || !canAccessSpace(space, userId)) return null;
  return page;
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

app.get('/spaces', requirePermission('knowledge:read'), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  try {
    const rows = await db
      .select()
      .from(spaces)
      .where(isNull(spaces.deletedAt))
      .orderBy(asc(spaces.sortOrder), asc(spaces.createdAt));
    const visible = rows.filter((s) => canAccessSpace(s, userId));
    return list(c, visible, { totalCount: visible.length, hasMore: false, cursor: null });
  } catch (err) {
    console.error('[app-api/knowledge] list spaces failed:', err);
    return error.internal(c, 'Failed to list spaces');
  }
});

app.post('/spaces', requirePermission('knowledge:create'), zValidator('json', createKnowledgeSpaceSchema), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const data = c.req.valid('json');
  const id = generateId('kspc');
  const now = new Date();
  try {
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
      visibility: data.visibility ?? 'workspace',
      sortOrder,
      createdBy: userId,
      createdAt: now,
      updatedAt: now,
    });
    publishEntityEvent({ c, entityType: 'knowledge_space', entityId: id, action: 'created', data: { id, name: data.name } });
    const [row] = await db.select().from(spaces).where(eq(spaces.id, id)).limit(1);
    return success(c, row, 201);
  } catch (err) {
    console.error('[app-api/knowledge] create space failed:', err);
    return error.internal(c, 'Failed to create space');
  }
});

app.patch('/spaces/:id', requirePermission('knowledge:update'), zValidator('json', updateKnowledgeSpaceSchema), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const id = c.req.param('id');
  const data = c.req.valid('json');
  try {
    const [existing] = await db.select().from(spaces).where(and(eq(spaces.id, id), isNull(spaces.deletedAt))).limit(1);
    if (!existing || !canAccessSpace(existing, userId)) return error.notFound(c, 'Space', id);

    const update: Record<string, unknown> = { updatedAt: new Date() };
    for (const key of ['name', 'description', 'icon', 'color', 'visibility', 'sortOrder'] as const) {
      if (data[key] !== undefined) update[key] = data[key];
    }
    await db.update(spaces).set(update).where(eq(spaces.id, id));
    publishEntityEvent({ c, entityType: 'knowledge_space', entityId: id, action: 'updated', data: { id, name: (update.name as string | undefined) ?? existing.name } });
    const [row] = await db.select().from(spaces).where(eq(spaces.id, id)).limit(1);
    return success(c, row);
  } catch (err) {
    console.error('[app-api/knowledge] update space failed:', err);
    return error.internal(c, 'Failed to update space');
  }
});

app.delete('/spaces/:id', requirePermission('knowledge:delete'), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const id = c.req.param('id');
  try {
    const [existing] = await db.select().from(spaces).where(and(eq(spaces.id, id), isNull(spaces.deletedAt))).limit(1);
    if (!existing || !canAccessSpace(existing, userId)) return error.notFound(c, 'Space', id);

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
    console.error('[app-api/knowledge] delete space failed:', err);
    return error.internal(c, 'Failed to delete space');
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
    const spaceIds = await accessibleSpaceIds(db, userId);
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

/** Soft-deleted pages, newest first. */
app.get('/trash', requirePermission('knowledge:read'), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  try {
    const spaceIds = await accessibleSpaceIds(db, userId);
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
    const page = await loadAccessiblePage(db, id, userId);
    if (!page) return error.notFound(c, 'Page', id);
    return success(c, page);
  } catch (err) {
    console.error('[app-api/knowledge] get page failed:', err);
    return error.internal(c, 'Failed to fetch page');
  }
});

app.post('/pages', requirePermission('knowledge:create'), zValidator('json', createKnowledgePageSchema), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const data = c.req.valid('json');
  const id = generateId('kpag');
  const now = new Date();
  try {
    const [space] = await db
      .select()
      .from(spaces)
      .where(and(eq(spaces.id, data.spaceId), isNull(spaces.deletedAt)))
      .limit(1);
    if (!space || !canAccessSpace(space, userId)) return error.notFound(c, 'Space', data.spaceId);

    if (data.parentId) {
      const parent = await loadAccessiblePage(db, data.parentId, userId);
      if (!parent) return error.notFound(c, 'Parent page', data.parentId);
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
    console.error('[app-api/knowledge] create page failed:', err);
    return error.internal(c, 'Failed to create page');
  }
});

app.patch('/pages/:id', requirePermission('knowledge:update'), zValidator('json', updateKnowledgePageSchema), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const id = c.req.param('id');
  const data = c.req.valid('json');
  try {
    const page = await loadAccessiblePage(db, id, userId);
    if (!page) return error.notFound(c, 'Page', id);

    const update: Record<string, unknown> = { updatedAt: new Date(), lastEditedBy: userId };
    for (const key of ['title', 'icon', 'coverImage', 'isLocked'] as const) {
      if (data[key] !== undefined) update[key] = data[key];
    }
    await db.update(pages).set(update).where(eq(pages.id, id));
    publishEntityEvent({ c, entityType: 'knowledge_page', entityId: id, action: 'updated', data: { id, spaceId: page.spaceId, title: (update.title as string | undefined) ?? page.title } });
    const [row] = await db.select().from(pages).where(eq(pages.id, id)).limit(1);
    return success(c, row);
  } catch (err) {
    console.error('[app-api/knowledge] update page failed:', err);
    return error.internal(c, 'Failed to update page');
  }
});

/** Autosave content. Locked pages reject edits. */
app.put('/pages/:id/content', requirePermission('knowledge:update'), zValidator('json', saveKnowledgePageContentSchema), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const id = c.req.param('id');
  const data = c.req.valid('json');
  try {
    const page = await loadAccessiblePage(db, id, userId);
    if (!page) return error.notFound(c, 'Page', id);
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
    console.error('[app-api/knowledge] save content failed:', err);
    return error.internal(c, 'Failed to save page content');
  }
});

/** Re-parent / reorder / move-to-space. Moving a page moves its whole subtree. */
app.post('/pages/:id/move', requirePermission('knowledge:update'), zValidator('json', moveKnowledgePageSchema), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const id = c.req.param('id');
  const data = c.req.valid('json');
  try {
    const page = await loadAccessiblePage(db, id, userId);
    if (!page) return error.notFound(c, 'Page', id);

    const targetSpaceId = data.spaceId ?? page.spaceId;
    if (targetSpaceId !== page.spaceId) {
      const [space] = await db
        .select()
        .from(spaces)
        .where(and(eq(spaces.id, targetSpaceId), isNull(spaces.deletedAt)))
        .limit(1);
      if (!space || !canAccessSpace(space, userId)) return error.notFound(c, 'Space', targetSpaceId);
    }

    if (data.parentId) {
      const parent = await loadAccessiblePage(db, data.parentId, userId);
      if (!parent) return error.notFound(c, 'Parent page', data.parentId);
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
    console.error('[app-api/knowledge] move page failed:', err);
    return error.internal(c, 'Failed to move page');
  }
});

/** Soft-delete a page and its whole subtree (recoverable from trash). */
app.delete('/pages/:id', requirePermission('knowledge:delete'), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const id = c.req.param('id');
  try {
    const page = await loadAccessiblePage(db, id, userId);
    if (!page) return error.notFound(c, 'Page', id);

    const subtree = await collectSubtreeIds(db, id);
    const now = new Date();
    await db.update(pages).set({ deletedAt: now, updatedAt: now }).where(inArray(pages.id, subtree));
    publishEntityEvent({ c, entityType: 'knowledge_page', entityId: id, action: 'deleted', data: { id, spaceId: page.spaceId } });
    return noContent(c);
  } catch (err) {
    console.error('[app-api/knowledge] delete page failed:', err);
    return error.internal(c, 'Failed to delete page');
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
      .select()
      .from(spaces)
      .where(and(eq(spaces.id, page.spaceId), isNull(spaces.deletedAt)))
      .limit(1);
    if (!space || !canAccessSpace(space, userId)) {
      return error.conflict(c, 'The space this page belonged to no longer exists');
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
    console.error('[app-api/knowledge] restore page failed:', err);
    return error.internal(c, 'Failed to restore page');
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
    const page = await loadAccessiblePage(db, id, userId);
    if (!page) return error.notFound(c, 'Page', id);
    const rows = await listPageVersions(db, id);
    return list(c, rows, { totalCount: rows.length, hasMore: false, cursor: null });
  } catch (err) {
    console.error('[app-api/knowledge] list versions failed:', err);
    return error.internal(c, 'Failed to list versions');
  }
});

app.post('/pages/:id/versions', requirePermission('knowledge:update'), zValidator('json', createKnowledgePageVersionSchema), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const id = c.req.param('id');
  const data = c.req.valid('json');
  try {
    const page = await loadAccessiblePage(db, id, userId);
    if (!page) return error.notFound(c, 'Page', id);
    const row = await createPageVersion(db, id, page.contentJson ?? [], userId, data.label ?? null);
    return success(c, row, 201);
  } catch (err) {
    console.error('[app-api/knowledge] create version failed:', err);
    return error.internal(c, 'Failed to create version');
  }
});

app.get('/pages/:id/versions/:versionId', requirePermission('knowledge:read'), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const id = c.req.param('id');
  const versionId = c.req.param('versionId');
  try {
    const page = await loadAccessiblePage(db, id, userId);
    if (!page) return error.notFound(c, 'Page', id);
    const row = await getPageVersion(db, id, versionId);
    if (!row) return error.notFound(c, 'Version', versionId);
    return success(c, row);
  } catch (err) {
    console.error('[app-api/knowledge] get version failed:', err);
    return error.internal(c, 'Failed to fetch version');
  }
});

/** Restore a snapshot onto the live page, keeping a pre-restore backup version. */
app.post('/pages/:id/versions/:versionId/restore', requirePermission('knowledge:update'), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const id = c.req.param('id');
  const versionId = c.req.param('versionId');
  try {
    const page = await loadAccessiblePage(db, id, userId);
    if (!page) return error.notFound(c, 'Page', id);
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
    console.error('[app-api/knowledge] restore version failed:', err);
    return error.internal(c, 'Failed to restore version');
  }
});

// ---------------------------------------------------------------------------
// Favorites (always scoped to the authenticated user)
// ---------------------------------------------------------------------------

app.get('/favorites', requirePermission('knowledge:read'), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  try {
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
      .where(and(eq(favorites.userId, userId), isNull(pages.deletedAt)))
      .orderBy(asc(favorites.position), asc(favorites.createdAt));
    return list(c, rows, { totalCount: rows.length, hasMore: false, cursor: null });
  } catch (err) {
    console.error('[app-api/knowledge] list favorites failed:', err);
    return error.internal(c, 'Failed to list favorites');
  }
});

app.post('/favorites', requirePermission('knowledge:read'), zValidator('json', addKnowledgeFavoriteSchema), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const { pageId } = c.req.valid('json');
  try {
    const page = await loadAccessiblePage(db, pageId, userId);
    if (!page) return error.notFound(c, 'Page', pageId);
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
    console.error('[app-api/knowledge] add favorite failed:', err);
    return error.internal(c, 'Failed to add favorite');
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
