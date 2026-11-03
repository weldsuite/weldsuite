/**
 * Change requests for flow-api (FLOW-012, FLOW-013): the approval subject
 * `change_request`, its entity events, and the queries `/api/project-changes`
 * and `/api/project-baselines` share.
 *
 * Importing this file registers the subject handler, so every isolate that
 * serves `/api/approvals/:id/decide` can settle a change request:
 *
 *   approved  `applyApprovedChange` writes it to the plan, the budget, the
 *             baseline and the decision log in one batch
 *   rejected  `recordRejectedChange` records the reason as a decided decision
 *
 * The handler runs without a request, so the events of what it wrote are
 * published by the aftermath registered below, once the answer is stored.
 */

import type { Context } from 'hono';
import { and, eq, isNull } from 'drizzle-orm';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { registerApprovalSubject } from '@weldsuite/flow-domain/approvals';
import { baselineEventData, type PlanState } from '@weldsuite/flow-domain/baselines';
import {
  applyApprovedChange,
  changeEventData,
  decisionEventData,
  deliverableCode,
  findChangeRequest,
  recordRejectedChange,
  type AppliedChange,
  type ChangeRequestRow,
} from '@weldsuite/flow-domain/changes';
import { registerApprovalAftermath } from './approvals';
import { projectAnalyticsPayload } from '../lib/weldflow-analytics-payload';
import type { Env, Variables } from '../types';

type AppContext = Context<{ Bindings: Env; Variables: Variables }>;

// ── Subject handler ─────────────────────────────────────────────────────────

/**
 * What the handler wrote, for the aftermath of the same answer to publish. The
 * handler has no request, the aftermath has no handle on the handler's result;
 * both run inside one `POST /api/approvals/:id/decide`, so a change id is
 * enough to pass it on. Entries are taken as soon as they are used.
 */
const applied = new Map<string, AppliedChange>();
const APPLIED_MAX = 100;

function remember(changeId: string, result: AppliedChange): void {
  if (applied.size >= APPLIED_MAX) {
    const oldest = applied.keys().next().value;
    if (oldest !== undefined) applied.delete(oldest);
  }
  applied.set(changeId, result);
}

registerApprovalSubject('change_request', {
  async onResolved(db, subjectId, outcome, context) {
    const input = { actorId: context.actor?.id ?? null, rows: context.rows, now: context.now };
    const result =
      outcome === 'approved' ? await applyApprovedChange(db, subjectId, input) : await recordRejectedChange(db, subjectId, input);
    if (result.outcome === 'applied') remember(subjectId, result);
  },
});

// ── Events ──────────────────────────────────────────────────────────────────

type ChangeAction = 'created' | 'updated' | 'deleted' | 'submitted' | 'approved' | 'rejected';

export function publishChange(c: AppContext, action: ChangeAction, row: ChangeRequestRow, extra: Record<string, unknown> = {}): void {
  publishEntityEvent({
    c,
    entityType: 'project_change_request',
    entityId: row.id,
    action,
    data: { ...changeEventData(row), ...extra },
  });
}

function publishDecision(c: AppContext, row: NonNullable<AppliedChange['decision']>): void {
  publishEntityEvent({ c, entityType: 'project_decision', entityId: row.id, action: 'created', data: decisionEventData(row) });
  publishEntityEvent({ c, entityType: 'project_decision', entityId: row.id, action: 'decided', data: decisionEventData(row) });
}

