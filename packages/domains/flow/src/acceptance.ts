/**
 * Accepting a risk (design: weldflow-delivery-and-portfolio.md, "Answer a
 * review"; ADR FLOW-016): a risk whose strategy is `accept` and whose score is
 * 9 or more needs the sponsor's yes. The approval subject is `risk_acceptance`
 * (`flow_approvals`, rule `risk_acceptance`); when the sponsor accepts, the risk
 * moves to `monitoring` and the acceptance is noted in an assessment row.
 *
 * Pure functions, no database. The Rust flow-domain mirrors them in
 * `acceptance.rs`. Every message returned here is sent to the client as it is.
 */

import type { ApprovalRow, ApprovalRowInput } from './approvals';
import { riskBand, riskScore } from './risk';

/** The lowest score that needs the sponsor: the top of the medium band. */
export const RISK_ACCEPTANCE_SCORE = 9;

/** How long the sponsor gets, in days from the request. */
export const ACCEPTANCE_DUE_DAYS = 5;

export const ACCEPTANCE_MESSAGES = {
  onlyRisks: 'Only a risk can be accepted',
  needsAcceptStrategy: 'Set the strategy to accept before asking for acceptance',
  belowThreshold: 'Only a risk scoring 9 or more needs the sponsor to accept it',
  closed: 'This item is already closed',
  alreadyRequested: 'Acceptance has already been requested for this risk',
  noSponsor: 'This project has no sponsor or project manager to accept the risk',
} as const;

/** A refusal: its HTTP status (400 for the request, 409 for the state of the item) and message. */
export interface AcceptanceRefusal {
  status: 400 | 409;
  message: string;
}

/**
 * The refusal for asking the sponsor to accept this item, or null. The order is
 * fixed: it is a risk, its strategy is accept, it scores enough, it is still open.
 */
export function acceptanceError(item: {
  kind: string;
  strategy: string | null;
  probability: number | null;
  impact: number | null;
  closedAt: Date | null;
}): AcceptanceRefusal | null {
  if (item.kind !== 'risk') return { status: 400, message: ACCEPTANCE_MESSAGES.onlyRisks };
  if (item.strategy !== 'accept') return { status: 400, message: ACCEPTANCE_MESSAGES.needsAcceptStrategy };
  const score = item.probability !== null && item.impact !== null ? riskScore(item.probability, item.impact) : 0;
  if (score < RISK_ACCEPTANCE_SCORE) return { status: 400, message: ACCEPTANCE_MESSAGES.belowThreshold };
  if (item.closedAt !== null) return { status: 409, message: ACCEPTANCE_MESSAGES.closed };
  return null;
}

/** The approval row a request creates: the sponsor, with the score, the band and the requester's reason. */
export function acceptanceApproverRow(
  sponsorId: string,
  item: { probability: number; impact: number },
  note: string | null,
  dueAt: Date,
): ApprovalRowInput {
  const score = riskScore(item.probability, item.impact);
  return {
    approverId: sponsorId,
    roleLabel: 'Sponsor',
    rule: {
      code: 'risk_acceptance',
      params: { score, band: riskBand(score), strategy: 'accept', ...(note ? { note } : {}) },
    },
    dueAt,
  };
}

/**
 * The note an accepted risk's assessment row carries: that the sponsor accepted
 * it and, when the sponsor wrote one, their words (conditions come with an
 * `approved_with_conditions`).
 */
export function acceptanceAssessmentNote(rows: readonly ApprovalRow[]): string {
  const answer = rows.find((row) => row.decision === 'approved' || row.decision === 'approved_with_conditions');
  const text = answer?.note?.trim();
  const conditional = answer?.decision === 'approved_with_conditions';
  const words = text ? `: ${text}` : '';
  return `Accepted by the sponsor${conditional ? ' with conditions' : ''}${words}`;
}
