import { describe, expect, it } from 'vitest';
import {
  APPROVAL_DECISIONS,
  APPROVAL_MESSAGES,
  APPROVAL_RULE_CODES,
  FINAL_DECISIONS,
  NOTE_REQUIRED_DECISIONS,
  OPEN_DECISIONS,
  activeDelegation,
  approvalRequestError,
  compareReviews,
  decisionInputError,
  endOfIsoWeek,
  isFinalDecision,
  isOpenDecision,
  isStepActive,
  planApprovers,
  resolveUnanimous,
  reviewBucket,
  sponsorOf,
  type ApprovalRowInput,
} from './approvals';

const row = (decision: string, step = 1, deletedAt: Date | null = null) =>
  ({ decision, step, deletedAt }) as Parameters<typeof resolveUnanimous>[0][number];

describe('vocabulary', () => {
  it('splits the answers into final and open ones, with nothing left over', () => {
    expect([...FINAL_DECISIONS, ...OPEN_DECISIONS].sort()).toEqual([...APPROVAL_DECISIONS].sort());
    expect(isFinalDecision('approved')).toBe(true);
    expect(isFinalDecision('approved_with_conditions')).toBe(true);
    expect(isFinalDecision('rejected')).toBe(true);
    expect(isFinalDecision('pending')).toBe(false);
    expect(isFinalDecision('info_requested')).toBe(false);
    expect(isOpenDecision('pending')).toBe(true);
    expect(isOpenDecision('info_requested')).toBe(true);
    expect(isOpenDecision('approved')).toBe(false);
  });

  it('needs a note for a decline and for conditions only', () => {
    expect([...NOTE_REQUIRED_DECISIONS].sort()).toEqual(['approved_with_conditions', 'rejected']);
  });

  it('lists the rule codes the routing functions use', () => {
    expect(APPROVAL_RULE_CODES).toContain('change_board_over_limit');
    expect(new Set(APPROVAL_RULE_CODES).size).toBe(APPROVAL_RULE_CODES.length);
  });
});

describe('decisionInputError', () => {
  it('accepts the four answers', () => {
    expect(decisionInputError({ decision: 'approved' })).toBeNull();
    expect(decisionInputError({ decision: 'info_requested' })).toBeNull();
    expect(decisionInputError({ decision: 'rejected', note: 'Too expensive' })).toBeNull();
    expect(decisionInputError({ decision: 'approved_with_conditions', note: 'After the audit' })).toBeNull();
  });

  it('refuses pending and unknown answers', () => {
    expect(decisionInputError({ decision: 'pending' })).toBe(APPROVAL_MESSAGES.invalidDecision);
    expect(decisionInputError({ decision: 'maybe' })).toBe(APPROVAL_MESSAGES.invalidDecision);
  });

  it('needs a note to decline or to set conditions, and a blank one does not count', () => {
    expect(decisionInputError({ decision: 'rejected' })).toBe(APPROVAL_MESSAGES.noteRequired);
    expect(decisionInputError({ decision: 'rejected', note: '   ' })).toBe(APPROVAL_MESSAGES.noteRequired);
    expect(decisionInputError({ decision: 'approved_with_conditions', note: null })).toBe(
      APPROVAL_MESSAGES.noteRequired,
    );
  });
});

describe('resolveUnanimous', () => {
  it('waits while there are no rows or an answer is missing', () => {
    expect(resolveUnanimous([])).toBe('pending');
    expect(resolveUnanimous([row('pending')])).toBe('pending');
    expect(resolveUnanimous([row('approved'), row('pending')])).toBe('pending');
    expect(resolveUnanimous([row('approved'), row('info_requested')])).toBe('pending');
  });

  it('approves when every row approved, with or without conditions', () => {
    expect(resolveUnanimous([row('approved')])).toBe('approved');
    expect(resolveUnanimous([row('approved'), row('approved_with_conditions')])).toBe('approved');
  });

  it('rejects on one rejection, even while others are still open', () => {
    expect(resolveUnanimous([row('approved'), row('rejected')])).toBe('rejected');
    expect(resolveUnanimous([row('pending'), row('rejected'), row('pending')])).toBe('rejected');
  });

  it('ignores deleted rows', () => {
    const gone = new Date('2026-11-01T00:00:00Z');
    expect(resolveUnanimous([row('approved'), row('rejected', 1, gone)])).toBe('approved');
    expect(resolveUnanimous([row('pending', 1, gone)])).toBe('pending');
  });
});

