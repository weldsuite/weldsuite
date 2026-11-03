/**
 * WeldKnow pages created from outside WeldKnow: another module (WeldFlow
 * publishing a project's lessons learned) writes a page into a teamspace the
 * caller may write in. The teamspace rules are `./access` (a space the caller
 * cannot see is a 404, one they can read but not write a 403); this file adds
 * the page itself: its position among its siblings, its block content and the
 * plain-text copy search reads.
 *
 * Context-free (no Hono), so flow-api calls it directly and the Rust
 * `weldsuite-know-domain` crate mirrors it. The caller publishes the
 * `knowledge_page` `created` entity event, as know-api's own route does.
 */

import { and, eq, isNull, sql } from 'drizzle-orm';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import { assertCanWrite, requireSpace } from './access';

const pages = schema.knowledgePages;

export type KnowledgePageRow = typeof pages.$inferSelect;

/** A BlockNote block, as `knowledge_pages.content_json` stores it. */
export type KnowledgeBlock = Record<string, unknown>;

/** Recursively flatten BlockNote blocks into the plain text search matches on. */
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

/** The position that appends a page to the end of its siblings (a top-level page when there is no parent). */
export async function nextPagePosition(db: Database, spaceId: string, parentId: string | null): Promise<number> {
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

export interface CreatePageInput {
  spaceId: string;
  title: string;
  contentJson: KnowledgeBlock[];
  /** `knowledge:manage`: makes every teamspace visible and manageable (not readable: that takes joining it). */
  canManageAll?: boolean;
}

/**
 * Create a top-level page in a teamspace the caller may write in. Throws
 * `SpaceNotFoundError` (404) when the space does not exist for the caller and
 * `SpaceAccessError` (403) when they can see it but are not an editor.
 */
export async function createKnowledgePage(db: Database, userId: string, input: CreatePageInput): Promise<KnowledgePageRow> {
  const access = await requireSpace(db, userId, input.spaceId, { canManageAll: input.canManageAll ?? false });
  assertCanWrite(access);

  const id = generateId('kpag');
  const now = new Date();
  const position = await nextPagePosition(db, input.spaceId, null);
  await db.insert(pages).values({
    id,
    spaceId: input.spaceId,
    parentId: null,
    position,
    title: input.title.length > 0 ? input.title : 'Untitled',
    icon: null,
    coverImage: null,
    contentJson: input.contentJson,
    contentText: blocksToText(input.contentJson),
    createdBy: userId,
    lastEditedBy: userId,
    createdAt: now,
    updatedAt: now,
  });
  const [row] = await db.select().from(pages).where(eq(pages.id, id)).limit(1);
  if (!row) throw new Error(`The new page ${id} is missing`);
  return row;
}
