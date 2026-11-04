/**
 * /api/project-phases: phases and stage gates (design:
 * weldflow-delivery-and-portfolio.md, "Pass a stage gate"; ADR FLOW-017).
 *
 *   GET    /?projectId=             the lifecycle: phases in order, with their gate approvals
 *   POST   /                        add a phase (criteria from the catalogue, or manual)
 *   POST   /reorder                 {projectId, ids}: the new order of every live phase
 *   GET    /:id                     one phase
 *   PATCH  /:id                     rename, re-date, replace the criteria
 *   DELETE /:id                     remove a phase that has not passed
 *   GET    /:id/check               the gate evaluated now, with a link to the data behind each criterion
 *   PATCH  /:id/criteria/:index     tick or untick a manual criterion (project manager)
 *   POST   /:id/waive               {criterionIndex, note}: waive an open criterion (sponsor)
 *   POST   /:id/request-approval    ask the sponsor and one change board member to pass the gate
 *
 * Permissions: projects:read | projects:create | projects:update |
 * projects:delete, plus the project membership boundary (FLOW-001): reads need
 * a member, changing the lifecycle a project manager (`canManageProject`), and
 * waiving a criterion is the sponsor's alone. The checks run in a fixed order
 * so every backend answers alike: permission, then the object (404), then
 * project access (403), then the body (400), then the business rules.
 *
 * Approving the gate is done in `/api/approvals/:id/decide`: the `gate` subject
 * handler (services/project-phases.ts) passes the phase, makes the next one
 * active and moves `settings.currentPhaseId`.
 */

import { Hono } from 'hono';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { atomically } from '@weldsuite/worker-kit/atomically';
import { error, noContent, success } from '@weldsuite/worker-kit/response';
import { generateId } from '@weldsuite/worker-kit/id';
import { schema } from '@weldsuite/worker-kit/db';
import {
  createPhaseSchema,
  listPhasesQuerySchema,
  reorderPhasesSchema,
  tickCriterionSchema,
  updatePhaseSchema,
  waiveCriterionSchema,
  type PhaseGateRequestResult,
  type PhaseList,
} from '@weldsuite/app-api-client/schemas/project-schedule';
import {
  cancelPendingApprovals,
  requestApprovals,
  sponsorOf,
} from '@weldsuite/flow-domain/approvals';
import {
  GATE_MESSAGES,
  GATE_REQUEST_BLOCK_MESSAGES,
  checkGate,
  criteriaError,
  gateFactsNeeded,
  gateRequestBlock,
  gateResultOf,
  isManualCriterion,
  normalizeCriterion,
  phaseEventData,
  phaseToActivate,
  reorderError,
  type GateCriterion,
} from '@weldsuite/flow-domain/gates';
import type { Env, Variables } from '../../types';
import { canAccessProject, canManageProject } from '../../lib/project-access';
import {
  PROJECT_DENIED,
  PROJECT_MANAGE_DENIED,
  parseBody,
  readQuery,
  type ScheduleContext,
} from '../../lib/schedule-request';
import {
  checkPhase,
  currentPhaseSetting,
  findLiveProject,
  findPhase,
  gateApprovers,
  gateNumberOf,
  listPhases,
  loadGateFacts,
  presentGateApproval,
  presentPhaseGate,
  presentPhaseSummary,
  waiversOf,
  type PhaseRow,
} from '../../services/project-phases';
import { announceApprovalsCancelled, announceApprovalsRequested } from '../../services/approvals';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
const phases = schema.projectPhases;

const LABEL = 'Phase';
const DATES_REVERSED = 'The end date cannot be before the start date';

function publishPhase(c: ScheduleContext, action: 'created' | 'updated' | 'deleted' | 'gate_requested', row: PhaseRow, extra: Record<string, unknown> = {}) {
  publishEntityEvent({ c, entityType: 'project_phase', entityId: row.id, action, data: phaseEventData(row, extra) });
}

