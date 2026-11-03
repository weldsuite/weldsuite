/**
 * Benefit queries and builders for `/api/project-benefits` and the monthly
 * measuring (design: weldflow-project-control.md; ADR FLOW-014): the newest
 * measurement of each benefit, upserting a month's value, and the progress of
 * the targets on a project's goal cards.
 */

import { and, asc, desc, eq, inArray, isNull, ne, sql, type SQL } from 'drizzle-orm';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import type { GoalTaskFilter } from '@weldsuite/app-api-client/schemas/project-governance';
import { latestOf, presentBenefit } from '@weldsuite/flow-domain/benefits';

const benefits = schema.projectBenefits;
const measurements = schema.projectBenefitMeasurements;

export type BenefitRow = typeof benefits.$inferSelect;
export type NewBenefitRow = typeof benefits.$inferInsert;
export type MeasurementRow = typeof measurements.$inferSelect;

/** A live benefit by id. */
export async function findBenefit(db: Database, id: string): Promise<BenefitRow | null> {
  const [row] = await db
    .select()
    .from(benefits)
    .where(and(eq(benefits.id, id), isNull(benefits.deletedAt)))
    .limit(1);
  return row ?? null;
}

/** The newest measurement of each benefit (by month), for a list. A benefit with none is absent. */
export async function latestMeasurements(db: Database, benefitIds: string[]): Promise<Map<string, MeasurementRow>> {
  const out = new Map<string, MeasurementRow>();
  if (benefitIds.length === 0) return out;
  const rows = await db
    .selectDistinctOn([measurements.benefitId])
    .from(measurements)
    .where(inArray(measurements.benefitId, benefitIds))
    .orderBy(measurements.benefitId, desc(measurements.period));
  for (const row of rows) out.set(row.benefitId, row);
  return out;
}

/** Every measurement of a benefit, oldest month first. */
export async function measurementsOf(db: Database, benefitId: string): Promise<MeasurementRow[]> {
  return db.select().from(measurements).where(eq(measurements.benefitId, benefitId)).orderBy(asc(measurements.period));
}

/** The benefit as every route answers it, with its newest measurement. */
export async function presentBenefitRow(db: Database, row: BenefitRow) {
  const latest = (await latestMeasurements(db, [row.id])).get(row.id);
  return presentBenefit(row, latestOf(latest ? [latest] : []));
}

/** The insert values of a new benefit. */
export function newBenefitValues(
  input: {
    projectId: string;
    title: string;
    description?: string | null;
    ownerId?: string | null;
    goalRef?: string | null;
    metric: string;
    metricParams: Record<string, unknown>;
    unit: string | null;
    baselineValue: string | null;
    targetValue: string | null;
    realiseBy: Date | null;
    status: 'planned' | 'measuring';
  },
  ctx: { id: string; number: number; userId: string; now: Date },
): NewBenefitRow {
  return {
    id: ctx.id,
    projectId: input.projectId,
    number: ctx.number,
    title: input.title,
    description: input.description ?? null,
    ownerId: input.ownerId ?? null,
    goalRef: input.goalRef ?? null,
    metric: input.metric,
    metricParams: input.metricParams,
    unit: input.unit,
    baselineValue: input.baselineValue,
    targetValue: input.targetValue,
    realiseBy: input.realiseBy,
    status: input.status,
    closedAt: null,
    createdBy: ctx.userId,
    createdAt: ctx.now,
    updatedAt: ctx.now,
  };
}

/**
 * Store a month's value (`period` is `YYYY-MM`). A manual entry (`measuredBy`
 * set) replaces whatever the month holds; the monthly sweep (`measuredBy` null)
 * never overwrites a value somebody typed in. The first value of a planned
 * benefit starts its measuring.
 */
export async function upsertMeasurement(
  db: Database,
  input: { benefitId: string; projectId: string; period: string; value: string; measuredBy: string | null; now: Date },
): Promise<void> {
  const values = { value: input.value, measuredAt: input.now, measuredBy: input.measuredBy };
  await db
    .insert(measurements)
    .values({
      id: generateId('bmea'),
      benefitId: input.benefitId,
      projectId: input.projectId,
      period: input.period,
      createdAt: input.now,
      ...values,
    })
    .onConflictDoUpdate({
      target: [measurements.benefitId, measurements.period],
      set: values,
      ...(input.measuredBy === null ? { setWhere: isNull(measurements.measuredBy) } : {}),
    });
  await db
    .update(benefits)
    .set({ status: 'measuring', updatedAt: input.now })
    .where(and(eq(benefits.id, input.benefitId), eq(benefits.status, 'planned'), isNull(benefits.deletedAt)));
}

/** The conditions a goal-card task filter puts on a project's tasks. */
export function taskFilterConditions(projectId: string, filter: GoalTaskFilter): SQL[] {
  const t = schema.tasks;
  const conditions: SQL[] = [eq(t.projectId, projectId), isNull(t.deletedAt), ne(t.status, 'cancelled')];
  if (filter.deliverableId) conditions.push(eq(t.deliverableId, filter.deliverableId));
  if (filter.milestoneId) conditions.push(eq(t.milestoneId, filter.milestoneId));
  if (filter.sprintId) conditions.push(eq(t.sprintId, filter.sprintId));
  if (filter.assigneeId) conditions.push(eq(t.assigneeId, filter.assigneeId));
  if (filter.type) conditions.push(eq(t.type, filter.type));
  if (filter.tag) conditions.push(sql`${t.tags} @> ${JSON.stringify([filter.tag])}::jsonb`);
  return conditions;
}

/** Done and total tasks of a project that match a goal-card task filter. */
export async function countFilteredTasks(
  db: Database,
  projectId: string,
  filter: GoalTaskFilter,
): Promise<{ done: number; total: number }> {
  const t = schema.tasks;
  const [row] = await db
    .select({
      total: sql<number>`count(*)`.mapWith(Number),
      done: sql<number>`count(*) filter (where ${t.status} = 'done')`.mapWith(Number),
    })
    .from(t)
    .where(and(...taskFilterConditions(projectId, filter)));
  return { done: row?.done ?? 0, total: row?.total ?? 0 };
}

/**
 * The project's goals canvas row. `project_goals` has no unique key on the
 * project, so every reader picks the same row as the goals routes do: one that
 * holds canvas data first, then the most recently written, then the id.
 */
export async function findGoalsCanvas(db: Database, projectId: string): Promise<{ goals: unknown[] } | null> {
  const g = schema.projectGoals;
  const [row] = await db
    .select({ goals: g.goals })
    .from(g)
    .where(and(eq(g.projectId, projectId), isNull(g.deletedAt)))
    .orderBy(
      sql`(CASE WHEN ${g.mission} IS NOT NULL OR jsonb_array_length(coalesce(${g.goals}, '[]'::jsonb)) > 0 THEN 0 ELSE 1 END)`,
      desc(g.updatedAt),
      desc(g.id),
    )
    .limit(1);
  return row ? { goals: Array.isArray(row.goals) ? row.goals : [] } : null;
}
