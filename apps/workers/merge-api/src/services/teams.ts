/** Teams: the owners of issues (`PLAT`). */

import { and, asc, eq, inArray, isNull, notInArray, sql } from 'drizzle-orm';
import { generateId } from '@weldsuite/worker-kit/id';
import { isUniqueViolation } from '@weldsuite/worker-kit/pg-errors';
import type { CreateMergeTeamInput, UpdateMergeTeamInput } from '@weldsuite/app-api-client/schemas/weldmerge';
import {
  mergeCycles,
  mergeIssues,
  mergeLabels,
  mergeRepositories,
  mergeTeams,
  type Db,
  type MergeTeamRow,
} from './db';

const CLOSED = ['done', 'canceled'] as const;

/** Open (not done or canceled, not deleted) issue counts by team id. */
async function openIssueCounts(db: Db, teamIds: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (teamIds.length === 0) return out;
  const rows = await db
    .select({ teamId: mergeIssues.teamId, count: sql<number>`count(*)::int` })
    .from(mergeIssues)
    .where(
      and(inArray(mergeIssues.teamId, teamIds), isNull(mergeIssues.deletedAt), notInArray(mergeIssues.status, [...CLOSED])),
    )
    .groupBy(mergeIssues.teamId);
  for (const row of rows) out.set(row.teamId, row.count);
  return out;
}

export async function listTeams(db: Db): Promise<Array<{ row: MergeTeamRow; openIssueCount: number }>> {
  const rows = await db.select().from(mergeTeams).where(isNull(mergeTeams.deletedAt)).orderBy(asc(mergeTeams.key));
  const counts = await openIssueCounts(
    db,
    rows.map((r) => r.id),
  );
  return rows.map((row) => ({ row, openIssueCount: counts.get(row.id) ?? 0 }));
}

export async function findTeam(db: Db, id: string): Promise<MergeTeamRow | null> {
  const [row] = await db
    .select()
    .from(mergeTeams)
    .where(and(eq(mergeTeams.id, id), isNull(mergeTeams.deletedAt)))
    .limit(1);
  return row ?? null;
}

export async function getTeam(db: Db, id: string) {
  const row = await findTeam(db, id);
  if (!row) return null;
  const counts = await openIssueCounts(db, [row.id]);
  return { row, openIssueCount: counts.get(row.id) ?? 0 };
}

async function keyTaken(db: Db, key: string, exceptId?: string): Promise<boolean> {
  const rows = await db
    .select({ id: mergeTeams.id })
    .from(mergeTeams)
    .where(and(eq(mergeTeams.key, key), isNull(mergeTeams.deletedAt)));
  return rows.some((r) => r.id !== exceptId);
}

export type TeamWriteResult =
  | { ok: true; team: MergeTeamRow; openIssueCount: number }
  | { ok: false; reason: 'not_found' | 'key_taken' | 'key_locked' | 'has_issues' };

export async function createTeam(db: Db, input: CreateMergeTeamInput, userId: string): Promise<TeamWriteResult> {
  const key = input.key.trim().toUpperCase();
  if (await keyTaken(db, key)) return { ok: false, reason: 'key_taken' };
  const now = new Date();
  try {
    const [row] = await db
      .insert(mergeTeams)
      .values({
        id: generateId('mtm'),
        key,
        name: input.name.trim(),
        description: input.description ?? null,
        color: input.color ?? null,
        createdByUserId: userId,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    return { ok: true, team: row!, openIssueCount: 0 };
  } catch (err) {
    if (isUniqueViolation(err)) return { ok: false, reason: 'key_taken' };
    throw err;
  }
}

export async function updateTeam(db: Db, id: string, input: UpdateMergeTeamInput): Promise<TeamWriteResult> {
  const existing = await findTeam(db, id);
  if (!existing) return { ok: false, reason: 'not_found' };

  const patch: Partial<typeof mergeTeams.$inferInsert> = { updatedAt: new Date() };
  if (input.key !== undefined) {
    const key = input.key.trim().toUpperCase();
    if (key !== existing.key) {
      if (existing.issueCounter > 0) return { ok: false, reason: 'key_locked' };
      if (await keyTaken(db, key, id)) return { ok: false, reason: 'key_taken' };
      patch.key = key;
    }
  }
  if (input.name !== undefined) patch.name = input.name.trim();
  if (input.description !== undefined) patch.description = input.description;
  if (input.color !== undefined) patch.color = input.color;

  try {
    const [row] = await db.update(mergeTeams).set(patch).where(eq(mergeTeams.id, id)).returning();
    const counts = await openIssueCounts(db, [id]);
    return { ok: true, team: row!, openIssueCount: counts.get(id) ?? 0 };
  } catch (err) {
    if (isUniqueViolation(err)) return { ok: false, reason: 'key_taken' };
    throw err;
  }
}

/** Soft-deletes a team that has no live issues, with its cycles and labels; its repositories lose the team. */
export async function deleteTeam(db: Db, id: string): Promise<TeamWriteResult> {
  const existing = await findTeam(db, id);
  if (!existing) return { ok: false, reason: 'not_found' };
  const [live] = await db
    .select({ id: mergeIssues.id })
    .from(mergeIssues)
    .where(and(eq(mergeIssues.teamId, id), isNull(mergeIssues.deletedAt)))
    .limit(1);
  if (live) return { ok: false, reason: 'has_issues' };

  const now = new Date();
  await db.update(mergeCycles).set({ deletedAt: now }).where(and(eq(mergeCycles.teamId, id), isNull(mergeCycles.deletedAt)));
  await db.update(mergeLabels).set({ deletedAt: now }).where(and(eq(mergeLabels.teamId, id), isNull(mergeLabels.deletedAt)));
  await db.update(mergeRepositories).set({ teamId: null, updatedAt: now }).where(eq(mergeRepositories.teamId, id));
  const [row] = await db.update(mergeTeams).set({ deletedAt: now, updatedAt: now }).where(eq(mergeTeams.id, id)).returning();
  return { ok: true, team: row!, openIssueCount: 0 };
}
