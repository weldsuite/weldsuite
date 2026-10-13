/**
 * Prospect lists: named groups of prospects (an import batch or a hand-made
 * list). A prospect can be on any number of lists; a campaign takes whole
 * lists via `POST /campaigns/:id/prospects { listId }`.
 */

import { and, eq, isNull } from 'drizzle-orm';
import type { Database } from '@weldsuite/worker-kit';
import { generateId } from '@weldsuite/worker-kit/id';
import type { ReachProspectList } from '@weldsuite/app-api-client/schemas/reach';
import {
  reachProspectListMembers,
  reachProspectLists,
  type ReachProspectList as ReachProspectListRow,
} from '@weldsuite/db/schema';

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
