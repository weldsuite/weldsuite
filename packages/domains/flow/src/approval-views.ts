/**
 * The shapes of the approvals routes (`/api/approvals`) and the rules of their
 * inputs that more than one backend needs: delegation checks, the payload of a
 * `flow_approval` entity event, how an approval row is shown (My reviews, "Sent
 * by me", the change request's approvers), and the figures a subject exposes
 * to the reviewer.
 *
 * Pure functions, no database. The Rust flow-domain mirrors them in
 * `approval_views.rs`. Every message returned here is sent to the client as it
 * is, so both backends answer alike.
 */

import type { ReviewApprover, ReviewImpact, ReviewLink } from '@weldsuite/app-api-client/schemas/flow-approvals';
import type { ApprovalDelegationRow, ApprovalRow } from './approvals';

export type { ReviewApprover, ReviewImpact, ReviewLink };

export const DELEGATION_MESSAGES = {
  self: 'You cannot delegate your reviews to yourself',
  period: 'The end of the delegation must be after its start',
  ended: 'The delegation has already ended',
  notFound: 'Delegation not found',
} as const;

export const SPONSOR_MESSAGES = {
  notMember: 'The sponsor must be a member of this project',
} as const;

export const TIMESHEET_MESSAGES = {
  onlyApproveOrDecline: 'Time entries can only be approved or declined',
  noPermission: 'You do not have permission to review time entries',
} as const;

/** The refusal for a new delegation, or null. Checked in this order. */
export function delegationInputError(input: { memberId: string; delegateId: string; startsAt: Date; endsAt: Date }, now: Date): string | null {
  if (input.memberId === input.delegateId) return DELEGATION_MESSAGES.self;
  if (input.endsAt.getTime() <= input.startsAt.getTime()) return DELEGATION_MESSAGES.period;
  if (input.endsAt.getTime() <= now.getTime()) return DELEGATION_MESSAGES.ended;
  return null;
}

const iso = (date: Date | null | undefined): string | null => (date ? date.toISOString() : null);

/** One approver of a subject and where they stand. */
export function presentReviewApprover(row: ApprovalRow): ReviewApprover {
  return {
    approvalId: row.id,
    approverKind: row.approverKind,
    approverId: row.approverId,
    roleLabel: row.roleLabel,
    step: row.step,
    decision: row.decision,
    note: row.note,
    decidedAt: iso(row.decidedAt),
    delegatedFrom: row.delegatedFrom,
  };
}

/** The payload of a `flow_approval` entity event: ids, the step and the answer; notes stay out (EVT-005). */
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
    dueAt: iso(row.dueAt),
    delegatedFrom: row.delegatedFrom,
  };
}

/** A delegation as the routes answer it. */
export function presentDelegation(row: ApprovalDelegationRow) {
  return {
    id: row.id,
    memberId: row.memberId,
    delegateId: row.delegateId,
    startsAt: row.startsAt.toISOString(),
    endsAt: row.endsAt.toISOString(),
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** The payload of a `flow_approval` `delegated` event: a new delegation, or one that was ended early (`revoked`). */
export function delegationEventData(row: ApprovalDelegationRow, revoked: boolean) {
  return {
    id: row.id,
    memberId: row.memberId,
    delegateId: row.delegateId,
    startsAt: row.startsAt.toISOString(),
    endsAt: row.endsAt.toISOString(),
    revoked,
  };
}

const SUMMARY_MAX = 280;

/** A short plain text for the review's detail panel: whitespace collapsed, cut at 280 characters. */
export function summarize(text: string | null | undefined): string | null {
  const flat = (text ?? '').replace(/\s+/g, ' ').trim();
  if (flat.length === 0) return null;
  return flat.length > SUMMARY_MAX ? `${flat.slice(0, SUMMARY_MAX - 1).trimEnd()}…` : flat;
}

/** The figures a subject exposes: only the ones it has. */
export function reviewImpacts(figures: {
  cost?: string | null;
  currency?: string | null;
  scheduleDays?: number | null;
  riskScore?: number | null;
  hours?: number | null;
}): ReviewImpact[] {
  const impacts: ReviewImpact[] = [];
  if (figures.cost !== null && figures.cost !== undefined) impacts.push({ kind: 'cost', value: figures.cost, currency: figures.currency ?? null });
  if (figures.scheduleDays !== null && figures.scheduleDays !== undefined) impacts.push({ kind: 'schedule_days', value: figures.scheduleDays });
  if (figures.riskScore !== null && figures.riskScore !== undefined) impacts.push({ kind: 'risk_score', value: figures.riskScore });
  if (figures.hours !== null && figures.hours !== undefined) impacts.push({ kind: 'hours', value: figures.hours });
  return impacts;
}

/** The hours of a time entry's minutes, to two decimals (`90` is `1.5`). */
export function hoursOfMinutes(minutes: string | number): number {
  return Math.round((Number(minutes) / 60) * 100) / 100;
}
