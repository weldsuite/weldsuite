/**
 * Coaching logs, evaluation scorecards, KPIs and milestones.
 *
 * An evaluation snapshots its form's criteria when it is created, so editing a
 * form later never rescores history. The overall score is the weighted mean of
 * each criterion's score as a percentage of its max, 0–100.
 */

import { and, asc, desc, eq, gte, inArray, isNull, lte, sql, type SQL } from 'drizzle-orm';
import type {
  HrCoachingActionItem,
  HrEvaluationCriterion,
  HrEvaluationScore,
} from '@weldsuite/db/schema';
import { schema, type Database } from '../../db';
import { generateId } from '../../lib/id';
import { displayNameOf, requireEmployee } from './employees';
import { resolveEmployeeRefs } from './time';
import {
  HrConflictError,
  HrNotFoundError,
  HrValidationError,
  assertDateOrder,
  companyNames,
  memberNames,
} from './shared';

const co = schema.hrCoachingLogs;
const ef = schema.hrEvaluationForms;
const ev = schema.hrEvaluations;
const kd = schema.hrKpiDefinitions;
const kv = schema.hrKpiValues;
const ms = schema.hrMilestones;
const emp = schema.hrEmployees;

const employeeNameColumns = {
  employeeFirstName: emp.firstName,
  employeeLastName: emp.lastName,
  employeePreferredName: emp.preferredName,
};

function employeeName(row: { employeeFirstName: string; employeeLastName: string; employeePreferredName: string | null }) {
  return displayNameOf({ firstName: row.employeeFirstName, lastName: row.employeeLastName, preferredName: row.employeePreferredName });
}

// ---------------------------------------------------------------------------
// Coaching
// ---------------------------------------------------------------------------

export async function requireCoachingLog(db: Database, id: string) {
  const [row] = await db.select().from(co).where(and(eq(co.id, id), isNull(co.deletedAt))).limit(1);
  if (!row) throw new HrNotFoundError('Coaching log', id);
  return row;
}

export async function listCoachingLogs(
  db: Database,
  filters: {
    employeeId?: string;
    employeeIds?: string[];
    companyId?: string;
    status?: string;
    category?: string;
    from?: string;
    to?: string;
    followUpDue?: boolean;
    visibilities?: string[];
  },
) {
  const conditions: SQL[] = [isNull(co.deletedAt), isNull(emp.deletedAt)];
  if (filters.employeeId) conditions.push(eq(co.employeeId, filters.employeeId));
  if (filters.employeeIds) {
    if (filters.employeeIds.length === 0) return [];
    conditions.push(inArray(co.employeeId, filters.employeeIds));
  }
  if (filters.companyId) conditions.push(eq(co.companyId, filters.companyId));
  if (filters.status) conditions.push(inArray(co.status, filters.status.split(',')));
  if (filters.category) conditions.push(eq(co.category, filters.category));
  if (filters.from) conditions.push(gte(co.sessionDate, filters.from));
  if (filters.to) conditions.push(lte(co.sessionDate, filters.to));
  if (filters.visibilities) conditions.push(inArray(co.visibility, filters.visibilities));
  if (filters.followUpDue) {
    conditions.push(sql`${co.followUpDate} is not null and ${co.followUpDate} <= current_date and ${co.status} <> 'closed'`);
  }
  const rows = await db
    .select({ log: co, ...employeeNameColumns })
    .from(co)
    .innerJoin(emp, eq(emp.id, co.employeeId))
    .where(and(...conditions))
    .orderBy(desc(co.sessionDate), desc(co.createdAt))
    .limit(1000);
  const [coaches, companies] = await Promise.all([
    memberNames(db, rows.map((r) => r.log.coachUserId)),
    companyNames(db, rows.map((r) => r.log.companyId)),
  ]);
  return rows.map((r) => ({
    ...r.log,
    employeeName: employeeName(r),
    coachName: r.log.coachName ?? (r.log.coachUserId ? coaches.get(r.log.coachUserId) ?? null : null),
    companyName: r.log.companyId ? companies.get(r.log.companyId) ?? null : null,
  }));
}

