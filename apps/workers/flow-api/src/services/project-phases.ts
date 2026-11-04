/**
 * Phases and stage gates: queries, the gate check's facts and the approval
 * handler of the `gate` subject (design: weldflow-delivery-and-portfolio.md,
 * "Pass a stage gate"; ADR FLOW-017).
 *
 * The rules (criteria catalogue, the check, the phase lifecycle) are in
 * `@weldsuite/flow-domain/gates`; this file is the database side. The `gate`
 * subject is registered here, so every flow-api isolate that mounts the router
 * can settle a gate when the last approval comes in (`/api/approvals/:id/decide`
 * calls `decideApproval`, which runs `resolveGate`).
 *
 * `resolveGate` only does the database work. The entity events of a settled
 * gate need the request context, so the route that called `decideApproval`
 * publishes them with `publishGateResolution` once the answer is stored.
 */

import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { atomically } from '@weldsuite/worker-kit/atomically';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import type { ProjectPhase } from '@weldsuite/db/schema/project-delivery';
import type { GateApproval, PhaseGate, PhaseSummary } from '@weldsuite/app-api-client/schemas/project-schedule';
import {
  listSubjectApprovals,
  registerApprovalSubject,
  sponsorOf,
  type ApprovalOutcome,
  type ApprovalRow,
} from '@weldsuite/flow-domain/approvals';
import {
  EMPTY_GATE_FACTS,
  SPEND_TIME_ENTRY_STATUSES,
  checkGate,
  gateApproverIds,
  gateFactsNeeded,
  gateRequestBlock,
  gateResultOf,
  nextUpcomingPhase,
  phaseEventData,
  presentPhase,
  type GateCheck,
  type GateCriterion,
  type GateFacts,
  type GateWaiver,
} from '@weldsuite/flow-domain/gates';
import type { Context } from 'hono';
import type { Variables, Env } from '../types';
import { findLiveProject, type ProjectRow } from './project-schedule';

const phases = schema.projectPhases;

export type PhaseRow = ProjectPhase;

// ── Reading ─────────────────────────────────────────────────────────────────

export async function findPhase(db: Database, id: string): Promise<PhaseRow | null> {
  const [row] = await db
    .select()
    .from(phases)
    .where(and(eq(phases.id, id), isNull(phases.deletedAt)))
    .limit(1);
  return row ?? null;
}

/** A project's live phases in lifecycle order. */
export async function listPhases(db: Database, projectId: string): Promise<PhaseRow[]> {
  return db
    .select()
    .from(phases)
    .where(and(eq(phases.projectId, projectId), isNull(phases.deletedAt)))
    .orderBy(asc(phases.position), asc(phases.id));
}

/** A decimal string with two decimals, as the money columns hold it. */
function twoDecimals(value: string | number | null | undefined): string {
  const parsed = Number(value ?? 0);
  return (Number.isFinite(parsed) ? parsed : 0).toFixed(2);
}

