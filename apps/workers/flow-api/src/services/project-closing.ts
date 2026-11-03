/**
 * Closing a project, the database side (design: weldflow-delivery-and-portfolio.md,
 * "Close a project"; slice F): the close checklist computed from the project's
 * tables, the sign-off subject registered with the approvals core, and the
 * events of a closed project.
 *
 * The rules (what counts as done, final finance, sign-off state) are in
 * `@weldsuite/flow-domain/project-closing`.
 */

import type { Context } from 'hono';
import { and, asc, desc, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { publishEntityEvent } from '@weldsuite/entity-events';
import type { CloseChecklist, CloseBenefit, CloseRaidItem } from '@weldsuite/app-api-client/schemas/project-closing';
import { getApprovalSubjectHandler, listSubjectApprovals, registerApprovalSubject, type ApprovalRow } from '@weldsuite/flow-domain/approvals';
import { raidCode } from '@weldsuite/flow-domain/raid';
import {
  canRequestClose,
  closeChecks,
  closeFinance,
  closeProgress,
  signOffState,
  type CloseCounts,
} from '@weldsuite/flow-domain/project-closing';
import type { Env, Variables } from '../types';
import { projectAnalyticsPayload } from '../lib/weldflow-analytics-payload';

const projects = schema.projects;

export type ProjectRow = typeof projects.$inferSelect;

/** A live project by id. */
export async function findLiveProject(db: Database, id: string): Promise<ProjectRow | null> {
  const [row] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, id), isNull(projects.deletedAt)))
    .limit(1);
  return row ?? null;
}

// ── Sign-off: the approvals subject ─────────────────────────────────────────

/**
 * The sponsor's approval closes the project. Runs once the approvals settle
 * the subject, and again if the resolution is re-evaluated, so it only moves a
 * project that is not closed yet. The `project.closed` entity event is the
 * route's to publish (`publishProjectClosed`): a handler has no request.
 */
export async function closeProject(db: Database, projectId: string, now: Date): Promise<boolean> {
  const closed = await db
    .update(projects)
    .set({
      status: 'Closed',
      actualEndDate: sql`coalesce(${projects.actualEndDate}, ${now.toISOString()}::timestamp)`,
      updatedAt: now,
    })
    .where(and(eq(projects.id, projectId), isNull(projects.deletedAt), ne(projects.status, 'Closed')))
    .returning({ id: projects.id });
  return closed.length > 0;
}

// Registered when this file is first imported (the close router imports it), so
// every flow-api isolate answers a sign-off the same way.
if (!getApprovalSubjectHandler('project_close')) {
  registerApprovalSubject('project_close', {
    onResolved: async (db, projectId, outcome, context) => {
      if (outcome === 'approved') await closeProject(db, projectId, context.now);
    },
  });
}

type EventContext = Context<{ Bindings: Env; Variables: Variables }>;

/**
 * Publish `project.closed` for a project the sign-off just closed. The route
 * that answers a `project_close` approval (`POST /api/approvals/:id/decide`)
 * calls this when the answer resolved the subject as approved: the handler
 * above changes the row, only a request can publish the event.
 */
export async function publishProjectClosed(c: EventContext, projectId: string): Promise<void> {
  const row = await findLiveProject(c.get('tenantDb'), projectId);
  if (!row) return;
  publishEntityEvent({
    c,
    entityType: 'project',
    entityId: row.id,
    action: 'closed',
    data: projectAnalyticsPayload(row as unknown as Record<string, unknown>),
  });
}

/** The payload of a `flow_approval` event. */
export function approvalEventData(row: ApprovalRow) {
  return {
    id: row.id,
    projectId: row.projectId,
    subjectType: row.subjectType,
    subjectId: row.subjectId,
    approverKind: row.approverKind,
    approverId: row.approverId,
    step: row.step,
    ruleCode: row.rule.code,
    decision: row.decision,
    dueAt: row.dueAt ? row.dueAt.toISOString() : null,
  };
}

// ── The checklist ───────────────────────────────────────────────────────────

const RAID_KIND_ORDER = ['risk', 'assumption', 'issue', 'dependency'];

/** `count(*)` as a number. */
const count = () => sql<number>`count(*)`.mapWith(Number);

