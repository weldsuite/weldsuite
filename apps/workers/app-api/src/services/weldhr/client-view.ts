/**
 * What a client sees about the team on their account.
 *
 * Used twice: by the workforce portal for a signed-in client, and by the
 * platform's client page as a "preview what the client sees". Keeping one
 * implementation is the point — the preview can never drift from reality.
 *
 * Only data explicitly shared is included: evaluations and KPI values with
 * `shared_with_client`, milestones with `shared_with_client`, coaching logs
 * with visibility `client`. Attendance is only ever an aggregate. When the
 * workspace turns off `clientCanSeeIndividualScores`, per-person scores are
 * dropped and only team averages remain.
 */

import { and, eq, gte, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { schema, type Database } from '../../db';
import { displayNameOf } from './employees';
import { attendanceSummary } from './time';
import { averageScores, listCoachingLogs, listEvaluations, listKpiValues, listMilestones } from './performance';
import { addDays, todayIso } from './shared';

export interface ClientViewOptions {
  /** Workspace setting: may a client see one person's score, or only team averages? */
  individualScores: boolean;
  /** How far back KPI and evaluation history reaches. */
  days?: number;
}

export async function clientTeam(db: Database, companyId: string, on: string = todayIso()) {
  const a = schema.hrClientAssignments;
  const e = schema.hrEmployees;
  const rows = await db
    .select({
      employeeId: e.id,
      firstName: e.firstName,
      lastName: e.lastName,
      preferredName: e.preferredName,
      jobTitle: e.jobTitle,
      avatarUrl: e.avatarUrl,
      pronouns: e.pronouns,
      status: e.status,
      role: a.role,
      allocationPercent: a.allocationPercent,
      isPrimary: a.isPrimary,
      assignedSince: a.startDate,
    })
    .from(a)
    .innerJoin(e, eq(e.id, a.employeeId))
    .where(
      and(
        eq(a.companyId, companyId),
        isNull(e.deletedAt),
        sql`${e.status} <> 'terminated'`,
        lte(a.startDate, on),
        or(isNull(a.endDate), gte(a.endDate, on)),
      ),
    );
  // An employee can hold two assignments on one account (e.g. role change); show them once.
  const seen = new Map<string, (typeof rows)[number]>();
  for (const row of rows) {
    const prev = seen.get(row.employeeId);
    if (!prev || row.assignedSince < prev.assignedSince) seen.set(row.employeeId, row);
  }
  return [...seen.values()]
    .map((r) => ({
      employeeId: r.employeeId,
      displayName: displayNameOf(r),
      jobTitle: r.jobTitle,
      avatarUrl: r.avatarUrl,
      pronouns: r.pronouns,
      status: r.status,
      role: r.role,
      allocationPercent: r.allocationPercent,
      assignedSince: r.assignedSince,
    }))
    .sort((x, y) => x.displayName.localeCompare(y.displayName));
}

export async function buildClientView(db: Database, companyId: string, opts: ClientViewOptions) {
  const today = todayIso();
  const since = addDays(today, -(opts.days ?? 180));
  const team = await clientTeam(db, companyId, today);
  const employeeIds = team.map((m) => m.employeeId);

  const [kpiValues, evaluations, milestones, coaching, attendance, scores] = await Promise.all([
    listKpiValues(db, { employeeIds, sharedWithClient: true, from: since }),
    listEvaluations(db, { employeeIds, sharedWithClient: true, status: 'submitted,acknowledged', from: since }),
    listMilestones(db, { employeeIds, sharedWithClient: true }),
    listCoachingLogs(db, { employeeIds, visibilities: ['client'], from: since }),
    attendanceSummary(db, { from: addDays(today, -30), to: today, employeeIds }),
    averageScores(db, employeeIds, { sharedOnly: true }),
  ]);

  // Only values recorded against this account, or not tied to any account.
  const accountScoped = <T extends { companyId: string | null }>(rows: T[]) =>
    rows.filter((r) => r.companyId === null || r.companyId === companyId);

  const kpis = aggregateKpis(accountScoped(kpiValues));
  const scoredEvaluations = accountScoped(evaluations).filter((x) => x.overallScore !== null);
  const teamAverage = scoredEvaluations.length
    ? Math.round((scoredEvaluations.reduce((s, x) => s + (x.overallScore ?? 0), 0) / scoredEvaluations.length) * 10) / 10
    : null;

  return {
    companyId,
    generatedAt: new Date().toISOString(),
    individualScores: opts.individualScores,
    team: team.map((member) => ({
      ...member,
      averageScore: opts.individualScores ? scores.get(member.employeeId)?.average ?? null : null,
    })),
    summary: {
      headcount: team.length,
      fte: Math.round(team.reduce((s, m) => s + m.allocationPercent, 0)) / 100,
      averageEvaluationScore: teamAverage,
      evaluationsCount: scoredEvaluations.length,
      attendanceRate30d: attendance.attendanceRate,
      milestonesAchieved: milestones.filter((m) => m.status === 'achieved').length,
      milestonesOpen: milestones.filter((m) => m.status === 'planned' || m.status === 'in_progress').length,
    },
    kpis: kpis.map((k) => ({ ...k, byEmployee: opts.individualScores ? k.byEmployee : [] })),
    evaluations: opts.individualScores
      ? scoredEvaluations.map((x) => ({
          id: x.id,
          employeeId: x.employeeId,
          employeeName: x.employeeName,
          formName: x.formName,
          periodStart: x.periodStart,
          periodEnd: x.periodEnd,
          overallScore: x.overallScore,
          summary: x.summary,
          submittedAt: x.submittedAt,
        }))
      : [],
    milestones: accountScoped(milestones).map((m) => ({
      id: m.id,
      employeeId: m.employeeId,
      employeeName: m.employeeName,
      title: m.title,
      description: m.description,
      type: m.type,
      status: m.status,
      dueDate: m.dueDate,
      achievedAt: m.achievedAt,
    })),
    coaching: accountScoped(coaching).map((c) => ({
      id: c.id,
      employeeId: c.employeeId,
      employeeName: c.employeeName,
      sessionDate: c.sessionDate,
      category: c.category,
      topic: c.topic,
      status: c.status,
    })),
  };
}

type KpiRow = Awaited<ReturnType<typeof listKpiValues>>[number];

/** Latest period per KPI with the team average, plus a short trend of earlier periods. */
function aggregateKpis(values: KpiRow[]) {
  const byKpi = new Map<string, KpiRow[]>();
  for (const v of values) {
    const list = byKpi.get(v.kpiId) ?? [];
    list.push(v);
    byKpi.set(v.kpiId, list);
  }
  return [...byKpi.entries()].map(([kpiId, rows]) => {
    const periods = new Map<string, KpiRow[]>();
    for (const r of rows) {
      const key = `${r.periodStart}|${r.periodEnd}`;
      const list = periods.get(key) ?? [];
      list.push(r);
      periods.set(key, list);
    }
    const trend = [...periods.entries()]
      .map(([key, list]) => {
        const [periodStart, periodEnd] = key.split('|') as [string, string];
        return {
          periodStart,
          periodEnd,
          average: Math.round((list.reduce((s, r) => s + r.value, 0) / list.length) * 100) / 100,
          count: list.length,
        };
      })
      .sort((x, y) => x.periodStart.localeCompare(y.periodStart));
    const latest = trend[trend.length - 1] ?? null;
    const first = rows[0]!;
    const latestRows = latest ? periods.get(`${latest.periodStart}|${latest.periodEnd}`) ?? [] : [];
    return {
      kpiId,
      name: first.kpiName,
      unit: first.unit,
      direction: first.direction,
      target: first.target,
      latest,
      onTarget:
        latest && first.target !== null
          ? first.direction === 'lower_better'
            ? latest.average <= first.target
            : latest.average >= first.target
          : null,
      trend: trend.slice(-12),
      byEmployee: latestRows.map((r) => ({ employeeId: r.employeeId, employeeName: r.employeeName, value: r.value })),
    };
  });
}

/** Companies a set of client contacts could be granted — used to validate portal invites. */
export async function companyExists(db: Database, companyId: string) {
  const [row] = await db
    .select({ id: schema.companies.id })
    .from(schema.companies)
    .where(and(eq(schema.companies.id, companyId), isNull(schema.companies.deletedAt)))
    .limit(1);
  return Boolean(row);
}

export async function personAtCompany(db: Database, personId: string, companyId: string) {
  const [person] = await db
    .select({
      id: schema.people.id,
      email: schema.people.email,
      fullName: schema.people.fullName,
      firstName: schema.people.firstName,
      lastName: schema.people.lastName,
    })
    .from(schema.people)
    .where(and(eq(schema.people.id, personId), isNull(schema.people.deletedAt)))
    .limit(1);
  if (!person) return null;
  const pc = schema.personCompanies;
  const [link] = await db
    .select({ id: pc.id })
    .from(pc)
    .where(and(eq(pc.personId, personId), eq(pc.companyId, companyId)))
    .limit(1);
  return { ...person, linked: Boolean(link) };
}

export async function employeesOfCompanies(db: Database, companyIds: string[]) {
  if (companyIds.length === 0) return [];
  const a = schema.hrClientAssignments;
  const today = todayIso();
  const rows = await db
    .selectDistinct({ employeeId: a.employeeId })
    .from(a)
    .where(and(inArray(a.companyId, companyIds), lte(a.startDate, today), or(isNull(a.endDate), gte(a.endDate, today))));
  return rows.map((r) => r.employeeId);
}