/** Read only what the criteria need of the project's data. */
export async function loadGateFacts(db: Database, projectId: string, criteria: readonly GateCriterion[]): Promise<GateFacts> {
  const needed = gateFactsNeeded(criteria);
  const facts: GateFacts = { ...EMPTY_GATE_FACTS, deliverables: [], risks: [], decisions: [], changeRequests: [], spend: null };

  if (needed.deliverableIds.length > 0) {
    const deliverables = await db
      .select({
        id: schema.projectDeliverables.id,
        number: schema.projectDeliverables.number,
        title: schema.projectDeliverables.title,
        status: schema.projectDeliverables.status,
      })
      .from(schema.projectDeliverables)
      .where(
        and(
          eq(schema.projectDeliverables.projectId, projectId),
          inArray(schema.projectDeliverables.id, needed.deliverableIds),
          isNull(schema.projectDeliverables.deletedAt),
        ),
      );
    const counts = await db
      .select({
        deliverableId: schema.tasks.deliverableId,
        total: sql<number>`count(*)`.mapWith(Number),
        done: sql<number>`count(*) filter (where ${schema.tasks.status} = 'done')`.mapWith(Number),
      })
      .from(schema.tasks)
      .where(
        and(
          eq(schema.tasks.projectId, projectId),
          inArray(schema.tasks.deliverableId, needed.deliverableIds),
          isNull(schema.tasks.deletedAt),
          sql`${schema.tasks.status} <> 'cancelled'`,
        ),
      )
      .groupBy(schema.tasks.deliverableId);
    const byDeliverable = new Map(counts.map((row) => [row.deliverableId, row]));
    facts.deliverables = deliverables.map((row) => ({
      ...row,
      tasksDone: byDeliverable.get(row.id)?.done ?? 0,
      tasksTotal: byDeliverable.get(row.id)?.total ?? 0,
    }));
  }

  if (needed.risks) {
    facts.risks = await db
      .select({
        id: schema.projectRaidItems.id,
        number: schema.projectRaidItems.number,
        title: schema.projectRaidItems.title,
        score: sql<number>`${schema.projectRaidItems.score}`.mapWith(Number),
      })
      .from(schema.projectRaidItems)
      .where(
        and(
          eq(schema.projectRaidItems.projectId, projectId),
          eq(schema.projectRaidItems.kind, 'risk'),
          isNull(schema.projectRaidItems.closedAt),
          isNull(schema.projectRaidItems.deletedAt),
          sql`${schema.projectRaidItems.score} is not null`,
        ),
      );
  }

  if (needed.decisionIds.length > 0) {
    const decisions = await db
      .select({
        id: schema.projectDecisions.id,
        number: schema.projectDecisions.number,
        title: schema.projectDecisions.title,
        status: schema.projectDecisions.status,
        decisionDueAt: schema.projectDecisions.decisionDueAt,
      })
      .from(schema.projectDecisions)
      .where(
        and(
          eq(schema.projectDecisions.projectId, projectId),
          inArray(schema.projectDecisions.id, needed.decisionIds),
          isNull(schema.projectDecisions.deletedAt),
        ),
      );
    facts.decisions = decisions.map((row) => ({ ...row, decisionDueAt: row.decisionDueAt ? row.decisionDueAt.toISOString() : null }));
  }

  if (needed.changeRequests) {
    facts.changeRequests = await db
      .select({
        id: schema.projectChangeRequests.id,
        number: schema.projectChangeRequests.number,
        title: schema.projectChangeRequests.title,
      })
      .from(schema.projectChangeRequests)
      .where(
        and(
          eq(schema.projectChangeRequests.projectId, projectId),
          eq(schema.projectChangeRequests.status, 'awaiting_approval'),
          isNull(schema.projectChangeRequests.deletedAt),
        ),
      )
      .orderBy(asc(schema.projectChangeRequests.number));
  }

  if (needed.spend) {
    const [[spent], [baseline], [project]] = await Promise.all([
      db
        .select({ total: sql<string>`coalesce(sum(${schema.timeEntries.cost}), 0)` })
        .from(schema.timeEntries)
        .where(
          and(
            eq(schema.timeEntries.projectId, projectId),
            isNull(schema.timeEntries.deletedAt),
            inArray(schema.timeEntries.status, [...SPEND_TIME_ENTRY_STATUSES]),
          ),
        ),
      db
        .select({ version: schema.projectBaselines.version, snapshot: schema.projectBaselines.snapshot })
        .from(schema.projectBaselines)
        .where(eq(schema.projectBaselines.projectId, projectId))
        .orderBy(sql`${schema.projectBaselines.version} desc`)
        .limit(1),
      db.select({ currency: schema.projects.budgetCurrency }).from(schema.projects).where(eq(schema.projects.id, projectId)).limit(1),
    ]);
    const budget = baseline?.snapshot?.budgetedAmount ?? null;
    facts.spend = {
      spent: twoDecimals(spent?.total ?? 0),
      budget: budget === null ? null : twoDecimals(budget),
      currency: baseline?.snapshot?.budgetCurrency ?? project?.currency ?? null,
      baselineVersion: baseline?.version ?? null,
    };
  }
  return facts;
}

/** The waivers recorded on a phase. */
export function waiversOf(phase: Pick<PhaseRow, 'gateResult'>): GateWaiver[] {
  return (phase.gateResult?.waived ?? []).map((w) => ({ index: w.index, note: w.note, by: w.by, at: w.at }));
}

/** The phase's gate evaluated now. */
export async function checkPhase(db: Database, phase: PhaseRow): Promise<GateCheck> {
  const criteria = phase.gateCriteria as GateCriterion[];
  const facts = await loadGateFacts(db, phase.projectId, criteria);
  return checkGate(criteria, facts, waiversOf(phase));
}

// ── Presenting ──────────────────────────────────────────────────────────────

export function presentGateApproval(row: ApprovalRow): GateApproval {
  return {
    id: row.id,
    approverId: row.approverId,
    roleLabel: row.roleLabel,
    step: row.step,
    decision: row.decision,
    note: row.note,
    decidedAt: row.decidedAt ? row.decidedAt.toISOString() : null,
  };
}

/** A phase with its gate number and the approvals asked for its gate. */
export async function presentPhaseSummary(db: Database, row: PhaseRow, gateNumber: number): Promise<PhaseSummary> {
  const approvals = await listSubjectApprovals(db, 'gate', row.id);
  return {
    ...presentPhase(row),
    gateNumber,
    criteriaCount: row.gateCriteria.length,
    approvals: approvals.map(presentGateApproval),
  };
}

/** The gate number (1-based) of a phase among its project's live phases. */
export async function gateNumberOf(db: Database, row: PhaseRow): Promise<number> {
  const all = await listPhases(db, row.projectId);
  return Math.max(1, all.findIndex((phase) => phase.id === row.id) + 1);
}

