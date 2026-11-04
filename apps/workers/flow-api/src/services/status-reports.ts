/**
 * Status report data: what a draft is computed from and who it goes to
 * (design: weldflow-delivery-and-portfolio.md, ADR FLOW-018).
 *
 * The rules (colours, periods, slots, merging, the wire shape) are in
 * `@weldsuite/flow-domain/status-report`; this file is the database side. It
 * reads the project-control and finance tables directly (baselines,
 * deliverables, change requests, RAID, benefits, finance snapshots), so the
 * report does not depend on the routes of the slices that write them.
 */

import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lte, ne, or, sql } from 'drizzle-orm';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import type {
  ResolvedRecipient,
  StatusReportSettings,
} from '@weldsuite/app-api-client/schemas/project-reporting';
import { raidCode } from '@weldsuite/flow-domain/raid';
import { riskBand } from '@weldsuite/flow-domain/risk';
import {
  CHANGES_LISTED,
  DECISIONS_LISTED,
  ITEMS_LISTED,
  SNAPSHOT_VERSION,
  TOP_RISKS,
  addDays,
  benefitsArea,
  budgetArea,
  computedAreasOf,
  mergeAreas,
  overallColour,
  recipientTargets,
  riskArea,
  scheduleArea,
  scopeArea,
  startOfDay,
  windowDays,
  type ComputedAreas,
  type RecipientCandidate,
  type ScheduleItem,
} from '@weldsuite/flow-domain/status-report';
import { identitiesOf, memberIdentities, stakeholdersOfProject, type StakeholderRow } from './stakeholders';

const reports = schema.projectStatusReports;

export type StatusReportRow = typeof reports.$inferSelect;
export type NewStatusReportRow = typeof reports.$inferInsert;

/** The project columns a report reads. */
export interface ReportProject {
  id: string;
  name: string;
  status: string;
  projectManagerId: string | null;
  endDate: Date | null;
  budgetCurrency: string | null;
  settings: schema.ProjectSettings | null;
}

export async function loadReportProject(db: Database, projectId: string): Promise<ReportProject | null> {
  const [row] = await db
    .select({
      id: schema.projects.id,
      name: schema.projects.name,
      status: schema.projects.status,
      projectManagerId: schema.projects.projectManagerId,
      endDate: schema.projects.endDate,
      budgetCurrency: schema.projects.budgetCurrency,
      settings: schema.projects.settings,
    })
    .from(schema.projects)
    .where(and(eq(schema.projects.id, projectId), isNull(schema.projects.deletedAt)))
    .limit(1);
  return row ?? null;
}

/** The `statusReport` schedule of a project, or null while it has none. */
export function scheduleOf(project: Pick<ReportProject, 'settings'>): StatusReportSettings | null {
  const stored = project.settings?.statusReport;
  if (!stored) return null;
  return {
    cadence: stored.cadence,
    weekday: stored.weekday,
    hour: stored.hour,
    recipients: stored.recipients ?? {},
  };
}

/** The project's risk appetite: its own, or the default. */
export function riskAppetiteOf(project: Pick<ReportProject, 'settings'>): number {
  return project.settings?.riskAppetite ?? schema.DEFAULT_RISK_APPETITE;
}

/** A live report by id. */
export async function findReport(db: Database, id: string): Promise<StatusReportRow | null> {
  const [row] = await db
    .select()
    .from(reports)
    .where(and(eq(reports.id, id), isNull(reports.deletedAt)))
    .limit(1);
  return row ?? null;
}

/** For each report, the published report that supersedes it (`supersedes_id`), when there is one. */
export async function supersededByMap(db: Database, ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (ids.length === 0) return out;
  const rows = await db
    .select({ id: reports.id, supersedesId: reports.supersedesId })
    .from(reports)
    .where(and(inArray(reports.supersedesId, ids), eq(reports.status, 'published'), isNull(reports.deletedAt)))
    .orderBy(asc(reports.publishedAt), asc(reports.id));
  for (const row of rows) if (row.supersedesId) out.set(row.supersedesId, row.id);
  return out;
}

/** A period's live reports, newest first. */
export async function reportsOfPeriod(db: Database, projectId: string, period: string): Promise<StatusReportRow[]> {
  return db
    .select()
    .from(reports)
    .where(and(eq(reports.projectId, projectId), eq(reports.period, period), isNull(reports.deletedAt)))
    .orderBy(desc(reports.createdAt), desc(reports.id));
}

