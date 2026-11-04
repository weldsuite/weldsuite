/**
 * Deliverable rules: numbering, acceptance criteria, accepting and signing off,
 * and the shapes a deliverable takes on the wire and in entity events
 * (design: weldflow-project-control.md; ADRs FLOW-011 and FLOW-016).
 *
 * Pure functions, no database and no Hono context. flow-api's
 * `/api/project-deliverables` routes use them, and the Rust flow-domain mirrors
 * them. Every message returned here is sent to the client as it is, so the two
 * backends answer alike.
 */

import type { schema } from '@weldsuite/worker-kit/db';
import type { AcceptanceCriterion } from '@weldsuite/db/schema/project-control';
import type {
  AcceptanceCriterionInput,
  Deliverable,
  SignoffApproval,
} from '@weldsuite/app-api-client/schemas/project-governance';
import type { ApprovalRow, ApprovalRowInput, ResolvedApprovalOutcome } from './approvals';
import type { NumberSequence } from './task-numbering';

type DeliverableRow = typeof schema.projectDeliverables.$inferSelect;

export const DELIVERABLE_MESSAGES = {
  datesOrder: 'plannedEnd cannot be before plannedStart',
  alreadyAccepted: 'This deliverable has already been accepted',
  criteriaOpen: 'Every acceptance criterion has to be met first',
  acceptedLocked: 'An accepted deliverable can only change its visibility and position',
  signoffWaiting: 'A sign-off is already waiting for an answer',
  noSponsor: 'This project has no sponsor to ask for sign-off',
  notRejectable: 'An accepted deliverable cannot be rejected',
} as const;

// ── Numbering ───────────────────────────────────────────────────────────────

/** The counter of a project's deliverables: scope `del:<projectId>`, prefix `D`. */
export function deliverableSequence(projectId: string): NumberSequence {
  return { scope: `del:${projectId}`, prefix: 'D' };
}

/** The display code of a deliverable: `D3`. */
export function deliverableCode(number: number): string {
  return `D${number}`;
}

// ── Acceptance criteria ─────────────────────────────────────────────────────

/**
 * The criteria a request leaves the deliverable with. A criterion is met or
 * not; `metAt` is the moment it was marked met: kept while the same criterion
 * (same position and text) stays met, set to `now` when it turns met, null when
 * it is not met.
 */
export function applyCriteria(
  previous: readonly AcceptanceCriterion[],
  next: readonly AcceptanceCriterionInput[],
  now: Date,
): AcceptanceCriterion[] {
  return next.map((criterion, index) => {
    const met = criterion.met === true;
    if (!met) return { text: criterion.text, met: false, metAt: null };
    const before = previous[index];
    const metAt = before && before.met && before.text === criterion.text && before.metAt ? before.metAt : now.toISOString();
    return { text: criterion.text, met: true, metAt };
  });
}

/** How many criteria are met, out of how many. */
export function criteriaCounts(criteria: readonly Pick<AcceptanceCriterion, 'met'>[]): { met: number; total: number } {
  return { met: criteria.filter((criterion) => criterion.met).length, total: criteria.length };
}

// ── Dates, editing, accepting ───────────────────────────────────────────────

/** The refusal (400) of a planned end before the planned start, or null. */
export function deliverableDatesError(plannedStart: Date | null, plannedEnd: Date | null): string | null {
  if (plannedStart && plannedEnd && plannedEnd.getTime() < plannedStart.getTime()) return DELIVERABLE_MESSAGES.datesOrder;
  return null;
}

/** The refusal (409) of an edit that changes more than an accepted deliverable allows, or null. */
export function acceptedEditError(status: string, bodyKeys: readonly string[]): string | null {
  if (status !== 'accepted') return null;
  const allowed = ['clientVisible', 'position'];
  return bodyKeys.some((key) => !allowed.includes(key)) ? DELIVERABLE_MESSAGES.acceptedLocked : null;
}

/** The refusal (409) of accepting or asking sign-off for a deliverable that cannot be accepted, or null. */
export function acceptError(row: Pick<DeliverableRow, 'status' | 'acceptanceCriteria'>): string | null {
  if (row.status === 'accepted') return DELIVERABLE_MESSAGES.alreadyAccepted;
  const { met, total } = criteriaCounts(row.acceptanceCriteria);
  return met < total ? DELIVERABLE_MESSAGES.criteriaOpen : null;
}