/** Who would be asked to approve a project's gates, in the order they are asked. */
export function gateApprovers(project: Pick<ProjectRow, 'settings' | 'projectManagerId'>): string[] {
  return gateApproverIds(sponsorOf(project.settings, project.projectManagerId), project.settings?.changeControl?.boardMemberIds);
}

/** One phase with its gate evaluated now. */
export async function presentPhaseGate(db: Database, row: PhaseRow, project: ProjectRow): Promise<PhaseGate> {
  const [summary, check] = await Promise.all([presentPhaseSummary(db, row, await gateNumberOf(db, row)), checkPhase(db, row)]);
  const approverIds = gateApprovers(project);
  return {
    ...summary,
    check,
    approverIds,
    requestBlockedReason: gateRequestBlock(row, check, approverIds.length > 0),
  };
}

// ── Passing a gate ──────────────────────────────────────────────────────────

/** `settings.currentPhaseId` merged in, the other settings keys untouched. */
export function currentPhaseSetting(phaseId: string | null) {
  return sql`coalesce(${schema.projects.settings}, '{}'::jsonb) || jsonb_build_object('currentPhaseId', ${phaseId}::text)`;
}

/**
 * The approvals of a gate settled it. Approved: the phase is `passed`, the next
 * one `active`, `settings.currentPhaseId` follows, and the gate's result is
 * stored as it stood. Rejected: the phase stays active and its gate can be
 * requested again. Idempotent: the approvals core runs it again if it failed
 * halfway.
 */
export async function resolveGate(db: Database, phaseId: string, outcome: Exclude<ApprovalOutcome, 'pending'>, now: Date = new Date()): Promise<void> {
  const phase = await findPhase(db, phaseId);
  if (!phase) return;

  if (outcome === 'rejected') {
    if (phase.status !== 'active' || phase.gateRequestedAt === null) return;
    await db.update(phases).set({ gateRequestedAt: null, updatedAt: now }).where(eq(phases.id, phaseId));
    return;
  }

  if (phase.status === 'passed') return;
  const all = await listPhases(db, phase.projectId);
  const next = nextUpcomingPhase(all, phaseId);
  const criteria = phase.gateCriteria as GateCriterion[];
  const waivers = waiversOf(phase);
  const check = checkGate(criteria, await loadGateFacts(db, phase.projectId, criteria), waivers);
  await atomically(db, (handle) => [
    handle
      .update(phases)
      .set({
        status: 'passed',
        passedAt: now,
        gateResult: gateResultOf(check, criteria, waivers, now.toISOString()),
        updatedAt: now,
      })
      .where(eq(phases.id, phaseId)),
    ...(next ? [handle.update(phases).set({ status: 'active', updatedAt: now }).where(eq(phases.id, next))] : []),
    handle
      .update(schema.projects)
      .set({ settings: currentPhaseSetting(next), updatedAt: now })
      .where(eq(schema.projects.id, phase.projectId)),
  ]);
}

registerApprovalSubject('gate', {
  onResolved: (db, subjectId, outcome, context) => resolveGate(db, subjectId, outcome, context.now),
});

type AppContext = Context<{ Bindings: Env; Variables: Variables }>;

/**
 * The entity events of a settled gate: `project_phase.passed` and the update of
 * the phase that became active, or `project_phase.rejected` with the reason.
 * Called by the route that stored the last answer (`outcome` is what
 * `decideApproval` returned for the subject), once `resolveGate` has run.
 */
export async function publishGateResolution(
  c: AppContext,
  db: Database,
  phaseId: string,
  outcome: Exclude<ApprovalOutcome, 'pending'>,
): Promise<void> {
  const phase = await findPhase(db, phaseId);
  if (!phase) return;
  if (outcome === 'approved') {
    if (phase.status !== 'passed') return;
    const all = await listPhases(db, phase.projectId);
    const active = all.find((row) => row.status === 'active') ?? null;
    publishEntityEvent({
      c,
      entityType: 'project_phase',
      entityId: phase.id,
      action: 'passed',
      data: phaseEventData(phase, { passedAt: phase.passedAt ? phase.passedAt.toISOString() : null, nextPhaseId: active?.id ?? null }),
    });
    if (active) {
      publishEntityEvent({ c, entityType: 'project_phase', entityId: active.id, action: 'updated', data: phaseEventData(active) });
    }
    return;
  }
  const rows = await listSubjectApprovals(db, 'gate', phaseId);
  const rejected = rows.find((row) => row.decision === 'rejected');
  publishEntityEvent({
    c,
    entityType: 'project_phase',
    entityId: phase.id,
    action: 'rejected',
    data: phaseEventData(phase, { rejectedBy: rejected?.approverId ?? null, note: rejected?.note ?? null }),
  });
}

export { findLiveProject };