type CoachingWrite = {
  companyId?: string | null;
  coachUserId?: string | null;
  coachName?: string | null;
  sessionDate?: string;
  category?: string;
  topic?: string;
  notes?: string | null;
  actionItems?: HrCoachingActionItem[];
  followUpDate?: string | null;
  status?: string;
  visibility?: string;
};

export async function createCoachingLog(
  db: Database,
  input: CoachingWrite & { employeeId: string; sessionDate: string; topic: string },
  actorId: string,
) {
  await requireEmployee(db, input.employeeId);
  const coachUserId = input.coachUserId ?? actorId;
  let coachName = input.coachName ?? null;
  if (!coachName) coachName = (await memberNames(db, [coachUserId])).get(coachUserId) ?? null;
  const [row] = await db
    .insert(co)
    .values({
      id: generateId('hrcch'),
      ...input,
      coachUserId,
      coachName,
      actionItems: input.actionItems ?? [],
    })
    .returning();
  return row!;
}

export async function updateCoachingLog(db: Database, id: string, input: CoachingWrite) {
  await requireCoachingLog(db, id);
  const [row] = await db.update(co).set({ ...input, updatedAt: new Date() }).where(eq(co.id, id)).returning();
  return row!;
}

export async function deleteCoachingLog(db: Database, id: string) {
  await requireCoachingLog(db, id);
  const now = new Date();
  await db.update(co).set({ deletedAt: now, updatedAt: now }).where(eq(co.id, id));
}

/** Employee acknowledgement from the portal. Only logs shared with the employee can be acknowledged. */
export async function acknowledgeCoachingLog(db: Database, id: string, employeeId: string, comment?: string | null) {
  const log = await requireCoachingLog(db, id);
  if (log.employeeId !== employeeId || log.visibility === 'internal') throw new HrNotFoundError('Coaching log', id);
  if (log.acknowledgedAt) throw new HrConflictError('Already acknowledged');
  const [row] = await db
    .update(co)
    .set({
      acknowledgedAt: new Date(),
      employeeComment: comment ?? null,
      status: log.status === 'open' ? 'acknowledged' : log.status,
      updatedAt: new Date(),
    })
    .where(eq(co.id, id))
    .returning();
  return row!;
}

// ---------------------------------------------------------------------------
// Evaluation forms
// ---------------------------------------------------------------------------

export async function listEvaluationForms(db: Database, includeInactive = true) {
  const conditions: SQL[] = [isNull(ef.deletedAt)];
  if (!includeInactive) conditions.push(eq(ef.isActive, true));
  return db.select().from(ef).where(and(...conditions)).orderBy(asc(ef.name));
}

export async function requireEvaluationForm(db: Database, id: string) {
  const [row] = await db.select().from(ef).where(and(eq(ef.id, id), isNull(ef.deletedAt))).limit(1);
  if (!row) throw new HrNotFoundError('Evaluation form', id);
  return row;
}

function assertCriteria(criteria: HrEvaluationCriterion[]) {
  const ids = new Set<string>();
  for (const c of criteria) {
    if (ids.has(c.id)) throw new HrValidationError(`Duplicate criterion id "${c.id}"`);
    ids.add(c.id);
  }
  if (criteria.reduce((sum, c) => sum + c.weight, 0) <= 0) {
    throw new HrValidationError('At least one criterion needs a weight above zero');
  }
}

export async function createEvaluationForm(
  db: Database,
  input: { name: string; description?: string | null; criteria: HrEvaluationCriterion[]; isActive?: boolean },
) {
  assertCriteria(input.criteria);
  const [row] = await db.insert(ef).values({ id: generateId('hrevf'), ...input }).returning();
  return row!;
}

export async function updateEvaluationForm(
  db: Database,
  id: string,
  input: { name?: string; description?: string | null; criteria?: HrEvaluationCriterion[]; isActive?: boolean },
) {
  await requireEvaluationForm(db, id);
  if (input.criteria) assertCriteria(input.criteria);
  const [row] = await db.update(ef).set({ ...input, updatedAt: new Date() }).where(eq(ef.id, id)).returning();
  return row!;
}

export async function deleteEvaluationForm(db: Database, id: string) {
  await requireEvaluationForm(db, id);
  const now = new Date();
  await db.update(ef).set({ deletedAt: now, updatedAt: now }).where(eq(ef.id, id));
}