/** Whether any report row (soft-deleted ones too) exists for a period: the sweep never redrafts what was discarded. */
export async function periodHandled(db: Database, projectId: string, period: string): Promise<boolean> {
  const [row] = await db
    .select({ id: reports.id })
    .from(reports)
    .where(and(eq(reports.projectId, projectId), eq(reports.period, period)))
    .limit(1);
  return !!row;
}

// ── Computing a draft ───────────────────────────────────────────────────────

/** What a computation yields: the areas, the lists and the snapshot to store. */
export interface ComputedReport {
  areas: ComputedAreas;
  overall: ReturnType<typeof overallColour>;
  snapshot: schema.StatusReportSnapshot;
  done: schema.StatusReportItem[];
  next: schema.StatusReportItem[];
}

const PENDING_CHANGE_STATUSES: schema.ChangeRequestStatus[] = ['assessing', 'awaiting_approval'];

function num(value: string | null): number | null {
  return value === null ? null : Number(value);
}

function dateOf(value: string | null | undefined): Date | null {
  return value ? new Date(value) : null;
}

/** Read the project's data as of `now` and compute the five areas, the lists and the snapshot. */
export async function computeReport(
  db: Database,
  project: ReportProject,
  now: Date,
  windowDays: number,
): Promise<ComputedReport> {
  const projectId = project.id;
  const sinceDone = addDays(startOfDay(now), -windowDays);
  const untilNext = addDays(startOfDay(now), windowDays + 1);
  const riskItems = schema.projectRaidItems;

  const [
    [baseline],
    milestoneRows,
    deliverableRows,
    [finance],
    pendingChanges,
    openRiskRows,
    benefitRows,
    proposedDecisions,
    doneTasks,
    nextTasks,
  ] = await Promise.all([
    db.select().from(schema.projectBaselines).where(eq(schema.projectBaselines.projectId, projectId)).orderBy(desc(schema.projectBaselines.version)).limit(1),
    db.select().from(schema.milestones).where(and(eq(schema.milestones.projectId, projectId), isNull(schema.milestones.deletedAt))),
    db.select().from(schema.projectDeliverables).where(and(eq(schema.projectDeliverables.projectId, projectId), isNull(schema.projectDeliverables.deletedAt))),
    db.select().from(schema.projectFinanceSnapshots).where(eq(schema.projectFinanceSnapshots.projectId, projectId)).orderBy(desc(schema.projectFinanceSnapshots.week)).limit(1),
    db
      .select()
      .from(schema.projectChangeRequests)
      .where(
        and(
          eq(schema.projectChangeRequests.projectId, projectId),
          isNull(schema.projectChangeRequests.deletedAt),
          inArray(schema.projectChangeRequests.status, PENDING_CHANGE_STATUSES),
        ),
      )
      .orderBy(asc(schema.projectChangeRequests.number)),
    db
      .select()
      .from(riskItems)
      .where(and(eq(riskItems.projectId, projectId), eq(riskItems.kind, 'risk'), isNull(riskItems.deletedAt), isNull(riskItems.closedAt), isNotNull(riskItems.score))),
    db
      .select()
      .from(schema.projectBenefits)
      .where(and(eq(schema.projectBenefits.projectId, projectId), isNull(schema.projectBenefits.deletedAt), ne(schema.projectBenefits.status, 'closed')))
      .orderBy(asc(schema.projectBenefits.number)),
    db
      .select()
      .from(schema.projectDecisions)
      .where(and(eq(schema.projectDecisions.projectId, projectId), isNull(schema.projectDecisions.deletedAt), eq(schema.projectDecisions.status, 'proposed')))
      .orderBy(sql`${schema.projectDecisions.decisionDueAt} asc nulls last`, asc(schema.projectDecisions.number)),
    db
      .select({
        id: schema.tasks.id,
        number: schema.tasks.number,
        title: schema.tasks.title,
        completedDate: schema.tasks.completedDate,
        updatedAt: schema.tasks.updatedAt,
      })
      .from(schema.tasks)
      .where(
        and(
          eq(schema.tasks.projectId, projectId),
          isNull(schema.tasks.deletedAt),
          eq(schema.tasks.status, 'done'),
          or(gte(schema.tasks.completedDate, sinceDone), and(isNull(schema.tasks.completedDate), gte(schema.tasks.updatedAt, sinceDone))),
        ),
      ),
    db
      .select({ id: schema.tasks.id, number: schema.tasks.number, title: schema.tasks.title, dueDate: schema.tasks.dueDate })
      .from(schema.tasks)
      .where(
        and(
          eq(schema.tasks.projectId, projectId),
          isNull(schema.tasks.deletedAt),
          isNotNull(schema.tasks.dueDate),
          gte(schema.tasks.dueDate, startOfDay(now)),
          lte(schema.tasks.dueDate, untilNext),
          ne(schema.tasks.status, 'done'),
          ne(schema.tasks.status, 'cancelled'),
        ),
      ),
  ]);

  // Schedule: the latest baseline against the plan as it stands.
  const frozen = baseline?.snapshot ?? null;
  const items: ScheduleItem[] = [];
  const liveMilestones = new Map(milestoneRows.map((row) => [row.id, row]));
  const seenMilestones = new Set<string>();
  for (const planned of frozen?.milestones ?? []) {
    const live = liveMilestones.get(planned.id);
    if (!live) continue;
    seenMilestones.add(live.id);
    items.push({
      kind: 'milestone',
      id: live.id,
      name: live.name,
      baseline: dateOf(planned.dueDate),
      current: live.dueDate,
      done: live.completedAt !== null || live.status === 'completed',
    });
  }
  for (const live of milestoneRows) {
    if (seenMilestones.has(live.id)) continue;
    items.push({ kind: 'milestone', id: live.id, name: live.name, baseline: null, current: live.dueDate, done: live.completedAt !== null || live.status === 'completed' });
  }
  const liveDeliverables = new Map(deliverableRows.map((row) => [row.id, row]));
  const seenDeliverables = new Set<string>();
  const deliverableName = (row: { number: number; title: string }) => `D${row.number} ${row.title}`;
  for (const planned of frozen?.deliverables ?? []) {
    const live = liveDeliverables.get(planned.id);
    if (!live) continue;
    seenDeliverables.add(live.id);
    items.push({
      kind: 'deliverable',
      id: live.id,
      name: deliverableName(live),
      baseline: dateOf(planned.plannedEnd),
      current: live.plannedEnd,
      done: live.status === 'accepted',
    });
  }
  for (const live of deliverableRows) {
    if (seenDeliverables.has(live.id) || !live.plannedEnd) continue;
    items.push({ kind: 'deliverable', id: live.id, name: deliverableName(live), baseline: null, current: live.plannedEnd, done: live.status === 'accepted' });
  }
  const goLiveBaseline = dateOf(frozen?.goLive);
  if (goLiveBaseline || project.endDate) {
    items.push({ kind: 'go_live', id: null, name: 'Go-live', baseline: goLiveBaseline, current: project.endDate, done: false });
  }
  const schedule = scheduleArea(baseline ? baseline.version : null, items, now);

  // Budget: the latest weekly finance snapshot.
  const budget = budgetArea(
    finance
      ? {
          week: finance.week,
          budget: finance.budget,
          plannedValue: finance.plannedValue,
          earnedValue: finance.earnedValue,
          actualCost: finance.actualCost,
          forecast: finance.forecast,
        }
      : null,
    project.budgetCurrency,
  );

  // Scope: change requests waiting for an answer.
  const scope = scopeArea(pendingChanges.length);

  // Risk: the highest open score against the appetite.
  const appetite = riskAppetiteOf(project);
  const openRisks = openRiskRows
    .map((row) => ({ row, score: row.score ?? 0 }))
    .sort((a, b) => b.score - a.score || a.row.number - b.row.number);
  const risk = riskArea(
    openRisks.map(({ row, score }) => ({ id: row.id, code: raidCode('risk', row.number), title: row.title, score })),
    appetite,
  );

  // Benefits: the latest measurement of each open benefit.
  const benefitIds = benefitRows.map((row) => row.id);
  const measurementRows = benefitIds.length
    ? await db
        .select({ benefitId: schema.projectBenefitMeasurements.benefitId, value: schema.projectBenefitMeasurements.value })
        .from(schema.projectBenefitMeasurements)
        .where(inArray(schema.projectBenefitMeasurements.benefitId, benefitIds))
        .orderBy(desc(schema.projectBenefitMeasurements.period))
    : [];
  const latest = new Map<string, string>();
  for (const row of measurementRows) if (!latest.has(row.benefitId)) latest.set(row.benefitId, row.value);
  const benefits = benefitsArea(
    benefitRows.map((row) => ({
      code: `B-${row.number}`,
      status: row.status,
      baseline: num(row.baselineValue),
      target: num(row.targetValue),
      latest: num(latest.get(row.id) ?? null),
      createdAt: row.createdAt,
      realiseBy: row.realiseBy,
    })),
    now,
  );

  const areas: ComputedAreas = { schedule: schedule.area, budget: budget.area, scope, risk, benefits };
  const overall = overallColour(Object.values(areas));

  // The lists: top risks with the score they had at the assessment before.
  const topRows = openRisks.slice(0, TOP_RISKS).map(({ row }) => row);
  const previous = new Map<string, number>();
  if (topRows.length) {
    const assessmentRows = await db
      .select({ itemId: schema.projectRaidAssessments.itemId, probability: schema.projectRaidAssessments.probability, impact: schema.projectRaidAssessments.impact })
      .from(schema.projectRaidAssessments)
      .where(inArray(schema.projectRaidAssessments.itemId, topRows.map((row) => row.id)))
      .orderBy(desc(schema.projectRaidAssessments.assessedAt), desc(schema.projectRaidAssessments.id));
    const seen = new Map<string, number>();
    for (const row of assessmentRows) {
      const count = (seen.get(row.itemId) ?? 0) + 1;
      seen.set(row.itemId, count);
      if (count === 2) previous.set(row.itemId, row.probability * row.impact);
    }
  }
  const topRisks = topRows.map((row) => ({
    id: row.id,
    code: raidCode('risk', row.number),
    title: row.title,
    score: row.score ?? 0,
    band: riskBand(row.score ?? 1),
    ownerId: row.ownerId ?? null,
    previousScore: previous.get(row.id) ?? null,
  }));
  const decisions = proposedDecisions.slice(0, DECISIONS_LISTED).map((row) => ({
    id: row.id,
    code: `DEC-${row.number}`,
    title: row.title,
    deciderId: row.deciderId ?? null,
    dueAt: row.decisionDueAt ? row.decisionDueAt.toISOString() : null,
  }));
  const changes = pendingChanges.slice(0, CHANGES_LISTED).map((row) => ({
    id: row.id,
    code: `CR-${row.number}`,
    title: row.title,
    status: row.status,
    costDelta: row.costDelta ?? null,
    scheduleDeltaDays: row.scheduleDeltaDays ?? null,
  }));

  // Done: tasks completed and deliverables accepted in the window, newest first.
  const done: schema.StatusReportItem[] = [
    ...doneTasks.map((row) => ({
      taskId: row.id,
      text: row.title,
      code: row.number !== null ? `TASK-${row.number}` : 'TASK',
      date: (row.completedDate ?? row.updatedAt).toISOString(),
    })),
    ...deliverableRows
      .filter((row) => row.status === 'accepted' && row.acceptedAt && row.acceptedAt >= sinceDone)
      .map((row) => ({ taskId: null, text: row.title, code: `D${row.number}`, date: (row.acceptedAt as Date).toISOString() })),
  ]
    .sort((a, b) => (b.date ?? '').localeCompare(a.date ?? '') || (a.code ?? '').localeCompare(b.code ?? ''))
    .slice(0, ITEMS_LISTED);

  // Next: tasks due and decisions due in the coming window, soonest first.
  const next: schema.StatusReportItem[] = [
    ...nextTasks.map((row) => ({
      taskId: row.id,
      text: row.title,
      code: row.number !== null ? `TASK-${row.number}` : 'TASK',
      date: (row.dueDate as Date).toISOString(),
    })),
    ...proposedDecisions
      .filter((row) => row.decisionDueAt && row.decisionDueAt >= startOfDay(now) && row.decisionDueAt <= untilNext)
      .map((row) => ({ taskId: null, text: row.title, code: `DEC-${row.number}`, date: (row.decisionDueAt as Date).toISOString() })),
  ]
    .sort((a, b) => (a.date ?? '').localeCompare(b.date ?? '') || (a.code ?? '').localeCompare(b.code ?? ''))
    .slice(0, ITEMS_LISTED);

  const snapshot: schema.StatusReportSnapshot = {
    version: SNAPSHOT_VERSION,
    asOf: now.toISOString(),
    baselineVersion: baseline ? baseline.version : null,
    currency: project.budgetCurrency ?? null,
    computed: { overall, areas: computedAreasOf(areas) },
    figures: {
      budget: budget.figures,
      pendingChanges: pendingChanges.length,
      riskAppetite: appetite,
      openRisks: openRisks.length,
      highestRiskScore: openRisks[0]?.score ?? null,
    },
    topRisks,
    decisions,
    changes,
    milestones: schedule.rows,
  };
  return { areas, overall, snapshot, done, next };
}

