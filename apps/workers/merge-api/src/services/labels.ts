/** Issue labels. `team_id` null = available to every team. */

import { and, asc, eq, isNull, or, sql } from 'drizzle-orm';
import { generateId } from '@weldsuite/worker-kit/id';
import type { CreateMergeLabelInput, UpdateMergeLabelInput } from '@weldsuite/app-api-client/schemas/weldmerge';
import { mergeLabels, type Db, type MergeLabelRow } from './db';
import { findTeam } from './teams';

/** With a team id: that team's labels plus the workspace-wide ones. */
export async function listLabels(db: Db, teamId?: string): Promise<MergeLabelRow[]> {
  return db
    .select()
    .from(mergeLabels)
    .where(
      and(
        isNull(mergeLabels.deletedAt),
        teamId ? or(eq(mergeLabels.teamId, teamId), isNull(mergeLabels.teamId)) : undefined,
      ),
    )
    .orderBy(asc(mergeLabels.name), asc(mergeLabels.id));
}

export async function findLabel(db: Db, id: string): Promise<MergeLabelRow | null> {
  const [row] = await db
    .select()
    .from(mergeLabels)
    .where(and(eq(mergeLabels.id, id), isNull(mergeLabels.deletedAt)))
    .limit(1);
  return row ?? null;
}

async function nameTaken(db: Db, teamId: string | null, name: string, exceptId?: string): Promise<boolean> {
  const rows = await db
    .select({ id: mergeLabels.id })
    .from(mergeLabels)
    .where(
      and(
        isNull(mergeLabels.deletedAt),
        teamId ? eq(mergeLabels.teamId, teamId) : isNull(mergeLabels.teamId),
        sql`lower(${mergeLabels.name}) = ${name.toLowerCase()}`,
      ),
    );
  return rows.some((r) => r.id !== exceptId);
}

export type LabelWriteResult =
  | { ok: true; label: MergeLabelRow }
  | { ok: false; reason: 'not_found' | 'team_not_found' | 'name_taken' };

export async function createLabel(db: Db, input: CreateMergeLabelInput): Promise<LabelWriteResult> {
  const teamId = input.teamId ?? null;
  if (teamId && !(await findTeam(db, teamId))) return { ok: false, reason: 'team_not_found' };
  const name = input.name.trim();
  if (await nameTaken(db, teamId, name)) return { ok: false, reason: 'name_taken' };
  const now = new Date();
  const [row] = await db
    .insert(mergeLabels)
    .values({ id: generateId('mlb'), teamId, name, color: input.color ?? null, createdAt: now, updatedAt: now })
    .returning();
  return { ok: true, label: row! };
}

export async function updateLabel(db: Db, id: string, input: UpdateMergeLabelInput): Promise<LabelWriteResult> {
  const existing = await findLabel(db, id);
  if (!existing) return { ok: false, reason: 'not_found' };
  const patch: Partial<typeof mergeLabels.$inferInsert> = { updatedAt: new Date() };
  if (input.name !== undefined) {
    const name = input.name.trim();
    if (await nameTaken(db, existing.teamId, name, id)) return { ok: false, reason: 'name_taken' };
    patch.name = name;
  }
  if (input.color !== undefined) patch.color = input.color;
  const [row] = await db.update(mergeLabels).set(patch).where(eq(mergeLabels.id, id)).returning();
  return { ok: true, label: row! };
}

/** Soft delete. Issues keep the id in `label_ids`; readers ignore labels that no longer exist. */
export async function deleteLabel(db: Db, id: string): Promise<LabelWriteResult> {
  const existing = await findLabel(db, id);
  if (!existing) return { ok: false, reason: 'not_found' };
  const now = new Date();
  const [row] = await db.update(mergeLabels).set({ deletedAt: now, updatedAt: now }).where(eq(mergeLabels.id, id)).returning();
  return { ok: true, label: row! };
}