/**
 * The close checklist of a project, computed from its tables: deliverables
 * accepted, change requests decided, open register items handed over,
 * benefits with an owner and a final measurement, time entries locked,
 * lessons published and the state of the sign-off.
 */
export async function loadChecklist(db: Database, project: ProjectRow, options: { amountsVisible: boolean }): Promise<CloseChecklist> {
  const projectId = project.id;
  const handovers = project.settings?.closing?.handovers ?? {};

  const [deliverables, changeRows, raidRows, benefitRows, timeRows, lessonRows, approvals, baselineRows, snapshotRows] = await Promise.all([
    db
      .select({
        id: schema.projectDeliverables.id,
        number: schema.projectDeliverables.number,
        title: schema.projectDeliverables.title,
        status: schema.projectDeliverables.status,
        acceptedAt: schema.projectDeliverables.acceptedAt,
      })
      .from(schema.projectDeliverables)
      .where(and(eq(schema.projectDeliverables.projectId, projectId), isNull(schema.projectDeliverables.deletedAt)))
      .orderBy(asc(schema.projectDeliverables.position), asc(schema.projectDeliverables.number)),
    db
      .select({
        total: count(),
        open: sql<number>`count(*) filter (where ${schema.projectChangeRequests.status} in ('draft', 'assessing', 'awaiting_approval'))`.mapWith(Number),
      })
      .from(schema.projectChangeRequests)
      .where(and(eq(schema.projectChangeRequests.projectId, projectId), isNull(schema.projectChangeRequests.deletedAt))),
    db
      .select({
        id: schema.projectRaidItems.id,
        kind: schema.projectRaidItems.kind,
        number: schema.projectRaidItems.number,
        title: schema.projectRaidItems.title,
        status: schema.projectRaidItems.status,
        ownerId: schema.projectRaidItems.ownerId,
      })
      .from(schema.projectRaidItems)
      .where(
        and(
          eq(schema.projectRaidItems.projectId, projectId),
          isNull(schema.projectRaidItems.deletedAt),
          isNull(schema.projectRaidItems.closedAt),
        ),
      ),
    db
      .select()
      .from(schema.projectBenefits)
      .where(
        and(
          eq(schema.projectBenefits.projectId, projectId),
          isNull(schema.projectBenefits.deletedAt),
          ne(schema.projectBenefits.status, 'closed'),
        ),
      )
      .orderBy(asc(schema.projectBenefits.number)),
    db
      .select({
        total: count(),
        open: sql<number>`count(*) filter (where ${schema.timeEntries.status} not in ('approved', 'billed'))`.mapWith(Number),
        approved: sql<number>`count(*) filter (where ${schema.timeEntries.status} = 'approved')`.mapWith(Number),
        billed: sql<number>`count(*) filter (where ${schema.timeEntries.status} = 'billed')`.mapWith(Number),
        cost: sql<string>`coalesce(sum(${schema.timeEntries.cost}) filter (where ${schema.timeEntries.status} in ('approved', 'billed')), 0)::text`,
      })
      .from(schema.timeEntries)
      .where(and(eq(schema.timeEntries.projectId, projectId), isNull(schema.timeEntries.deletedAt))),
    db
      .select({
        total: count(),
        published: sql<number>`count(*) filter (where ${schema.projectLessons.knowPageId} is not null)`.mapWith(Number),
      })
      .from(schema.projectLessons)
      .where(and(eq(schema.projectLessons.projectId, projectId), isNull(schema.projectLessons.deletedAt))),
    listSubjectApprovals(db, 'project_close', projectId),
    db
      .select()
      .from(schema.projectBaselines)
      .where(eq(schema.projectBaselines.projectId, projectId))
      .orderBy(desc(schema.projectBaselines.version))
      .limit(1),
    db
      .select()
      .from(schema.projectFinanceSnapshots)
      .where(eq(schema.projectFinanceSnapshots.projectId, projectId))
      .orderBy(desc(schema.projectFinanceSnapshots.week))
      .limit(1),
  ]);

  // The latest measurement of each benefit.
  const benefitIds = benefitRows.map((row) => row.id);
  const measurements =
    benefitIds.length === 0
      ? []
      : await db
          .select()
          .from(schema.projectBenefitMeasurements)
          .where(inArray(schema.projectBenefitMeasurements.benefitId, benefitIds))
          .orderBy(desc(schema.projectBenefitMeasurements.period), desc(schema.projectBenefitMeasurements.id));
  const latestByBenefit = new Map<string, (typeof measurements)[number]>();
  for (const row of measurements) if (!latestByBenefit.has(row.benefitId)) latestByBenefit.set(row.benefitId, row);

  const benefits: CloseBenefit[] = benefitRows.map((row) => {
    const latest = latestByBenefit.get(row.id);
    return {
      id: row.id,
      code: `B-${row.number}`,
      title: row.title,
      status: row.status,
      ownerId: row.ownerId,
      unit: row.unit,
      baselineValue: row.baselineValue,
      targetValue: row.targetValue,
      realiseBy: row.realiseBy ? row.realiseBy.toISOString() : null,
      latest: latest ? { period: latest.period, value: latest.value, measuredAt: latest.measuredAt.toISOString() } : null,
    };
  });

  const raidItems: CloseRaidItem[] = [...raidRows]
    .sort((a, b) => RAID_KIND_ORDER.indexOf(a.kind) - RAID_KIND_ORDER.indexOf(b.kind) || a.number - b.number)
    .map((row) => ({
      id: row.id,
      kind: row.kind,
      code: raidCode(row.kind, row.number),
      title: row.title,
      status: row.status,
      ownerId: row.ownerId,
      handedOver: handovers[row.id] !== undefined,
    }));

  const change = changeRows[0] ?? { total: 0, open: 0 };
  const time = timeRows[0] ?? { total: 0, open: 0, approved: 0, billed: 0, cost: '0' };
  const lessons = lessonRows[0] ?? { total: 0, published: 0 };
  const signOff = signOffState(approvals.map((row) => row.decision));
  const closed = project.status === 'Closed';

  const counts: CloseCounts = {
    closed,
    deliverables: { total: deliverables.length, accepted: deliverables.filter((row) => row.status === 'accepted').length },
    changes: { total: change.total, open: change.open },
    raid: { open: raidItems.length, handedOver: raidItems.filter((row) => row.handedOver).length },
    benefits: {
      total: benefits.length,
      ready: benefits.filter((row) => row.ownerId !== null && row.latest !== null).length,
    },
    time: { total: time.total, open: time.open },
    lessons,
    signOff,
  };
  const checks = closeChecks(counts);

  const baseline = baselineRows[0] ?? null;
  const snapshot = snapshotRows[0] ?? null;
  const latestApproval = [...approvals].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : -1))[0] ?? null;

  return {
    projectId,
    projectName: project.name,
    status: project.status,
    closed,
    closedAt: closed && project.actualEndDate ? project.actualEndDate.toISOString() : null,
    checks,
    progress: closeProgress(checks),
    canRequest: canRequestClose(checks, closed, signOff),
    deliverables: deliverables.map((row) => ({
      id: row.id,
      code: `D${row.number}`,
      title: row.title,
      status: row.status,
      acceptedAt: row.acceptedAt ? row.acceptedAt.toISOString() : null,
    })),
    raidItems,
    benefits,
    time: { total: time.total, approved: time.approved, billed: time.billed, open: time.open },
    finance: closeFinance({
      currency: project.budgetCurrency,
      amountsVisible: options.amountsVisible,
      budget: baseline?.snapshot.budgetedAmount ?? project.budgetedAmount,
      timeCost: time.cost,
      snapshot: snapshot
        ? {
            week: snapshot.week,
            actualCost: snapshot.actualCost,
            committed: snapshot.committed,
            forecast: snapshot.forecast,
          }
        : null,
      baseline: baseline ? { version: baseline.version, goLive: baseline.snapshot.goLive ? new Date(baseline.snapshot.goLive) : null } : null,
    }),
    lessons,
    signOff: {
      state: signOff,
      sponsorId: project.settings?.sponsorId || project.projectManagerId || null,
      approval: latestApproval
        ? {
            id: latestApproval.id,
            approverId: latestApproval.approverId,
            decision: latestApproval.decision,
            note: latestApproval.note,
            decidedAt: latestApproval.decidedAt ? latestApproval.decidedAt.toISOString() : null,
            decidedBy: latestApproval.decidedBy,
            delegatedFrom: latestApproval.delegatedFrom,
            requestedAt: latestApproval.createdAt.toISOString(),
          }
        : null,
    },
  };
}