/** The refusal (409) of rejecting a deliverable that is already accepted, or null. */
export function rejectError(status: string): string | null {
  return status === 'accepted' ? DELIVERABLE_MESSAGES.notRejectable : null;
}

// ── Sign-off ────────────────────────────────────────────────────────────────

/**
 * The approvals of a sign-off (FLOW-016): the sponsor first (step 1, rule
 * `deliverable_sponsor`), then, when asked for, the client contact (step 2,
 * rule `deliverable_client`). The second waits for the first.
 */
export function signoffApprovalRows(sponsorId: string, contactId: string | undefined, dueAt: Date | null): ApprovalRowInput[] {
  const rows: ApprovalRowInput[] = [
    { approverKind: 'member', approverId: sponsorId, roleLabel: 'Sponsor', step: 1, rule: { code: 'deliverable_sponsor' }, dueAt },
  ];
  if (contactId) {
    rows.push({
      approverKind: 'contact',
      approverId: contactId,
      roleLabel: 'Client',
      step: 2,
      rule: { code: 'deliverable_client' },
      dueAt,
    });
  }
  return rows;
}

/** Whether a sign-off is still waiting for an answer: one of its rows is open. */
export function signoffIsOpen(rows: readonly Pick<ApprovalRow, 'decision'>[]): boolean {
  return rows.some((row) => row.decision === 'pending' || row.decision === 'info_requested');
}

/**
 * What a settled sign-off does to the deliverable. Approved: accepted, by the
 * member or contact who gave the answer that settled it (else the last one who
 * approved), as of `now`. Rejected: rejected.
 */
export function deliverableResolution(
  outcome: ResolvedApprovalOutcome,
  actorId: string | null,
  rows: readonly Pick<ApprovalRow, 'decidedBy' | 'decision' | 'step'>[],
  now: Date,
): { status: 'accepted'; acceptedBy: string | null; acceptedAt: Date } | { status: 'rejected' } {
  if (outcome === 'rejected') return { status: 'rejected' };
  const approving = rows.filter((row) => row.decision === 'approved' || row.decision === 'approved_with_conditions');
  const last = approving.reduce<(typeof approving)[number] | null>((best, row) => (!best || row.step >= best.step ? row : best), null);
  return { status: 'accepted', acceptedBy: actorId ?? last?.decidedBy ?? null, acceptedAt: now };
}

// ── Wire shapes ─────────────────────────────────────────────────────────────

const iso = (value: Date | null): string | null => (value ? value.toISOString() : null);

/** A register item that affects a deliverable. */
export interface DeliverableRaid {
  id: string;
  kind: string;
  code: string;
  title: string;
}

/** A deliverable as the routes answer it. */
export function presentDeliverable(
  row: DeliverableRow,
  taskProgress: { done: number; total: number },
  raid: DeliverableRaid[],
): Deliverable {
  const counts = criteriaCounts(row.acceptanceCriteria);
  return {
    id: row.id,
    projectId: row.projectId,
    number: row.number,
    code: deliverableCode(row.number),
    title: row.title,
    description: row.description,
    ownerId: row.ownerId,
    status: row.status,
    plannedStart: iso(row.plannedStart),
    plannedEnd: iso(row.plannedEnd),
    acceptanceCriteria: row.acceptanceCriteria.map((criterion) => ({
      text: criterion.text,
      met: criterion.met,
      metAt: criterion.metAt,
    })),
    acceptedBy: row.acceptedBy,
    acceptedAt: iso(row.acceptedAt),
    position: row.position,
    clientVisible: row.clientVisible,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    deletedAt: iso(row.deletedAt),
    taskProgress,
    criteriaMet: counts.met,
    criteriaTotal: counts.total,
    raid,
  };
}

/** One answer of a sign-off. */
export function presentSignoffApproval(row: ApprovalRow): SignoffApproval {
  return {
    id: row.id,
    approverKind: row.approverKind,
    approverId: row.approverId,
    roleLabel: row.roleLabel,
    step: row.step,
    decision: row.decision,
    note: row.note,
    dueAt: iso(row.dueAt),
    decidedAt: iso(row.decidedAt),
  };
}

/** The payload of a `project_deliverable` event: ids and statuses, no free text beyond the title. */
export function deliverableEventData(row: DeliverableRow) {
  return {
    id: row.id,
    projectId: row.projectId,
    number: row.number,
    code: deliverableCode(row.number),
    title: row.title,
    status: row.status,
    ownerId: row.ownerId,
    acceptedBy: row.acceptedBy,
    clientVisible: row.clientVisible,
  };
}
