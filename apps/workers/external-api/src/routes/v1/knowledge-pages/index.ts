import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { and, asc, eq, inArray, isNull, like, or, type SQL } from 'drizzle-orm';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { schema } from '../../../db';
import type { HonoEnv } from '../../../types';
import { requireScope } from '../../../lib/scopes';
import { generateId } from '../../../lib/id';
import { error, list, noContent, success, cursorPagination } from '../../../lib/response';
import { listWithCursor } from '../../../lib/list-helpers';

const spaces = schema.knowledgeSpaces;
const pages = schema.knowledgePages;
const app = new Hono<HonoEnv>();

type Db = HonoEnv['Variables']['tenantDb'];
type Block = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Content conversion — API callers (AI agents in particular) send plain text /
// light markdown; pages store BlockNote block JSON. `contentJson` is accepted
// as-is for callers that already speak BlockNote.
// ---------------------------------------------------------------------------

function inline(text: string): Block[] {
  return [{ type: 'text', text, styles: {} }];
}

/**
 * Convert plain text / light markdown into BlockNote blocks.
 * Supported per line: `#`/`##`/`###` headings, `-`/`*` bullets, `1.` numbered
 * items; everything else becomes a paragraph. Blank lines separate blocks.
 */
export function textToBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (!line.trim()) continue;
    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading?.[1] !== undefined && heading[2] !== undefined) {
      blocks.push({
        type: 'heading',
        props: { level: heading[1].length },
        content: inline(heading[2]),
        children: [],
      });
      continue;
    }
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    if (bullet?.[1] !== undefined) {
      blocks.push({ type: 'bulletListItem', content: inline(bullet[1]), children: [] });
      continue;
    }
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (numbered?.[1] !== undefined) {
      blocks.push({ type: 'numberedListItem', content: inline(numbered[1]), children: [] });
      continue;
    }
    blocks.push({ type: 'paragraph', content: inline(line.trim()), children: [] });
  }
  return blocks;
}