/** The lifecycle of a project: phases in order, each with its gate number and approvals. */
async function presentLifecycle(c: ScheduleContext, projectId: string): Promise<PhaseList> {
  const db = c.get('tenantDb');
  const rows = await listPhases(db, projectId);
  return {
    currentPhaseId: rows.find((row) => row.status === 'active')?.id ?? null,
    phases: await Promise.all(rows.map((row, index) => presentPhaseSummary(db, row, index + 1))),
  };
}

/** The 400 for criteria that are not a catalogue key with its parameters, or point at nothing in the project. */
async function criteriaRefusal(c: ScheduleContext, projectId: string, criteria: GateCriterion[]): Promise<Response | null> {
  const invalid = criteriaError(criteria);
  if (invalid) return error.badRequest(c, invalid);
  const needed = gateFactsNeeded(criteria);
  const db = c.get('tenantDb');
  if (needed.deliverableIds.length > 0) {
    const found = await db
      .select({ id: schema.projectDeliverables.id })
      .from(schema.projectDeliverables)
      .where(
        and(
          eq(schema.projectDeliverables.projectId, projectId),
          inArray(schema.projectDeliverables.id, needed.deliverableIds),
          isNull(schema.projectDeliverables.deletedAt),
        ),
      );
    if (found.length !== needed.deliverableIds.length) return error.badRequest(c, GATE_MESSAGES.deliverableNotFound);
  }
  if (needed.decisionIds.length > 0) {
    const found = await db
      .select({ id: schema.projectDecisions.id })
      .from(schema.projectDecisions)
      .where(
        and(
          eq(schema.projectDecisions.projectId, projectId),
          inArray(schema.projectDecisions.id, needed.decisionIds),
          isNull(schema.projectDecisions.deletedAt),
        ),
      );
    if (found.length !== needed.decisionIds.length) return error.badRequest(c, GATE_MESSAGES.decisionNotFound);
  }
  return null;
}

const datesReversed = (start: Date | null, end: Date | null) => start !== null && end !== null && end < start;

// ── Reads ───────────────────────────────────────────────────────────────────

app.get('/', requirePermission('projects:read'), async (c) => {
  const db = c.get('tenantDb');
  const query = readQuery(c, listPhasesQuerySchema);
  if (!query.ok) return query.response;
  const { projectId } = query.data;
  try {
    const project = await findLiveProject(db, projectId);
    if (!project) return error.notFound(c, 'Project', projectId);
    if (!(await canAccessProject(c, projectId))) return error.forbidden(c, PROJECT_DENIED);
    return success(c, await presentLifecycle(c, projectId));
  } catch (err) {
    console.error('[flow-api/project-phases] list failed:', err);
    return error.internal(c, 'Failed to list phases');
  }
});

app.get('/:id', requirePermission('projects:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const phase = await findPhase(db, id);
    if (!phase) return error.notFound(c, LABEL, id);
    if (!(await canAccessProject(c, phase.projectId))) return error.forbidden(c, PROJECT_DENIED);
    return success(c, await presentPhaseSummary(db, phase, await gateNumberOf(db, phase)));
  } catch (err) {
    console.error('[flow-api/project-phases] get failed:', err);
    return error.internal(c, 'Failed to fetch phase');
  }
});

app.get('/:id/check', requirePermission('projects:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const phase = await findPhase(db, id);
    if (!phase) return error.notFound(c, LABEL, id);
    if (!(await canAccessProject(c, phase.projectId))) return error.forbidden(c, PROJECT_DENIED);
    const project = await findLiveProject(db, phase.projectId);
    if (!project) return error.notFound(c, 'Project', phase.projectId);
    return success(c, await presentPhaseGate(db, phase, project));
  } catch (err) {
    console.error('[flow-api/project-phases] check failed:', err);
    return error.internal(c, 'Failed to check the gate');
  }
});

// ── Create ──────────────────────────────────────────────────────────────────