/** The events of an approved change: the change, what it moved and added, the project, the baseline and the decision. */
async function publishApplied(c: AppContext, change: ChangeRequestRow, result: AppliedChange): Promise<void> {
  const db = c.get('tenantDb');
  publishChange(c, 'approved', change);

  const planChanges = change.planChanges ?? {};
  const scopeChanges = change.scopeChanges ?? {};
  const moved = (planChanges.milestones ?? []).map((move) => move.milestoneId);
  if (moved.length > 0) {
    const rows = await db
      .select({ id: schema.milestones.id, name: schema.milestones.name, status: schema.milestones.status })
      .from(schema.milestones)
      .where(and(eq(schema.milestones.projectId, change.projectId), isNull(schema.milestones.deletedAt)));
    for (const id of moved) {
      const row = rows.find((m) => m.id === id);
      if (row) {
        publishEntityEvent({
          c,
          entityType: 'project_milestone',
          entityId: id,
          action: 'updated',
          data: { id, projectId: change.projectId, name: row.name, status: row.status },
        });
      }
    }
  }

  const deliverableRows = await db
    .select({
      id: schema.projectDeliverables.id,
      number: schema.projectDeliverables.number,
      title: schema.projectDeliverables.title,
      status: schema.projectDeliverables.status,
      deletedAt: schema.projectDeliverables.deletedAt,
    })
    .from(schema.projectDeliverables)
    .where(eq(schema.projectDeliverables.projectId, change.projectId));
  const deliverableEvent = (id: string, action: 'created' | 'updated' | 'deleted') => {
    const row = deliverableRows.find((d) => d.id === id);
    if (!row) return;
    publishEntityEvent({
      c,
      entityType: 'project_deliverable',
      entityId: id,
      action,
      data: { id, projectId: change.projectId, number: row.number, code: deliverableCode(row.number), title: row.title, status: row.status },
    });
  };
  for (const item of scopeChanges.add ?? []) if (item.deliverableId) deliverableEvent(item.deliverableId, 'created');
  for (const move of planChanges.deliverables ?? []) deliverableEvent(move.deliverableId, 'updated');
  for (const id of scopeChanges.remove ?? []) deliverableEvent(id, 'deleted');

  if (planChanges.goLive || (change.costDelta !== null && Number(change.costDelta) !== 0)) {
    const [project] = await db.select().from(schema.projects).where(eq(schema.projects.id, change.projectId)).limit(1);
    if (project) {
      publishEntityEvent({
        c,
        entityType: 'project',
        entityId: project.id,
        action: 'updated',
        data: projectAnalyticsPayload(project as Record<string, unknown>),
      });
    }
  }
  if (result.baseline) {
    publishEntityEvent({
      c,
      entityType: 'project_baseline',
      entityId: result.baseline.id,
      action: 'created',
      data: baselineEventData(result.baseline),
    });
  }
  if (result.decision) publishDecision(c, result.decision);
}

registerApprovalAftermath('change_request', async (c, info) => {
  const change = await findChangeRequest(c.get('tenantDb'), info.subjectId);
  const result = applied.get(info.subjectId);
  applied.delete(info.subjectId);
  if (!change || !result) return;
  if (info.outcome === 'approved') {
    await publishApplied(c, change, result);
  } else {
    publishChange(c, 'rejected', change);
    if (result.decision) publishDecision(c, result.decision);
  }
});

// ── Queries ─────────────────────────────────────────────────────────────────

export type { PlanState };

/** The project fields change requests need, or null when it is gone. */
export async function findLiveProject(db: Database, projectId: string) {
  const [row] = await db
    .select({
      id: schema.projects.id,
      name: schema.projects.name,
      projectManagerId: schema.projects.projectManagerId,
      budgetCurrency: schema.projects.budgetCurrency,
      settings: schema.projects.settings,
    })
    .from(schema.projects)
    .where(and(eq(schema.projects.id, projectId), isNull(schema.projects.deletedAt)))
    .limit(1);
  return row ?? null;
}

/** The ids of the live milestones and deliverables of a project. */
export async function knownPlanIds(db: Database, projectId: string): Promise<{ milestoneIds: Set<string>; deliverableIds: Set<string> }> {
  const [milestones, deliverables] = await Promise.all([
    db
      .select({ id: schema.milestones.id })
      .from(schema.milestones)
      .where(and(eq(schema.milestones.projectId, projectId), isNull(schema.milestones.deletedAt))),
    db
      .select({ id: schema.projectDeliverables.id })
      .from(schema.projectDeliverables)
      .where(and(eq(schema.projectDeliverables.projectId, projectId), isNull(schema.projectDeliverables.deletedAt))),
  ]);
  return { milestoneIds: new Set(milestones.map((m) => m.id)), deliverableIds: new Set(deliverables.map((d) => d.id)) };
}

/** The user ids that belong to a project: its manager and its active members (any role, a viewer included). */
export async function projectMemberIds(db: Database, projectId: string, projectManagerId: string | null): Promise<Set<string>> {
  const rows = await db
    .select({ userId: schema.projectMembers.userId })
    .from(schema.projectMembers)
    .where(
      and(eq(schema.projectMembers.projectId, projectId), eq(schema.projectMembers.isActive, true), isNull(schema.projectMembers.deletedAt)),
    );
  const ids = new Set(rows.map((row) => row.userId));
  if (projectManagerId) ids.add(projectManagerId);
  return ids;
}