export async function ensureDefaultEvaluationForm(db: Database) {
  const [existing] = await db.select({ id: ef.id }).from(ef).limit(1);
  if (existing) return;
  await db.insert(ef).values({
    id: generateId('hrevf'),
    name: 'Quality scorecard',
    description: 'Monthly quality and performance review.',
    criteria: [
      { id: 'quality', label: 'Quality of work', weight: 30, maxScore: 5 },
      { id: 'productivity', label: 'Productivity', weight: 25, maxScore: 5 },
      { id: 'communication', label: 'Communication', weight: 20, maxScore: 5 },
      { id: 'reliability', label: 'Attendance and reliability', weight: 15, maxScore: 5 },
      { id: 'teamwork', label: 'Teamwork', weight: 10, maxScore: 5 },
    ],
  });
}

// ---------------------------------------------------------------------------
// Evaluations
// ---------------------------------------------------------------------------

/** Weighted mean of criterion percentages, 0–100, one decimal. Null until something is scored. */
export function overallScore(criteria: HrEvaluationCriterion[], scores: HrEvaluationScore[]): number | null {
  const byId = new Map(scores.map((s) => [s.criterionId, s.score]));
  let weighted = 0;
  let weights = 0;
  for (const c of criteria) {
    const score = byId.get(c.id);
    if (score === undefined || c.weight <= 0 || c.maxScore <= 0) continue;
    weighted += (Math.min(score, c.maxScore) / c.maxScore) * c.weight;
    weights += c.weight;
  }
  if (weights === 0) return null;
  return Math.round((weighted / weights) * 1000) / 10;
}

function assertScores(criteria: HrEvaluationCriterion[], scores: HrEvaluationScore[]) {
  const byId = new Map(criteria.map((c) => [c.id, c]));
  for (const s of scores) {
    const c = byId.get(s.criterionId);
    if (!c) throw new HrValidationError(`Unknown criterion "${s.criterionId}"`);
    if (s.score > c.maxScore) throw new HrValidationError(`"${c.label}" is scored out of ${c.maxScore}`);
  }
}

export async function requireEvaluation(db: Database, id: string) {
  const [row] = await db.select().from(ev).where(and(eq(ev.id, id), isNull(ev.deletedAt))).limit(1);
  if (!row) throw new HrNotFoundError('Evaluation', id);
  return row;
}

export async function listEvaluations(
  db: Database,
  filters: {
    employeeId?: string;
    employeeIds?: string[];
    companyId?: string;
    status?: string;
    formId?: string;
    sharedWithClient?: boolean;
    from?: string;
    to?: string;
  },
) {
  const conditions: SQL[] = [isNull(ev.deletedAt), isNull(emp.deletedAt)];
  if (filters.employeeId) conditions.push(eq(ev.employeeId, filters.employeeId));
  if (filters.employeeIds) {
    if (filters.employeeIds.length === 0) return [];
    conditions.push(inArray(ev.employeeId, filters.employeeIds));
  }
  if (filters.companyId) conditions.push(eq(ev.companyId, filters.companyId));
  if (filters.status) conditions.push(inArray(ev.status, filters.status.split(',')));
  if (filters.formId) conditions.push(eq(ev.formId, filters.formId));
  if (filters.sharedWithClient !== undefined) conditions.push(eq(ev.sharedWithClient, filters.sharedWithClient));
  if (filters.from) conditions.push(gte(sql`coalesce(${ev.periodEnd}, ${ev.createdAt}::date)`, filters.from));
  if (filters.to) conditions.push(lte(sql`coalesce(${ev.periodStart}, ${ev.createdAt}::date)`, filters.to));
  const rows = await db
    .select({ evaluation: ev, ...employeeNameColumns, formName: ef.name })
    .from(ev)
    .innerJoin(emp, eq(emp.id, ev.employeeId))
    .leftJoin(ef, eq(ef.id, ev.formId))
    .where(and(...conditions))
    .orderBy(desc(ev.createdAt))
    .limit(1000);
  const [evaluators, companies] = await Promise.all([
    memberNames(db, rows.map((r) => r.evaluation.evaluatorUserId)),
    companyNames(db, rows.map((r) => r.evaluation.companyId)),
  ]);
  return rows.map((r) => ({
    ...r.evaluation,
    employeeName: employeeName(r),
    formName: r.formName,
    evaluatorName:
      r.evaluation.evaluatorName ??
      (r.evaluation.evaluatorUserId ? evaluators.get(r.evaluation.evaluatorUserId) ?? null : null),
    companyName: r.evaluation.companyId ? companies.get(r.evaluation.companyId) ?? null : null,
  }));
}

