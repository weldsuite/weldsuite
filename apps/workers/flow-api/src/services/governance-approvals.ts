/**
 * Entity events of the approvals the governance registers ask for (proposed
 * decisions and deliverable sign-off), and the events of a subject settled
 * through `/api/approvals` (design: weldflow-delivery-and-portfolio.md;
 * FLOW-016).
 *
 * `requestApprovals` and `cancelPendingApprovals` leave the events to their
 * caller; `publishRequested` and `publishCancelled` are the one payload of a
 * `flow_approval` event, so every slice that asks publishes alike.
 * `publishApprovalSubjectResolved` is for the route that answers a review: the
 * subject handlers (`./project-decisions`, `./project-deliverables`) run
 * without a request, so the subject's own event (`project_decision.decided`,
 * `project_deliverable.accepted`) is published by the route after the answer.
 */

import type { Context } from 'hono';
import { publishEntityEvent } from '@weldsuite/entity-events';
import type { Database } from '@weldsuite/worker-kit/db';
import type { ApprovalRow, ApprovalSubjectType } from '@weldsuite/flow-domain/approvals';
import { decisionEventData } from '@weldsuite/flow-domain/decisions';
import { deliverableEventData } from '@weldsuite/flow-domain/deliverables';
import type { Env, Variables } from '../types';
import { findDecision } from './project-decisions';
import { findDeliverable } from './project-deliverables';

type AppContext = Context<{ Bindings: Env; Variables: Variables }>;

/** The payload of a `flow_approval` event: who is asked, for what, in which step. */
export function approvalEventData(row: ApprovalRow) {
  return {
    id: row.id,
    projectId: row.projectId,
    subjectType: row.subjectType,
    subjectId: row.subjectId,
    approverKind: row.approverKind,
    approverId: row.approverId,
    step: row.step,
    decision: row.decision,
    dueAt: row.dueAt ? row.dueAt.toISOString() : null,
  };
}

/** One `flow_approval.requested` event per row, in step order. */
export function publishRequested(c: AppContext, rows: readonly ApprovalRow[]): void {
  for (const row of rows) {
    publishEntityEvent({ c, entityType: 'flow_approval', entityId: row.id, action: 'requested', data: approvalEventData(row) });
  }
}

/** One `flow_approval.cancelled` event per cleared row. */
export function publishCancelled(c: AppContext, rows: readonly ApprovalRow[]): void {
  for (const row of rows) {
    publishEntityEvent({ c, entityType: 'flow_approval', entityId: row.id, action: 'cancelled', data: approvalEventData(row) });
  }
}

/**
 * The subject's own event once its approvals settled it. Call after
 * `decideApproval` answered with `resolved: true`; a subject type that is not a
 * governance register is ignored.
 */
export async function publishApprovalSubjectResolved(
  c: AppContext,
  db: Database,
  subjectType: ApprovalSubjectType,
  subjectId: string,
): Promise<void> {
  if (subjectType === 'decision') {
    const row = await findDecision(db, subjectId);
    if (row?.status === 'decided') {
      publishEntityEvent({ c, entityType: 'project_decision', entityId: row.id, action: 'decided', data: decisionEventData(row) });
    }
  } else if (subjectType === 'deliverable') {
    const row = await findDeliverable(db, subjectId);
    if (row?.status === 'accepted') {
      publishEntityEvent({ c, entityType: 'project_deliverable', entityId: row.id, action: 'accepted', data: deliverableEventData(row) });
    } else if (row?.status === 'rejected') {
      publishEntityEvent({ c, entityType: 'project_deliverable', entityId: row.id, action: 'updated', data: deliverableEventData(row) });
    }
  }
}
