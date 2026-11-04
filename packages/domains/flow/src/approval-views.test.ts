import { describe, expect, it } from 'vitest';
import {
  DELEGATION_MESSAGES,
  approvalEventData,
  delegationInputError,
  hoursOfMinutes,
  presentReviewApprover,
  reviewImpacts,
  summarize,
} from './approval-views';
import type { ApprovalRow } from './approvals';

describe('delegationInputError', () => {
  const now = new Date('2026-11-04T10:00:00Z');
  const base = { memberId: 'u1', delegateId: 'u2', startsAt: new Date('2026-11-03T00:00:00Z'), endsAt: new Date('2026-11-10T00:00:00Z') };

  it('accepts a period in force or still to come', () => {
    expect(delegationInputError(base, now)).toBeNull();
    expect(delegationInputError({ ...base, startsAt: new Date('2026-11-08T00:00:00Z') }, now)).toBeNull();
  });

  it('refuses yourself, a backwards period and one that is over, in that order', () => {
    expect(delegationInputError({ ...base, delegateId: 'u1', endsAt: base.startsAt }, now)).toBe(DELEGATION_MESSAGES.self);
    expect(delegationInputError({ ...base, endsAt: base.startsAt }, now)).toBe(DELEGATION_MESSAGES.period);
    expect(delegationInputError({ ...base, startsAt: new Date('2026-11-01T00:00:00Z'), endsAt: new Date('2026-11-02T00:00:00Z') }, now)).toBe(
      DELEGATION_MESSAGES.ended,
    );
  });
});

describe('presenting', () => {
  const row = {
    id: 'apr_1',
    projectId: 'p1',
    subjectType: 'change_request',
    subjectId: 'pcr_1',
    approverKind: 'member',
    approverId: 'u1',
    roleLabel: 'Finance',
    step: 2,
    rule: { code: 'change_manager' },
    decision: 'approved',
    note: 'Fine',
    dueAt: new Date('2026-11-06T00:00:00Z'),
    decidedAt: new Date('2026-11-05T00:00:00Z'),
    delegatedFrom: null,
  } as ApprovalRow;

  it('shows an approver with their answer and keeps notes out of events', () => {
    expect(presentReviewApprover(row)).toEqual({
      approvalId: 'apr_1',
      approverKind: 'member',
      approverId: 'u1',
      roleLabel: 'Finance',
      step: 2,
      decision: 'approved',
      note: 'Fine',
      decidedAt: '2026-11-05T00:00:00.000Z',
      delegatedFrom: null,
    });
    expect(approvalEventData(row)).not.toHaveProperty('note');
    expect(approvalEventData(row)).toMatchObject({ id: 'apr_1', decision: 'approved', dueAt: '2026-11-06T00:00:00.000Z' });
  });

  it('lists only the figures a subject has, and converts minutes to hours', () => {
    expect(reviewImpacts({})).toEqual([]);
    expect(reviewImpacts({ cost: '8000.00', currency: 'EUR', scheduleDays: 0, riskScore: 16, hours: 1.5 })).toEqual([
      { kind: 'cost', value: '8000.00', currency: 'EUR' },
      { kind: 'schedule_days', value: 0 },
      { kind: 'risk_score', value: 16 },
      { kind: 'hours', value: 1.5 },
    ]);
    expect(hoursOfMinutes('90.00')).toBe(1.5);
    expect(hoursOfMinutes(100)).toBe(1.67);
  });

  it('cuts a long text at 280 characters and drops a blank one', () => {
    expect(summarize('  one   two\nthree ')).toBe('one two three');
    expect(summarize('   ')).toBeNull();
    expect(summarize(null)).toBeNull();
    expect(summarize('x'.repeat(400))).toHaveLength(280);
  });
});