/**
 * Draft a report for a period: compute it from the project's data as of `now`
 * and insert it. `supersedes` is the published report of the same period it
 * corrects; its sharing with clients carries over. Used by `POST /` and by the
 * `status_report_due` sweep (createdBy `system`).
 */
export async function insertDraft(
  db: Database,
  project: ReportProject,
  input: { period: string; now: Date; createdBy: string; supersedes: StatusReportRow | null },
): Promise<StatusReportRow | null> {
  const schedule = scheduleOf(project);
  const computed = await computeReport(db, project, input.now, windowDays(input.period, schedule?.cadence ?? null));
  const id = generateId('rpt');
  await db.insert(reports).values({
    id,
    projectId: project.id,
    period: input.period,
    status: 'draft',
    overall: computed.overall,
    areas: mergeAreas(null, computed.areas),
    summary: null,
    done: computed.done,
    next: computed.next,
    snapshot: computed.snapshot,
    clientVisible: input.supersedes?.clientVisible ?? false,
    supersedesId: input.supersedes?.id ?? null,
    recipients: schedule?.recipients.stakeholderIds ? { stakeholderIds: [...schedule.recipients.stakeholderIds] } : null,
    createdBy: input.createdBy,
    createdAt: input.now,
    updatedAt: input.now,
  });
  return findReport(db, id);
}

