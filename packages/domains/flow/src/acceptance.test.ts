import { describe, expect, it } from 'vitest';
import {
  ACCEPTANCE_MESSAGES,
  RISK_ACCEPTANCE_SCORE,
  acceptanceApproverRow,
  acceptanceAssessmentNote,
  acceptanceError,
} from './acceptance';
import type { ApprovalRow } from './approvals';

const risk = (overrides: Partial<Parameters<typeof acceptanceError>[0]> = {}) => ({
  kind: 'risk',
  strategy: 'accept',
  probability: 3,
  impact: 3,
  closedAt: null,
  ...overrides,
});

describe('acceptanceError', () => {
  it('lets a risk that accepts and scores 9 or more go to the sponsor', () => {
    expect(RISK_ACCEPTANCE_SCORE).toBe(9);
    expect(acceptanceError(risk())).toBeNull();
    expect(acceptanceError(risk({ probability: 5, impact: 5 }))).toBeNull();
  });

  it('checks in a fixed order: the kind, the strategy, the score, then whether it is open', () => {
    expect(acceptanceError(risk({ kind: 'issue', strategy: null }))).toEqual({ status: 400, message: ACCEPTANCE_MESSAGES.onlyRisks });
    expect(acceptanceError(risk({ strategy: 'mitigate', probability: 1, impact: 1 }))).toEqual({
      status: 400,
      message: ACCEPTANCE_MESSAGES.needsAcceptStrategy,
    });
    expect(acceptanceError(risk({ probability: 2, impact: 4, closedAt: new Date() }))).toEqual({
      status: 400,
      message: ACCEPTANCE_MESSAGES.belowThreshold,
    });
    expect(acceptanceError(risk({ closedAt: new Date() }))).toEqual({ status: 409, message: ACCEPTANCE_MESSAGES.closed });
  });
});

describe('acceptanceApproverRow and the note', () => {
  it('asks the sponsor with the score, the band and the reason', () => {
    const due = new Date('2026-11-09T00:00:00Z');
    expect(acceptanceApproverRow('u1', { probability: 4, impact: 4 }, 'Cheaper', due)).toEqual({
      approverId: 'u1',
      roleLabel: 'Sponsor',
      rule: { code: 'risk_acceptance', params: { score: 16, band: 'high', strategy: 'accept', note: 'Cheaper' } },
      dueAt: due,
    });
    expect(acceptanceApproverRow('u1', { probability: 3, impact: 3 }, null, due).rule.params).toEqual({ score: 9, band: 'medium', strategy: 'accept' });
  });

  it('notes the sponsor and their words', () => {
    const row = (decision: ApprovalRow['decision'], note: string | null) => ({ decision, note }) as ApprovalRow;
    expect(acceptanceAssessmentNote([row('approved', null)])).toBe('Accepted by the sponsor');
    expect(acceptanceAssessmentNote([row('approved', ' Fine ')])).toBe('Accepted by the sponsor: Fine');
    expect(acceptanceAssessmentNote([row('approved_with_conditions', 'Review in March')])).toBe(
      'Accepted by the sponsor with conditions: Review in March',
    );
  });
});