app.post('/', requirePermission('projects:create'), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const body = await parseBody(c, createPhaseSchema);
  if (!body.ok) return body.response;
  const input = body.data;

  if (!(await canManageProject(c, input.projectId))) return error.forbidden(c, PROJECT_MANAGE_DENIED);
  if (!(await findLiveProject(db, input.projectId))) return error.notFound(c, 'Project', input.projectId);

  const plannedStart = input.plannedStart ? new Date(input.plannedStart) : null;
  const plannedEnd = input.plannedEnd ? new Date(input.plannedEnd) : null;
  if (datesReversed(plannedStart, plannedEnd)) return error.badRequest(c, DATES_REVERSED);
  const criteria = (input.gateCriteria ?? []).map((criterion) => normalizeCriterion(criterion as GateCriterion));
  const refusal = await criteriaRefusal(c, input.projectId, criteria);
  if (refusal) return refusal;

  try {
    const existing = await listPhases(db, input.projectId);
    const id = generateId('phs');
    const now = new Date();
    const position = existing.length > 0 ? Math.max(...existing.map((row) => row.position)) + 1 : 0;
    // A lifecycle always has an active phase: the first phase of a project starts it.
    const activate = phaseToActivate([...existing, { id, position, status: 'upcoming' }]);
    await atomically(db, (handle) => [
      handle.insert(phases).values({
        id,
        projectId: input.projectId,
        position,
        name: input.name,
        plannedStart,
        plannedEnd,
        status: activate === id ? 'active' : 'upcoming',
        gateCriteria: criteria,
        createdBy: userId,
        createdAt: now,
        updatedAt: now,
      }),
      ...(activate && activate !== id
        ? [handle.update(phases).set({ status: 'active', updatedAt: now }).where(eq(phases.id, activate))]
        : []),
      ...(activate
        ? [handle.update(schema.projects).set({ settings: currentPhaseSetting(activate), updatedAt: now }).where(eq(schema.projects.id, input.projectId))]
        : []),
    ]);
    const row = await findPhase(db, id);
    if (!row) return error.internal(c, 'Failed to create phase');
    publishPhase(c, 'created', row);
    if (activate && activate !== id) {
      const repaired = await findPhase(db, activate);
      if (repaired) publishPhase(c, 'updated', repaired);
    }
    return success(c, await presentPhaseSummary(db, row, await gateNumberOf(db, row)), 201);
  } catch (err) {
    console.error('[flow-api/project-phases] create failed:', err);
    return error.internal(c, 'Failed to create phase');
  }
});

// ── Reorder ─────────────────────────────────────────────────────────────────

// MUST be before /:id.
app.post('/reorder', requirePermission('projects:update'), async (c) => {
  const db = c.get('tenantDb');
  const body = await parseBody(c, reorderPhasesSchema);
  if (!body.ok) return body.response;
  const { projectId, ids } = body.data;
  if (!(await findLiveProject(db, projectId))) return error.notFound(c, 'Project', projectId);
  if (!(await canManageProject(c, projectId))) return error.forbidden(c, PROJECT_MANAGE_DENIED);

  try {
    const existing = await listPhases(db, projectId);
    const refusal = reorderError(existing, ids);
    if (refusal) return error.badRequest(c, refusal);
    const now = new Date();
    const moved = ids.flatMap((id, position) => {
      const row = existing.find((phase) => phase.id === id);
      return row && row.position !== position ? [{ id, position }] : [];
    });
    if (moved.length > 0) {
      await atomically(db, (handle) =>
        moved.map(({ id, position }) => handle.update(phases).set({ position, updatedAt: now }).where(eq(phases.id, id))),
      );
      for (const { id } of moved) {
        const row = await findPhase(db, id);
        if (row) publishPhase(c, 'updated', row);
      }
    }
    return success(c, await presentLifecycle(c, projectId));
  } catch (err) {
    console.error('[flow-api/project-phases] reorder failed:', err);
    return error.internal(c, 'Failed to reorder phases');
  }
});