// ── Recipients ──────────────────────────────────────────────────────────────

/** The register as candidates, and the sponsor (the project's sponsor, else its manager) as one of their own. */
export async function recipientCandidates(
  db: Database,
  project: ReportProject,
): Promise<{ register: RecipientCandidate[]; sponsor: RecipientCandidate | null; rows: StakeholderRow[] }> {
  const rows = await stakeholdersOfProject(db, project.id);
  const identities = await identitiesOf(db, rows);
  const register: RecipientCandidate[] = rows.map((row) => {
    const identity = identities.get(row.id);
    return {
      stakeholderId: row.id,
      userId: row.memberId ?? null,
      name: identity?.name ?? null,
      email: identity?.email ?? null,
      kind: row.memberId ? 'member' : 'contact',
      portalAccess: row.portalAccess,
    };
  });
  const sponsorId = project.settings?.sponsorId ?? project.projectManagerId;
  let sponsor: RecipientCandidate | null = null;
  if (sponsorId) {
    const found = (await memberIdentities(db, [sponsorId])).get(sponsorId);
    const onRegister = register.find((candidate) => candidate.userId === sponsorId);
    sponsor = {
      stakeholderId: onRegister?.stakeholderId ?? null,
      userId: sponsorId,
      name: found?.name ?? null,
      email: found?.email ?? null,
      kind: 'member',
      portalAccess: false,
    };
  }
  return { register, sponsor, rows };
}

/** Who a report goes to now: its own list, or the schedule's. */
export async function targetsOf(db: Database, project: ReportProject, stored: StatusReportRow['recipients']): Promise<RecipientCandidate[]> {
  const { register, sponsor } = await recipientCandidates(db, project);
  return recipientTargets(stored, scheduleOf(project), register, sponsor);
}

export function presentTarget(target: RecipientCandidate): ResolvedRecipient {
  return { stakeholderId: target.stakeholderId, userId: target.userId, name: target.name, email: target.email, kind: target.kind };
}