export async function createEvaluation(
  db: Database,
  input: {
    employeeId: string;
    formId: string;
    companyId?: string | null;
    periodStart?: string | null;
    periodEnd?: string | null;
    scores?: HrEvaluationScore[];
    summary?: string | null;
    sharedWithClient?: boolean;
    submit?: boolean;
  },
  evaluatorUserId: string,
) {
  assertDateOrder(input.periodStart, input.periodEnd, 'Evaluation period');
  await requireEmployee(db, input.employeeId);
  const form = await requireEvaluationForm(db, input.formId);
  const scores = input.scores ?? [];
  assertScores(form.criteria, scores);
  const evaluatorName = (await memberNames(db, [evaluatorUserId])).get(evaluatorUserId) ?? null;
  const [row] = await db
    .insert(ev)
    .values({
      id: generateId('hrevl'),
      employeeId: input.employeeId,
      formId: form.id,
      companyId: input.companyId ?? null,
      evaluatorUserId,
      evaluatorName,
      periodStart: input.periodStart ?? null,
      periodEnd: input.periodEnd ?? null,
      criteria: form.criteria,
      scores,
      overallScore: overallScore(form.criteria, scores),
      summary: input.summary ?? null,
      sharedWithClient: input.sharedWithClient ?? false,
      status: input.submit ? 'submitted' : 'draft',
      submittedAt: input.submit ? new Date() : null,
    })
    .returning();
  return row!;
}

export async function updateEvaluation(
  db: Database,
  id: string,
  input: {
    companyId?: string | null;
    periodStart?: string | null;
    periodEnd?: string | null;
    scores?: HrEvaluationScore[];
    summary?: string | null;
    sharedWithClient?: boolean;
    submit?: boolean;
  },
) {
  const existing = await requireEvaluation(db, id);
  if (existing.status === 'acknowledged' && (input.scores || input.summary !== undefined)) {
    throw new HrConflictError('An acknowledged evaluation can no longer be rescored');
  }
  const { submit, ...rest } = input;
  const scores = input.scores ?? existing.scores;
  if (input.scores) assertScores(existing.criteria, input.scores);
  const patch: Partial<typeof ev.$inferInsert> = {
    ...rest,
    scores,
    overallScore: overallScore(existing.criteria, scores),
    updatedAt: new Date(),
  };
  if (submit && existing.status === 'draft') {
    patch.status = 'submitted';
    patch.submittedAt = new Date();
  }
  const [row] = await db.update(ev).set(patch).where(eq(ev.id, id)).returning();
  return row!;
}

export async function deleteEvaluation(db: Database, id: string) {
  await requireEvaluation(db, id);
  const now = new Date();
  await db.update(ev).set({ deletedAt: now, updatedAt: now }).where(eq(ev.id, id));
}

export async function acknowledgeEvaluation(db: Database, id: string, employeeId: string, comment?: string | null) {
  const row = await requireEvaluation(db, id);
  if (row.employeeId !== employeeId || row.status === 'draft') throw new HrNotFoundError('Evaluation', id);
  if (row.status === 'acknowledged') throw new HrConflictError('Already acknowledged');
  const [updated] = await db
    .update(ev)
    .set({ status: 'acknowledged', acknowledgedAt: new Date(), employeeComment: comment ?? null, updatedAt: new Date() })
    .where(eq(ev.id, id))
    .returning();
  return updated!;
}

// ---------------------------------------------------------------------------
// KPIs
// ---------------------------------------------------------------------------