// ── Edit ────────────────────────────────────────────────────────────────────

/** A date an edit sends: kept when it is not sent, cleared when it is empty. */
function editedDate(sent: string | null | undefined, current: Date | null): Date | null {
  if (sent === undefined) return current;
  return sent ? new Date(sent) : null;
}

/** The new gate criteria of an edit (none when it sends none), or the refusal for them. */
async function editedCriteria(
  c: ScheduleContext,
  existing: PhaseRow,
  sent: readonly unknown[] | undefined,
): Promise<{ criteria: GateCriterion[] | undefined } | { refusal: Response }> {
  if (sent === undefined) return { criteria: undefined };
  const criteria = sent.map((criterion) => normalizeCriterion(criterion as GateCriterion));
  const refusal = await criteriaRefusal(c, existing.projectId, criteria);
  if (refusal) return { refusal };
  // A gate that is waiting for approval was approved on these criteria.
  if (existing.gateRequestedAt !== null) return { refusal: error.conflict(c, GATE_MESSAGES.alreadyRequested) };
  return { criteria };
}

app.patch('/:id', requirePermission('projects:update'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const existing = await findPhase(db, id);
  if (!existing) return error.notFound(c, LABEL, id);
  if (!(await canManageProject(c, existing.projectId))) return error.forbidden(c, PROJECT_MANAGE_DENIED);
  const body = await parseBody(c, updatePhaseSchema);
  if (!body.ok) return body.response;
  const input = body.data;

  if (existing.status === 'passed') return error.conflict(c, GATE_MESSAGES.phasePassed);
  const plannedStart = editedDate(input.plannedStart, existing.plannedStart);
  const plannedEnd = editedDate(input.plannedEnd, existing.plannedEnd);
  if (datesReversed(plannedStart, plannedEnd)) return error.badRequest(c, DATES_REVERSED);
  const edited = await editedCriteria(c, existing, input.gateCriteria);
  if ('refusal' in edited) return edited.refusal;
  const { criteria } = edited;

  try {
    const now = new Date();
    await db
      .update(phases)
      .set({
        ...(input.name !== undefined && { name: input.name }),
        ...(input.plannedStart !== undefined && { plannedStart }),
        ...(input.plannedEnd !== undefined && { plannedEnd }),
        // New criteria start clean: the old manual ticks and waivers belonged to the old ones.
        ...(criteria !== undefined && { gateCriteria: criteria, gateResult: null }),
        updatedAt: now,
      })
      .where(and(eq(phases.id, id), isNull(phases.deletedAt)));
    const row = await findPhase(db, id);
    if (!row) return error.notFound(c, LABEL, id);
    publishPhase(c, 'updated', row);
    return success(c, await presentPhaseSummary(db, row, await gateNumberOf(db, row)));
  } catch (err) {
    console.error('[flow-api/project-phases] update failed:', err);
    return error.internal(c, 'Failed to update phase');
  }
});

// ── Delete ──────────────────────────────────────────────────────────────────

app.delete('/:id', requirePermission('projects:delete'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const existing = await findPhase(db, id);
    if (!existing) return error.notFound(c, LABEL, id);
    if (!(await canManageProject(c, existing.projectId))) return error.forbidden(c, PROJECT_MANAGE_DENIED);
    if (existing.status === 'passed') return error.conflict(c, GATE_MESSAGES.phasePassed);

    const now = new Date();
    const remaining = (await listPhases(db, existing.projectId)).filter((row) => row.id !== id);
    const activate = phaseToActivate(remaining);
    await atomically(db, (handle) => [
      handle.update(phases).set({ deletedAt: now, updatedAt: now }).where(and(eq(phases.id, id), isNull(phases.deletedAt))),
      ...(activate ? [handle.update(phases).set({ status: 'active', updatedAt: now }).where(eq(phases.id, activate))] : []),
      ...(existing.status === 'active'
        ? [handle.update(schema.projects).set({ settings: currentPhaseSetting(activate), updatedAt: now }).where(eq(schema.projects.id, existing.projectId))]
        : []),
    ]);
    // Nobody is asked about a gate that no longer exists.
    announceApprovalsCancelled(c, await cancelPendingApprovals(db, { subjectType: 'gate', subjectId: id, includeDecided: true, now }));
    publishPhase(c, 'deleted', existing);
    if (activate) {
      const row = await findPhase(db, activate);
      if (row) publishPhase(c, 'updated', row);
    }
    return noContent(c);
  } catch (err) {
    console.error('[flow-api/project-phases] delete failed:', err);
    return error.internal(c, 'Failed to delete phase');
  }
});