describe('isStepActive', () => {
  it('lets rows of the first step, and of the same step, be answered in parallel', () => {
    const rows = [row('pending', 1), row('pending', 1), row('pending', 2)];
    expect(isStepActive(rows[0]!, rows)).toBe(true);
    expect(isStepActive(rows[1]!, rows)).toBe(true);
  });

  it('holds a later step until every earlier row is approved', () => {
    const waiting = [row('approved', 1), row('pending', 1), row('pending', 2)];
    expect(isStepActive(waiting[2]!, waiting)).toBe(false);
    const open = [row('approved', 1), row('approved_with_conditions', 1), row('pending', 2)];
    expect(isStepActive(open[2]!, open)).toBe(true);
  });

  it('keeps a later step closed behind a rejection or a request for information', () => {
    expect(isStepActive(row('pending', 2), [row('rejected', 1), row('pending', 2)])).toBe(false);
    expect(isStepActive(row('pending', 2), [row('info_requested', 1), row('pending', 2)])).toBe(false);
  });

  it('does not wait for a deleted row', () => {
    const gone = new Date('2026-11-01T00:00:00Z');
    expect(isStepActive(row('pending', 2), [row('pending', 1, gone), row('pending', 2)])).toBe(true);
  });
});

describe('activeDelegation', () => {
  const at = (iso: string) => new Date(iso);
  const delegation = (id: string, memberId: string, from: string, to: string, deletedAt: Date | null = null) => ({
    id,
    memberId,
    delegateId: `${id}-delegate`,
    startsAt: at(from),
    endsAt: at(to),
    deletedAt,
  });

  it('is active from its start (inclusive) until its end (exclusive)', () => {
    const list = [delegation('a', 'u1', '2026-11-02T00:00:00Z', '2026-11-09T00:00:00Z')];
    expect(activeDelegation(list, 'u1', at('2026-11-01T23:59:59Z'))).toBeNull();
    expect(activeDelegation(list, 'u1', at('2026-11-02T00:00:00Z'))?.id).toBe('a');
    expect(activeDelegation(list, 'u1', at('2026-11-08T23:59:59Z'))?.id).toBe('a');
    expect(activeDelegation(list, 'u1', at('2026-11-09T00:00:00Z'))).toBeNull();
  });

  it('only counts the member own delegations and not deleted ones', () => {
    const list = [
      delegation('a', 'u2', '2026-11-02T00:00:00Z', '2026-11-09T00:00:00Z'),
      delegation('b', 'u1', '2026-11-02T00:00:00Z', '2026-11-09T00:00:00Z', at('2026-11-03T00:00:00Z')),
    ];
    expect(activeDelegation(list, 'u1', at('2026-11-04T00:00:00Z'))).toBeNull();
  });

  it('picks the one that started last, then the lowest id, when several overlap', () => {
    const list = [
      delegation('b', 'u1', '2026-11-02T00:00:00Z', '2026-11-20T00:00:00Z'),
      delegation('c', 'u1', '2026-11-03T00:00:00Z', '2026-11-20T00:00:00Z'),
      delegation('a', 'u1', '2026-11-03T00:00:00Z', '2026-11-20T00:00:00Z'),
    ];
    expect(activeDelegation(list, 'u1', at('2026-11-05T00:00:00Z'))?.id).toBe('a');
  });
});

describe('review buckets', () => {
  // Wednesday 4 November 2026.
  const now = new Date('2026-11-04T10:00:00Z');

  it('ends the week on Sunday night, UTC', () => {
    expect(endOfIsoWeek(now).toISOString()).toBe('2026-11-08T23:59:59.999Z');
    expect(endOfIsoWeek(new Date('2026-11-08T05:00:00Z')).toISOString()).toBe('2026-11-08T23:59:59.999Z');
    expect(endOfIsoWeek(new Date('2026-11-09T00:00:00Z')).toISOString()).toBe('2026-11-15T23:59:59.999Z');
  });

  it('groups a due date as overdue, this week or later', () => {
    expect(reviewBucket(new Date('2026-11-03T23:00:00Z'), now)).toBe('overdue');
    expect(reviewBucket(new Date('2026-11-04T10:00:00Z'), now)).toBe('this_week');
    expect(reviewBucket(new Date('2026-11-08T23:59:59.999Z'), now)).toBe('this_week');
    expect(reviewBucket(new Date('2026-11-09T00:00:00Z'), now)).toBe('later');
  });

  it('puts a review with no due date in later', () => {
    expect(reviewBucket(null, now)).toBe('later');
    expect(reviewBucket(undefined, now)).toBe('later');
  });

  it('orders by due date (none last), then by request time, then id', () => {
    const base = new Date('2026-11-01T00:00:00Z');
    const items = [
      { id: 'd', dueAt: null, createdAt: base },
      { id: 'c', dueAt: new Date('2026-11-06T00:00:00Z'), createdAt: new Date('2026-11-02T00:00:00Z') },
      { id: 'b', dueAt: new Date('2026-11-06T00:00:00Z'), createdAt: base },
      { id: 'a', dueAt: new Date('2026-11-06T00:00:00Z'), createdAt: base },
      { id: 'e', dueAt: new Date('2026-11-05T00:00:00Z'), createdAt: new Date('2026-11-03T00:00:00Z') },
    ];
    expect([...items].sort(compareReviews).map((item) => item.id)).toEqual(['e', 'a', 'b', 'c', 'd']);
  });
});