export async function listKpiDefinitions(db: Database, filters: { companyId?: string; includeInactive?: boolean } = {}) {
  const conditions: SQL[] = [];
  if (!filters.includeInactive) conditions.push(eq(kd.isActive, true));
  if (filters.companyId) conditions.push(sql`(${kd.companyId} is null or ${kd.companyId} = ${filters.companyId})`);
  const rows = await db.select().from(kd).where(conditions.length ? and(...conditions) : undefined).orderBy(asc(kd.name));
  const names = await companyNames(db, rows.map((r) => r.companyId));
  return rows.map((r) => ({ ...r, companyName: r.companyId ? names.get(r.companyId) ?? null : null }));
}

export async function requireKpiDefinition(db: Database, id: string) {
  const [row] = await db.select().from(kd).where(eq(kd.id, id)).limit(1);
  if (!row) throw new HrNotFoundError('KPI', id);
  return row;
}

type KpiDefinitionInput = {
  name?: string;
  description?: string | null;
  unit?: string;
  direction?: string;
  target?: number | null;
  companyId?: string | null;
  isActive?: boolean;
};

export async function createKpiDefinition(db: Database, input: KpiDefinitionInput & { name: string }) {
  const [row] = await db.insert(kd).values({ id: generateId('hrkpi'), ...input }).returning();
  return row!;
}

export async function updateKpiDefinition(db: Database, id: string, input: KpiDefinitionInput) {
  await requireKpiDefinition(db, id);
  const [row] = await db.update(kd).set({ ...input, updatedAt: new Date() }).where(eq(kd.id, id)).returning();
  return row!;
}

export async function deleteKpiDefinition(db: Database, id: string) {
  await requireKpiDefinition(db, id);
  const [used] = await db.select({ id: kv.id }).from(kv).where(eq(kv.kpiId, id)).limit(1);
  if (used) {
    await db.update(kd).set({ isActive: false, updatedAt: new Date() }).where(eq(kd.id, id));
    return { archived: true };
  }
  await db.delete(kd).where(eq(kd.id, id));
  return { archived: false };
}

export async function ensureDefaultKpis(db: Database) {
  const [existing] = await db.select({ id: kd.id }).from(kd).limit(1);
  if (existing) return;
  await db.insert(kd).values([
    { id: generateId('hrkpi'), name: 'CSAT', unit: 'percent', direction: 'higher_better', target: 90, description: 'Customer satisfaction score' },
    { id: generateId('hrkpi'), name: 'Quality score', unit: 'percent', direction: 'higher_better', target: 85 },
    { id: generateId('hrkpi'), name: 'Average handle time', unit: 'seconds', direction: 'lower_better', target: 360 },
    { id: generateId('hrkpi'), name: 'First contact resolution', unit: 'percent', direction: 'higher_better', target: 75 },
  ]);
}

export async function listKpiValues(
  db: Database,
  filters: {
    employeeId?: string;
    employeeIds?: string[];
    kpiId?: string;
    companyId?: string;
    from?: string;
    to?: string;
    sharedWithClient?: boolean;
  },
) {
  const conditions: SQL[] = [isNull(emp.deletedAt)];
  if (filters.employeeId) conditions.push(eq(kv.employeeId, filters.employeeId));
  if (filters.employeeIds) {
    if (filters.employeeIds.length === 0) return [];
    conditions.push(inArray(kv.employeeId, filters.employeeIds));
  }
  if (filters.kpiId) conditions.push(eq(kv.kpiId, filters.kpiId));
  if (filters.companyId) conditions.push(eq(kv.companyId, filters.companyId));
  if (filters.from) conditions.push(gte(kv.periodEnd, filters.from));
  if (filters.to) conditions.push(lte(kv.periodStart, filters.to));
  if (filters.sharedWithClient !== undefined) conditions.push(eq(kv.sharedWithClient, filters.sharedWithClient));
  const rows = await db
    .select({
      value: kv,
      ...employeeNameColumns,
      kpiName: kd.name,
      unit: kd.unit,
      direction: kd.direction,
      target: kd.target,
    })
    .from(kv)
    .innerJoin(emp, eq(emp.id, kv.employeeId))
    .innerJoin(kd, eq(kd.id, kv.kpiId))
    .where(and(...conditions))
    .orderBy(desc(kv.periodStart), asc(kd.name))
    .limit(5000);
  return rows.map((r) => ({
    ...r.value,
    employeeName: employeeName(r),
    kpiName: r.kpiName,
    unit: r.unit,
    direction: r.direction,
    target: r.target,
    onTarget: r.target === null ? null : r.direction === 'lower_better' ? r.value.value <= r.target : r.value.value >= r.target,
  }));
}