// ── Manual criteria ─────────────────────────────────────────────────────────

app.patch('/:id/criteria/:index', requirePermission('projects:update'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const phase = await findPhase(db, id);
  if (!phase) return error.notFound(c, LABEL, id);
  if (!(await canManageProject(c, phase.projectId))) return error.forbidden(c, PROJECT_MANAGE_DENIED);
  const body = await parseBody(c, tickCriterionSchema);
  if (!body.ok) return body.response;

  const raw = c.req.param('index');
  const index = /^\d+$/.test(raw) ? Number(raw) : -1;
  const criteria = phase.gateCriteria as GateCriterion[];
  if (phase.status === 'passed') return error.conflict(c, GATE_MESSAGES.phasePassed);
  if (index < 0 || index >= criteria.length) return error.badRequest(c, GATE_MESSAGES.criterionNotFound);
  const criterion = criteria[index];
  if (!isManualCriterion(criterion)) return error.badRequest(c, GATE_MESSAGES.notManual);
  if (phase.gateRequestedAt !== null) return error.conflict(c, GATE_MESSAGES.alreadyRequested);

  try {
    const now = new Date();
    const next = criteria.map((entry, at) =>
      at === index ? { manual: criterion.manual, met: body.data.met, metAt: body.data.met ? now.toISOString() : null } : entry,
    );
    await db.update(phases).set({ gateCriteria: next, updatedAt: now }).where(and(eq(phases.id, id), isNull(phases.deletedAt)));
    const row = await findPhase(db, id);
    const project = await findLiveProject(db, phase.projectId);
    if (!row || !project) return error.notFound(c, LABEL, id);
    publishPhase(c, 'updated', row);
    return success(c, await presentPhaseGate(db, row, project));
  } catch (err) {
    console.error('[flow-api/project-phases] tick failed:', err);
    return error.internal(c, 'Failed to update the criterion');
  }
});

// ── Waive ───────────────────────────────────────────────────────────────────

app.post('/:id/waive', requirePermission('projects:update'), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const id = c.req.param('id');
  const phase = await findPhase(db, id);
  if (!phase) return error.notFound(c, LABEL, id);
  if (!(await canAccessProject(c, phase.projectId))) return error.forbidden(c, PROJECT_DENIED);
  const project = await findLiveProject(db, phase.projectId);
  if (!project) return error.notFound(c, 'Project', phase.projectId);
  // The sponsor's call, and only theirs (the project manager when no sponsor is named).
  if (sponsorOf(project.settings, project.projectManagerId) !== userId) return error.forbidden(c, GATE_MESSAGES.notSponsor);
  const body = await parseBody(c, waiveCriterionSchema);
  if (!body.ok) return body.response;
  const { criterionIndex, note } = body.data;

  if (phase.status === 'passed') return error.conflict(c, GATE_MESSAGES.phasePassed);
  if (phase.gateRequestedAt !== null) return error.conflict(c, GATE_MESSAGES.waiveAfterRequest);
  const criteria = phase.gateCriteria as GateCriterion[];
  if (criterionIndex >= criteria.length) return error.badRequest(c, GATE_MESSAGES.criterionNotFound);

  try {
    const waivers = waiversOf(phase);
    const check = await checkPhase(db, phase);
    const item = check.items[criterionIndex];
    if (item.met) return error.conflict(c, GATE_MESSAGES.alreadyMet);
    if (waivers.some((waiver) => waiver.index === criterionIndex)) return error.conflict(c, GATE_MESSAGES.alreadyWaived);

    const now = new Date();
    const nextWaivers = [...waivers, { index: criterionIndex, note, by: userId, at: now.toISOString() }];
    const facts = await loadGateFacts(db, phase.projectId, criteria);
    const result = gateResultOf(checkGate(criteria, facts, nextWaivers), criteria, nextWaivers, now.toISOString());
    await db.update(phases).set({ gateResult: result, updatedAt: now }).where(and(eq(phases.id, id), isNull(phases.deletedAt)));
    const row = await findPhase(db, id);
    if (!row) return error.notFound(c, LABEL, id);
    publishPhase(c, 'updated', row, { waivedCriterion: criterionIndex });
    return success(c, await presentPhaseGate(db, row, project));
  } catch (err) {
    console.error('[flow-api/project-phases] waive failed:', err);
    return error.internal(c, 'Failed to waive the criterion');
  }
});