describe('approvalRequestError', () => {
  const ok: ApprovalRowInput = { approverId: 'u1', rule: { code: 'change_manager' } };

  it('accepts a request with a rule per approver', () => {
    expect(approvalRequestError({ subjectType: 'change_request', rows: [ok] })).toBeNull();
    expect(
      approvalRequestError({
        subjectType: 'deliverable',
        rows: [ok, { ...ok, approverKind: 'contact', approverId: 'c1', step: 2 }],
      }),
    ).toBeNull();
  });

  it('refuses an unknown subject, no approvers, a bad approver, step or rule', () => {
    expect(approvalRequestError({ subjectType: 'nope' as never, rows: [ok] })).toBe(APPROVAL_MESSAGES.invalidSubject);
    expect(approvalRequestError({ subjectType: 'gate', rows: [] })).toBe(APPROVAL_MESSAGES.noApprovers);
    expect(approvalRequestError({ subjectType: 'gate', rows: [{ ...ok, approverId: ' ' }] })).toBe(
      APPROVAL_MESSAGES.invalidApprover,
    );
    expect(approvalRequestError({ subjectType: 'gate', rows: [{ ...ok, approverKind: 'bot' as never }] })).toBe(
      APPROVAL_MESSAGES.invalidApprover,
    );
    expect(approvalRequestError({ subjectType: 'gate', rows: [{ ...ok, step: 0 }] })).toBe(APPROVAL_MESSAGES.invalidStep);
    expect(approvalRequestError({ subjectType: 'gate', rows: [{ ...ok, step: 1.5 }] })).toBe(
      APPROVAL_MESSAGES.invalidStep,
    );
    expect(approvalRequestError({ subjectType: 'gate', rows: [{ ...ok, rule: { code: '' } }] })).toBe(
      APPROVAL_MESSAGES.invalidRule,
    );
  });
});

describe('planApprovers', () => {
  const now = new Date('2026-11-04T10:00:00Z');
  const rule = { code: 'change_board_over_limit' };
  const away = {
    id: 'dlg1',
    memberId: 'u1',
    delegateId: 'u9',
    startsAt: new Date('2026-11-01T00:00:00Z'),
    endsAt: new Date('2026-11-10T00:00:00Z'),
  };

  it('keeps the approvers as given, defaulting to a member in step 1', () => {
    const planned = planApprovers([{ approverId: 'u1', rule }, { approverId: 'u2', rule, roleLabel: 'Finance' }], [], now);
    expect(planned.map((p) => [p.approverKind, p.approverId, p.step, p.delegatedFrom, p.roleLabel])).toEqual([
      ['member', 'u1', 1, null, null],
      ['member', 'u2', 1, null, 'Finance'],
    ]);
  });

  it('replaces a member on delegation by the delegate and remembers who delegated', () => {
    const planned = planApprovers([{ approverId: 'u1', rule }], [away], now);
    expect(planned).toHaveLength(1);
    expect(planned[0]).toMatchObject({ approverId: 'u9', delegatedFrom: 'u1' });
  });

  it('does not delegate outside the period, and never delegates a contact', () => {
    expect(planApprovers([{ approverId: 'u1', rule }], [away], new Date('2026-11-10T00:00:00Z'))[0]).toMatchObject({
      approverId: 'u1',
      delegatedFrom: null,
    });
    expect(
      planApprovers([{ approverKind: 'contact', approverId: 'u1', rule }], [away], now)[0],
    ).toMatchObject({ approverKind: 'contact', approverId: 'u1', delegatedFrom: null });
  });

  it('asks a person once, in the lowest step, also when delegation brings them in twice', () => {
    const planned = planApprovers(
      [
        { approverId: 'u2', rule, step: 2 },
        { approverId: 'u9', rule, step: 1 },
        { approverId: 'u1', rule, step: 1 },
        { approverId: 'u2', rule, step: 1 },
      ],
      [away],
      now,
    );
    expect(planned.map((p) => [p.approverId, p.step])).toEqual([
      ['u9', 1],
      ['u2', 1],
    ]);
  });

  it('orders by step and keeps the given order inside a step', () => {
    const planned = planApprovers(
      [
        { approverId: 'c', rule, step: 2 },
        { approverId: 'a', rule, step: 1 },
        { approverId: 'b', rule, step: 1 },
      ],
      [],
      now,
    );
    expect(planned.map((p) => p.approverId)).toEqual(['a', 'b', 'c']);
  });
});

describe('sponsorOf', () => {
  it('uses the sponsor, then the project manager', () => {
    expect(sponsorOf({ sponsorId: 'u5' }, 'u1')).toBe('u5');
    expect(sponsorOf({}, 'u1')).toBe('u1');
    expect(sponsorOf(null, 'u1')).toBe('u1');
    expect(sponsorOf({ sponsorId: null }, null)).toBeNull();
  });
});
