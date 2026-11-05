/**
 * The subject events of the governance registers (proposed decisions and
 * deliverable sign-off) once an answer to `POST /api/approvals/:id/decide`
 * settles them (design: weldflow-delivery-and-portfolio.md; FLOW-016).
 *
 * Asking and cancelling go through the approvals core
 * (`announceApprovalsRequested` / `announceApprovalsCancelled` in
 * `./approvals`), so the `flow_approval` events are one payload for every
 * slice. The subject handlers (`./project-decisions`, `./project-deliverables`)
 * run without a request, so the subject's own event
 * (`project_decision.decided`, `project_deliverable.accepted`) is published by
 * the aftermath registered at the bottom of this file. Importing it (the
 * approvals routes do) is what registers it.
 */

import type { Context } from 'hono';
import { publishEntityEvent } from '@weldsuite/entity-events';
import type { Database } from '@weldsuite/worker-kit/db';
import type { ApprovalSubjectType } from '@weldsuite/flow-domain/approvals';
import { decisionEventData } from '@weldsuite/flow-domain/decisions';
import { deliverableEventData } from '@weldsuite/flow-domain/deliverables';
import type { Env, Variables } from '../types';
import { registerApprovalAftermath } from './approvals';
import { findDecision } from './project-decisions';
import { findDeliverable } from './project-deliverables';

type AppContext = Context<{ Bindings: Env; Variables: Variables }>;

/**
 * The subject's own event once its approvals settled it. A subject type that
 * is not a governance register is ignored.
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

for (const type of ['decision', 'deliverable'] as const) {
  registerApprovalAftermath(type, async (c, info) => {
    await publishApprovalSubjectResolved(c, c.get('tenantDb'), type, info.subjectId);
  });
}