export async function requireKpiValue(db: Database, id: string) {
  const [row] = await db.select().from(kv).where(eq(kv.id, id)).limit(1);
  if (!row) throw new HrNotFoundError('KPI value', id);
  return row;
}

export async function createKpiValue(
  db: Database,
  input: {
    kpiId: string;
    employeeId: string;
    companyId?: string | null;
    periodStart: string;
    periodEnd: string;
    value: number;
    sharedWithClient?: boolean;
  },
  createdBy: string,
  source = 'manual',
) {
  assertDateOrder(input.periodStart, input.periodEnd, 'KPI period');
  await requireKpiDefinition(db, input.kpiId);
  await requireEmployee(db, input.employeeId);
  const [row] = await db
    .insert(kv)
    .values({ id: generateId('hrkpv'), ...input, sharedWithClient: input.sharedWithClient ?? false, source, createdBy })
    .returning();
  return row!;
}

export async function updateKpiValue(
  db: Database,
  id: string,
  input: { companyId?: string | null; periodStart?: string; periodEnd?: string; value?: number; sharedWithClient?: boolean },
) {
  const existing = await requireKpiValue(db, id);
  assertDateOrder(input.periodStart ?? existing.periodStart, input.periodEnd ?? existing.periodEnd, 'KPI period');
  const [row] = await db.update(kv).set({ ...input, updatedAt: new Date() }).where(eq(kv.id, id)).returning();
  return row!;
}

export async function deleteKpiValue(db: Database, id: string) {
  await requireKpiValue(db, id);
  await db.delete(kv).where(eq(kv.id, id));
}

