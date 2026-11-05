/** Cycles: a team's time-boxed iterations, numbered per team. */

import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { generateId } from '@weldsuite/worker-kit/id';
import { isUniqueViolation } from '@weldsuite/worker-kit/pg-errors';
import type { CreateMergeCycleInput, UpdateMergeCycleInput } from '@weldsuite/app-api-client/schemas/weldmerge';
import { mergeCycles, mergeIssues, type Db, type MergeCycleRow } from './db';
import { findTeam } from './teams';

export interface CycleWithCounts {
  row: MergeCycleRow;
  issueCount: number;
  completedIssueCount: number;
}

async function withCounts(db: Db, rows: MergeCycleRow[]): Promise<CycleWithCounts[]> {
  if (rows.length === 0) return [];
  const counts = await db
    .select({
      cycleId: mergeIssues.cycleId,
      total: sql<number>`count(*)::int`,
      done: sql<number>`count(*) filter (where ${mergeIssues.status} = 'done')::int`,
    })
    .from(mergeIssues)
    .where(
      and(
        inArray(
          mergeIssues.cycleId,
          rows.map((r) => r.id),
        ),
        isNull(mergeIssues.deletedAt),
      ),
    )
    .groupBy(mergeIssues.cycleId);
  const byCycle = new Map(counts.map((c) => [c.cycleId, c]));
  return rows.map((row) => ({
    row,
    issueCount: byCycle.get(row.id)?.total ?? 0,
    completedIssueCount: byCycle.get(row.id)?.done ?? 0,
  }));
}

export async function listCycles(db: Db, teamId?: string): Promise<CycleWithCounts[]> {
  const rows = await db
    .select()
    .from(mergeCycles)
    .where(and(isNull(mergeCycles.deletedAt), teamId ? eq(mergeCycles.teamId, teamId) : undefined))
    .orderBy(asc(mergeCycles.teamId), desc(mergeCycles.number));
  return withCounts(db, rows);
}

export async function findCycle(db: Db, id: string): Promise<MergeCycleRow | null> {
  const [row] = await db
    .select()
    .from(mergeCycles)
    .where(and(eq(mergeCycles.id, id), isNull(mergeCycles.deletedAt)))
    .limit(1);
  return row ?? null;
}

export type CycleWriteResult =
  | { ok: true; cycle: CycleWithCounts }
  | { ok: false; reason: 'not_found' | 'team_not_found' | 'invalid_range' };

export async function createCycle(db: Db, input: CreateMergeCycleInput): Promise<CycleWriteResult> {
  if (!(await findTeam(db, input.teamId))) return { ok: false, reason: 'team_not_found' };
  for (let attempt = 0; attempt < 3; attempt++) {
    // Numbers are never reused, so the max includes deleted cycles.
    const [last] = await db
      .select({ max: sql<number | null>`max(${mergeCycles.number})::int` })
      .from(mergeCycles)
      .where(eq(mergeCycles.teamId, input.teamId));
    const now = new Date();
    try {
      const [row] = await db
        .insert(mergeCycles)
        .values({
          id: generateId('mcy'),
          teamId: input.teamId,
          number: (last?.max ?? 0) + 1,
          name: input.name?.trim() || null,
          startsAt: input.startsAt,
          endsAt: input.endsAt,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      return { ok: true, cycle: { row: row!, issueCount: 0, completedIssueCount: 0 } };
    } catch (err) {
      // Two cycles created at once picked the same number: take the next.
      if (!isUniqueViolation(err) || attempt === 2) throw err;
    }
  }
  throw new Error('unreachable');
}

export async function updateCycle(db: Db, id: string, input: UpdateMergeCycleInput): Promise<CycleWriteResult> {
  const existing = await findCycle(db, id);
  if (!existing) return { ok: false, reason: 'not_found' };
  const startsAt = input.startsAt ?? existing.startsAt;
  const endsAt = input.endsAt ?? existing.endsAt;
  if (endsAt < startsAt) return { ok: false, reason: 'invalid_range' };
  const patch: Partial<typeof mergeCycles.$inferInsert> = { updatedAt: new Date(), startsAt, endsAt };
  if (input.name !== undefined) patch.name = input.name?.trim() || null;
  const [row] = await db.update(mergeCycles).set(patch).where(eq(mergeCycles.id, id)).returning();
  const [withCount] = await withCounts(db, [row!]);
  return { ok: true, cycle: withCount! };
}

/** Soft-deletes the cycle; its issues keep everything else and lose the cycle. */
export async function deleteCycle(db: Db, id: string): Promise<CycleWriteResult> {
  const existing = await findCycle(db, id);
  if (!existing) return { ok: false, reason: 'not_found' };
  const now = new Date();
  await db.update(mergeIssues).set({ cycleId: null, updatedAt: now }).where(eq(mergeIssues.cycleId, id));
  const [row] = await db.update(mergeCycles).set({ deletedAt: now, updatedAt: now }).where(eq(mergeCycles.id, id)).returning();
  return { ok: true, cycle: { row: row!, issueCount: 0, completedIssueCount: 0 } };
}