// ── Request approval ────────────────────────────────────────────────────────

app.post('/:id/request-approval', requirePermission('projects:update'), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const id = c.req.param('id');
  const phase = await findPhase(db, id);
  if (!phase) return error.notFound(c, LABEL, id);
  if (!(await canManageProject(c, phase.projectId))) return error.forbidden(c, PROJECT_MANAGE_DENIED);
  const project = await findLiveProject(db, phase.projectId);
  if (!project) return error.notFound(c, 'Project', phase.projectId);

  try {
    const check = await checkPhase(db, phase);
    const approverIds = gateApprovers(project);
    const block = gateRequestBlock(phase, check, approverIds.length > 0);
    if (block) return error.conflict(c, GATE_REQUEST_BLOCK_MESSAGES[block]);

    // A gate asked for before and turned down starts its approvals over.
    const now = new Date();
    announceApprovalsCancelled(c, await cancelPendingApprovals(db, { subjectType: 'gate', subjectId: id, includeDecided: true, now }));
    const sponsor = sponsorOf(project.settings, project.projectManagerId);
    const asked = await requestApprovals(db, {
      projectId: phase.projectId,
      subjectType: 'gate',
      subjectId: id,
      requestedBy: userId,
      now,
      rows: approverIds.map((approverId) => ({
        approverId,
        roleLabel: approverId === sponsor ? 'Sponsor' : 'Change board',
        step: 1,
        rule: { code: 'gate', params: { phaseId: id, phaseName: phase.name } },
      })),
    });
    if (!asked.ok) return asked.code === 'invalid' ? error.badRequest(c, asked.message) : error.conflict(c, asked.message);

    const criteria = phase.gateCriteria as GateCriterion[];
    await db
      .update(phases)
      .set({
        gateRequestedAt: now,
        gateResult: gateResultOf(check, criteria, waiversOf(phase), now.toISOString()),
        updatedAt: now,
      })
      .where(and(eq(phases.id, id), isNull(phases.deletedAt)));
    const row = await findPhase(db, id);
    if (!row) return error.notFound(c, LABEL, id);

    publishPhase(c, 'gate_requested', row, { approverIds: asked.rows.map((approval) => approval.approverId) });
    announceApprovalsRequested(c, {
      rows: asked.rows,
      subject: { code: null, title: `${phase.name} gate` },
      projectName: project.name,
    });
    const result: PhaseGateRequestResult = {
      phase: await presentPhaseGate(db, row, project),
      approvals: asked.rows.map(presentGateApproval),
    };
    return success(c, result, 201);
  } catch (err) {
    console.error('[flow-api/project-phases] request approval failed:', err);
    return error.internal(c, 'Failed to request approval of the gate');
  }
});

export const projectPhasesRoutes = app;
