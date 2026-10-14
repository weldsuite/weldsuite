/**
 * Prospect lists: named groups of prospects (an import batch or a hand-made
 * list). A prospect can be on any number of lists; a campaign takes whole
 * lists via `POST /campaigns/:id/prospects { listId }`.
 *
 * Lists are organisation only: the entity-event catalog has no list type (the
 * prospects themselves publish `reach_prospect` events), so nothing here emits.
 */

import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Database } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import type { ReachProspectList } from '@weldsuite/app-api-client/schemas/reach';
import {
  reachProspectListMembers,
  reachProspectLists,
  reachProspects,
  type ReachProspectList as ReachProspectListRow,
} from '@weldsuite/db/schema';
import { reachError } from './errors';
import { cursorCondition, pageResult, parseLimit, type Page, type PageQuery } from './list-query';

const CHUNK = 500;

export function toProspectList(row: ReachProspectListRow): ReachProspectList {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    source: row.source,
    sourceRef: row.sourceRef,
    prospectCount: row.prospectCount,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function findList(db: Database, id: string): Promise<ReachProspectListRow | null> {
  const [row] = await db
    .select()
    .from(reachProspectLists)
    .where(and(eq(reachProspectLists.id, id), isNull(reachProspectLists.deletedAt)))
    .limit(1);
  return row ?? null;
}

export async function createList(
  db: Database,
  input: {
    name: string;
    description?: string | null;
    source?: ReachProspectList['source'];
    sourceRef?: string | null;
    createdBy?: string | null;
  },
): Promise<ReachProspectListRow> {
  const [row] = await db
    .insert(reachProspectLists)
    .values({
      id: generateId('rpl'),
      name: input.name,
      description: input.description ?? null,
      source: input.source ?? 'manual',
      sourceRef: input.sourceRef ?? null,
      createdBy: input.createdBy ?? null,
    })
    .returning();
  if (!row) throw new Error('Failed to create the prospect list');
  return row;
}

/** Soft-delete the list and drop its memberships (the prospects stay). */
export async function deleteList(db: Database, id: string): Promise<boolean> {
  const now = new Date();
  const [row] = await db
    .update(reachProspectLists)
    .set({ deletedAt: now, updatedAt: now })
    .where(and(eq(reachProspectLists.id, id), isNull(reachProspectLists.deletedAt)))
    .returning({ id: reachProspectLists.id });
  if (!row) return false;
  await db.delete(reachProspectListMembers).where(eq(reachProspectListMembers.listId, id));
  return true;
}

// ---------------------------------------------------------------------------
// Members
// ---------------------------------------------------------------------------

/** Recount `prospect_count` from the live (not deleted) members. */
export async function recountList(db: Database, listId: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(reachProspectListMembers)
    .innerJoin(reachProspects, eq(reachProspects.id, reachProspectListMembers.prospectId))
    .where(and(eq(reachProspectListMembers.listId, listId), isNull(reachProspects.deletedAt)));
  const n = Number(row?.n ?? 0);
  await db.update(reachProspectLists).set({ prospectCount: n, updatedAt: new Date() }).where(eq(reachProspectLists.id, listId));
  return n;
}

export async function addProspectsToList(db: Database, listId: string, prospectIds: readonly string[]): Promise<number> {
  const unique = [...new Set(prospectIds)];
  let added = 0;
  for (let i = 0; i < unique.length; i += CHUNK) {
    const chunk = unique.slice(i, i + CHUNK);
    // Only prospects that exist and are not deleted can join a list.
    const live = await db
      .select({ id: reachProspects.id })
      .from(reachProspects)
      .where(and(inArray(reachProspects.id, chunk), isNull(reachProspects.deletedAt)));
    if (live.length === 0) continue;
    const inserted = await db
      .insert(reachProspectListMembers)
      .values(live.map((p) => ({ id: generateId('rplm'), listId, prospectId: p.id })))
      .onConflictDoNothing()
      .returning({ id: reachProspectListMembers.id });
    added += inserted.length;
  }
  await recountList(db, listId);
  return added;
}

export async function removeProspectsFromList(db: Database, listId: string, prospectIds: readonly string[]): Promise<number> {
  let removed = 0;
  const unique = [...new Set(prospectIds)];
  for (let i = 0; i < unique.length; i += CHUNK) {
    const gone = await db
      .delete(reachProspectListMembers)
      .where(
        and(eq(reachProspectListMembers.listId, listId), inArray(reachProspectListMembers.prospectId, unique.slice(i, i + CHUNK))),
      )
      .returning({ id: reachProspectListMembers.id });
    removed += gone.length;
  }
  await recountList(db, listId);
  return removed;
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

export async function listProspectLists(db: Database, q: PageQuery = {}): Promise<Page<ReachProspectList>> {
  const limit = parseLimit(q.limit);
  const base = isNull(reachProspectLists.deletedAt);
  const after = await cursorCondition(db, reachProspectLists, q.cursor);
  const [rows, total] = await Promise.all([
    db
      .select()
      .from(reachProspectLists)
      .where(and(base, after))
      .orderBy(desc(reachProspectLists.createdAt), desc(reachProspectLists.id))
      .limit(limit + 1),
    db.$count(reachProspectLists, base),
  ]);
  return pageResult(rows, limit, total, toProspectList);
}

export async function getProspectList(db: Database, id: string): Promise<ReachProspectList> {
  const row = await findList(db, id);
  if (!row) throw reachError.notFound('List', id);
  return toProspectList(row);
}

export async function createProspectList(
  db: Database,
  input: { name: string; description?: string | null },
  userId: string,
): Promise<ReachProspectList> {
  return toProspectList(await createList(db, { ...input, createdBy: userId }));
}

export async function updateProspectList(
  db: Database,
  id: string,
  input: { name?: string; description?: string | null },
): Promise<ReachProspectList> {
  const [row] = await db
    .update(reachProspectLists)
    .set({
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      updatedAt: new Date(),
    })
    .where(and(eq(reachProspectLists.id, id), isNull(reachProspectLists.deletedAt)))
    .returning();
  if (!row) throw reachError.notFound('List', id);
  return toProspectList(row);
}

export async function deleteProspectList(db: Database, id: string): Promise<void> {
  if (!(await deleteList(db, id))) throw reachError.notFound('List', id);
}

export async function addProspectListMembers(db: Database, id: string, prospectIds: readonly string[]): Promise<{ added: number }> {
  if (!(await findList(db, id))) throw reachError.notFound('List', id);
  return { added: await addProspectsToList(db, id, prospectIds) };
}

export async function removeProspectListMembers(db: Database, id: string, prospectIds: readonly string[]): Promise<{ removed: number }> {
  if (!(await findList(db, id))) throw reachError.notFound('List', id);
  return { removed: await removeProspectsFromList(db, id, prospectIds) };
}