/** Recursively flatten BlockNote blocks into plain text for search. */
export function blocksToText(blocks: unknown): string {
  const parts: string[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (!node || typeof node !== 'object') return;
    const obj = node as Record<string, unknown>;
    if (typeof obj.text === 'string') parts.push(obj.text);
    walk(obj.content);
    walk(obj.children);
  };
  walk(blocks);
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

/** Resolve caller-provided content into { contentJson, contentText }, or undefined when absent. */
function resolveContent(body: {
  content?: string;
  contentJson?: Record<string, unknown>[];
}): { contentJson: Block[]; contentText: string } | undefined {
  if (body.contentJson !== undefined) {
    return { contentJson: body.contentJson, contentText: blocksToText(body.contentJson) };
  }
  if (typeof body.content === 'string') {
    const blocks = textToBlocks(body.content);
    return { contentJson: blocks, contentText: blocksToText(blocks) };
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Access helpers (mirrors app-api routes/knowledge)
// ---------------------------------------------------------------------------

function canAccessSpace(
  space: { visibility: string; createdBy: string | null },
  userId: string | null | undefined,
): boolean {
  return space.visibility !== 'private' || (!!userId && space.createdBy === userId);
}

async function accessibleSpaceIds(db: Db, userId: string | null | undefined): Promise<string[]> {
  const rows = await db
    .select({ id: spaces.id, visibility: spaces.visibility, createdBy: spaces.createdBy })
    .from(spaces)
    .where(isNull(spaces.deletedAt));
  return rows.filter((s) => canAccessSpace(s, userId)).map((s) => s.id);
}

async function loadAccessiblePage(db: Db, id: string, userId: string | null | undefined) {
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

async function nextPosition(db: Db, spaceId: string, parentId: string | null): Promise<number> {
  const rows = await db
    .select({ position: pages.position })
    .from(pages)
    .where(
      and(
        eq(pages.spaceId, spaceId),
        parentId === null ? isNull(pages.parentId) : eq(pages.parentId, parentId),
        isNull(pages.deletedAt),
      ),
    );
  return rows.reduce((max, r) => Math.max(max, r.position), -1) + 1;
}

async function collectSubtreeIds(db: Db, rootId: string): Promise<string[]> {
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

async function wouldCreateCycle(db: Db, pageId: string, newParentId: string): Promise<boolean> {
  if (pageId === newParentId) return true;
  let current: string | null = newParentId;
  const seen = new Set<string>();
  while (current) {
    if (current === pageId) return true;
    if (seen.has(current)) return true;
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
// Schemas (external surface: `content` is plain text / light markdown)
// ---------------------------------------------------------------------------

const listPagesQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().min(1).max(200).optional(),
  search: z.string().optional(),
  spaceId: z.string().optional(),
  parentId: z.string().optional(),
});

const createPageSchema = z.object({
  spaceId: z.string().min(1),
  parentId: z.string().nullish(),
  title: z.string().max(500).optional(),
  icon: z.string().max(100).nullish(),
  coverImage: z.string().max(1000).nullish(),
  content: z.string().optional(),
  contentJson: z.array(z.record(z.unknown())).optional(),
});

const updatePageSchema = z.object({
  title: z.string().max(500).optional(),
  icon: z.string().max(100).nullish(),
  coverImage: z.string().max(1000).nullish(),
  isLocked: z.boolean().optional(),
  content: z.string().optional(),
  contentJson: z.array(z.record(z.unknown())).optional(),
});

const movePageSchema = z.object({
  parentId: z.string().nullable(),
  spaceId: z.string().optional(),
  position: z.number().int().min(0).optional(),
});

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

app.get('/', requireScope('knowledge:read'), zValidator('query', listPagesQuery), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('apiSession').userId;
  const q = c.req.valid('query');

  const spaceIds = await accessibleSpaceIds(db, userId);
  const scope = q.spaceId ? spaceIds.filter((s) => s === q.spaceId) : spaceIds;
  if (scope.length === 0) return list(c, [], cursorPagination(0, false, null));

  const where: (SQL | undefined)[] = [inArray(pages.spaceId, scope)];
  if (q.parentId) where.push(eq(pages.parentId, q.parentId));
  if (q.search) {
    where.push(or(like(pages.title, `%${q.search}%`), like(pages.contentText, `%${q.search}%`)));
  }
  const result = await listWithCursor({ db, table: pages, where, cursor: q.cursor, limit: q.limit });
  return list(c, result.data as Record<string, unknown>[], cursorPagination(result.totalCount, result.hasMore, result.cursor));
});

/** Flat tree metadata (no content payloads) — clients rebuild the hierarchy from parentId/position. */
app.get('/tree', requireScope('knowledge:read'), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('apiSession').userId;
  const spaceIdFilter = c.req.query('spaceId');

  const spaceIds = await accessibleSpaceIds(db, userId);
  const scope = spaceIdFilter ? spaceIds.filter((s) => s === spaceIdFilter) : spaceIds;
  if (scope.length === 0) return list(c, [], cursorPagination(0, false, null));

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
  return list(c, rows, cursorPagination(rows.length, false, null));
});

app.get('/:id', requireScope('knowledge:read'), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('apiSession').userId;
  const id = c.req.param('id');
  const page = await loadAccessiblePage(db, id, userId);
  if (!page) return error.notFound(c, 'Knowledge page', id);
  return success(c, page);
});

app.post('/', requireScope('knowledge:write'), zValidator('json', createPageSchema), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('apiSession').userId;
  const body = c.req.valid('json');
  const id = generateId('kpag');
  const now = new Date();

  const [space] = await db
    .select()
    .from(spaces)
    .where(and(eq(spaces.id, body.spaceId), isNull(spaces.deletedAt)))
    .limit(1);
  if (!space || !canAccessSpace(space, userId)) return error.notFound(c, 'Knowledge space', body.spaceId);

  if (body.parentId) {
    const parent = await loadAccessiblePage(db, body.parentId, userId);
    if (!parent) return error.notFound(c, 'Parent page', body.parentId);
    if (parent.spaceId !== body.spaceId) {
      return error.badRequest(c, 'Parent page belongs to a different space');
    }
  }

  const content = resolveContent(body) ?? { contentJson: [], contentText: '' };
  const position = await nextPosition(db, body.spaceId, body.parentId ?? null);
  const [row] = await db
    .insert(pages)
    .values({
      id,
      spaceId: body.spaceId,
      parentId: body.parentId ?? null,
      position,
      title: body.title && body.title.length > 0 ? body.title : 'Untitled',
      icon: body.icon ?? null,
      coverImage: body.coverImage ?? null,
      contentJson: content.contentJson,
      contentText: content.contentText,
      createdBy: userId ?? null,
      lastEditedBy: userId ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  if (!row) return error.internal(c, 'Failed to create knowledge page');
  publishEntityEvent({
    c,
    entityType: 'knowledge_page',
    entityId: id,
    action: 'created',
    data: { id, spaceId: body.spaceId, parentId: body.parentId ?? null, title: row.title },
  });
  return success(c, row, 201);
});

app.patch('/:id', requireScope('knowledge:write'), zValidator('json', updatePageSchema), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('apiSession').userId;
  const id = c.req.param('id');
  const body = c.req.valid('json');

  const page = await loadAccessiblePage(db, id, userId);
  if (!page) return error.notFound(c, 'Knowledge page', id);

  const content = resolveContent(body);
  if (content && page.isLocked && body.isLocked !== false) {
    return error.conflict(c, 'Page is locked');
  }

  const update: Record<string, unknown> = { updatedAt: new Date(), lastEditedBy: userId ?? null };
  for (const key of ['title', 'icon', 'coverImage', 'isLocked'] as const) {
    if (body[key] !== undefined) update[key] = body[key];
  }
  if (content) {
    update.contentJson = content.contentJson;
    update.contentText = content.contentText;
  }

  const [row] = await db.update(pages).set(update).where(eq(pages.id, id)).returning();
  if (!row) return error.notFound(c, 'Knowledge page', id);
  publishEntityEvent({
    c,
    entityType: 'knowledge_page',
    entityId: id,
    action: 'updated',
    data: { id, spaceId: row.spaceId, title: row.title },
  });
  return success(c, row);
});

app.post('/:id/move', requireScope('knowledge:write'), zValidator('json', movePageSchema), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('apiSession').userId;
  const id = c.req.param('id');
  const body = c.req.valid('json');

  const page = await loadAccessiblePage(db, id, userId);
  if (!page) return error.notFound(c, 'Knowledge page', id);

  const targetSpaceId = body.spaceId ?? page.spaceId;
  if (targetSpaceId !== page.spaceId) {
    const [space] = await db
      .select()
      .from(spaces)
      .where(and(eq(spaces.id, targetSpaceId), isNull(spaces.deletedAt)))
      .limit(1);
    if (!space || !canAccessSpace(space, userId)) return error.notFound(c, 'Knowledge space', targetSpaceId);
  }

  if (body.parentId) {
    const parent = await loadAccessiblePage(db, body.parentId, userId);
    if (!parent) return error.notFound(c, 'Parent page', body.parentId);
    if (parent.spaceId !== targetSpaceId) {
      return error.badRequest(c, 'Parent page belongs to a different space');
    }
    if (await wouldCreateCycle(db, id, body.parentId)) {
      return error.badRequest(c, 'Cannot move a page under itself or one of its sub-pages');
    }
  }

  const position = body.position ?? (await nextPosition(db, targetSpaceId, body.parentId ?? null));
  const now = new Date();
  const [row] = await db
    .update(pages)
    .set({ parentId: body.parentId, spaceId: targetSpaceId, position, lastEditedBy: userId ?? null, updatedAt: now })
    .where(eq(pages.id, id))
    .returning();
  if (!row) return error.notFound(c, 'Knowledge page', id);

  // A cross-space move carries the whole subtree along.
  if (targetSpaceId !== page.spaceId) {
    const subtree = await collectSubtreeIds(db, id);
    const descendants = subtree.filter((sid) => sid !== id);
    if (descendants.length > 0) {
      await db.update(pages).set({ spaceId: targetSpaceId, updatedAt: now }).where(inArray(pages.id, descendants));
    }
  }

  publishEntityEvent({
    c,
    entityType: 'knowledge_page',
    entityId: id,
    action: 'moved',
    data: { id, spaceId: targetSpaceId, parentId: body.parentId, position },
  });
  return success(c, row);
});

app.delete('/:id', requireScope('knowledge:write'), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('apiSession').userId;
  const id = c.req.param('id');

  const page = await loadAccessiblePage(db, id, userId);
  if (!page) return error.notFound(c, 'Knowledge page', id);

  const subtree = await collectSubtreeIds(db, id);
  const now = new Date();
  await db.update(pages).set({ deletedAt: now, updatedAt: now }).where(inArray(pages.id, subtree));
  publishEntityEvent({ c, entityType: 'knowledge_page', entityId: id, action: 'deleted', data: { id, spaceId: page.spaceId } });
  return noContent(c);
});

export default app;