/** Upsert per (kpi, employee, period) — re-importing the same file updates instead of duplicating. */
export async function importKpiValues(
  db: Database,
  input: {
    kpiId: string;
    periodStart: string;
    periodEnd: string;
    sharedWithClient?: boolean;
    rows: Array<{ employee: string; value: number; companyId?: string | null }>;
  },
  createdBy: string,
) {
  assertDateOrder(input.periodStart, input.periodEnd, 'KPI period');
  await requireKpiDefinition(db, input.kpiId);
  const refs = await resolveEmployeeRefs(db, input.rows.map((r) => r.employee));
  const result = { created: 0, updated: 0, errors: [] as Array<{ row: number; reason: string }> };
  for (const [index, row] of input.rows.entries()) {
    const employeeId = refs.get(row.employee.trim().toLowerCase()) ?? refs.get(row.employee.trim());
    if (!employeeId) {
      result.errors.push({ row: index + 1, reason: `No employee matches "${row.employee}"` });
      continue;
    }
    const [existing] = await db
      .select({ id: kv.id })
      .from(kv)
      .where(
        and(
          eq(kv.kpiId, input.kpiId),
          eq(kv.employeeId, employeeId),
          eq(kv.periodStart, input.periodStart),
          eq(kv.periodEnd, input.periodEnd),
        ),
      )
      .limit(1);
    if (existing) {
      await db
        .update(kv)
        .set({
          value: row.value,
          companyId: row.companyId ?? null,
          sharedWithClient: input.sharedWithClient ?? false,
          source: 'import',
          updatedAt: new Date(),
        })
        .where(eq(kv.id, existing.id));
      result.updated += 1;
    } else {
      await db.insert(kv).values({
        id: generateId('hrkpv'),
        kpiId: input.kpiId,
        employeeId,
        companyId: row.companyId ?? null,
        periodStart: input.periodStart,
        periodEnd: input.periodEnd,
        value: row.value,
        sharedWithClient: input.sharedWithClient ?? false,
        source: 'import',
        createdBy,
      });
      result.created += 1;
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Milestones
// ---------------------------------------------------------------------------

export async function requireMilestone(db: Database, id: string) {
  const [row] = await db.select().from(ms).where(and(eq(ms.id, id), isNull(ms.deletedAt))).limit(1);
  if (!row) throw new HrNotFoundError('Milestone', id);
  return row;
}

export async function listMilestones(
  db: Database,
  filters: { employeeId?: string; employeeIds?: string[]; companyId?: string; status?: string; sharedWithClient?: boolean },
) {
  const conditions: SQL[] = [isNull(ms.deletedAt), isNull(emp.deletedAt)];
  if (filters.employeeId) conditions.push(eq(ms.employeeId, filters.employeeId));
  if (filters.employeeIds) {
    if (filters.employeeIds.length === 0) return [];
    conditions.push(inArray(ms.employeeId, filters.employeeIds));
  }
  if (filters.companyId) conditions.push(eq(ms.companyId, filters.companyId));
  if (filters.status) conditions.push(inArray(ms.status, filters.status.split(',')));
  if (filters.sharedWithClient !== undefined) conditions.push(eq(ms.sharedWithClient, filters.sharedWithClient));
  const rows = await db
    .select({ milestone: ms, ...employeeNameColumns })
    .from(ms)
    .innerJoin(emp, eq(emp.id, ms.employeeId))
    .where(and(...conditions))
    .orderBy(sql`${ms.dueDate} asc nulls last`, desc(ms.createdAt))
    .limit(1000);
  const companies = await companyNames(db, rows.map((r) => r.milestone.companyId));
  return rows.map((r) => ({
    ...r.milestone,
    employeeName: employeeName(r),
    companyName: r.milestone.companyId ? companies.get(r.milestone.companyId) ?? null : null,
  }));
}

type MilestoneWrite = {
  companyId?: string | null;
  title?: string;
  description?: string | null;
  type?: string;
  status?: string;
  dueDate?: string | null;
  achievedAt?: string | null;
  sharedWithClient?: boolean;
};

function withAchievedDate<T extends MilestoneWrite>(input: T): T {
  if (input.status === 'achieved' && input.achievedAt === undefined) {
    return { ...input, achievedAt: new Date().toISOString().slice(0, 10) };
  }
  return input;
}

export async function createMilestone(db: Database, input: MilestoneWrite & { employeeId: string; title: string }, createdBy: string) {
  await requireEmployee(db, input.employeeId);
  const [row] = await db
    .insert(ms)
    .values({ id: generateId('hrmil'), ...withAchievedDate(input), createdBy })
    .returning();
  return row!;
}

export async function updateMilestone(db: Database, id: string, input: MilestoneWrite) {
  const existing = await requireMilestone(db, id);
  const patch = existing.achievedAt ? input : withAchievedDate(input);
  const [row] = await db.update(ms).set({ ...patch, updatedAt: new Date() }).where(eq(ms.id, id)).returning();
  return { milestone: row!, justAchieved: existing.status !== 'achieved' && row!.status === 'achieved' };
}

export async function deleteMilestone(db: Database, id: string) {
  await requireMilestone(db, id);
  const now = new Date();
  await db.update(ms).set({ deletedAt: now, updatedAt: now }).where(eq(ms.id, id));
}

// ---------------------------------------------------------------------------
// Rollups
// ---------------------------------------------------------------------------

/** Mean of submitted/acknowledged overall scores per employee in the set. */
export async function averageScores(db: Database, employeeIds: string[], opts: { sharedOnly?: boolean } = {}) {
  const out = new Map<string, { average: number; count: number }>();
  if (employeeIds.length === 0) return out;
  const conditions: SQL[] = [
    inArray(ev.employeeId, employeeIds),
    isNull(ev.deletedAt),
    inArray(ev.status, ['submitted', 'acknowledged']),
    sql`${ev.overallScore} is not null`,
  ];
  if (opts.sharedOnly) conditions.push(eq(ev.sharedWithClient, true));
  const rows = await db
    .select({
      employeeId: ev.employeeId,
      average: sql<number>`avg(${ev.overallScore})`,
      count: sql<number>`count(*)`,
    })
    .from(ev)
    .where(and(...conditions))
    .groupBy(ev.employeeId);
  for (const row of rows) {
    out.set(row.employeeId, { average: Math.round(Number(row.average) * 10) / 10, count: Number(row.count) });
  }
  return out;
}
