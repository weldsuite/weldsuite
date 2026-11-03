import { describe, expect, it } from 'vitest';
import { BENEFIT_METRIC_PARAMS } from '@weldsuite/app-api-client/schemas/project-governance';
import {
  DECISION_MESSAGES,
  chooseOption,
  decideInputError,
  decideStateError,
  decisionApprovalRows,
  decisionCode,
  decisionCreateError,
  decisionEditLockedError,
  decisionResolution,
  decisionSequence,
  needsRerouting,
  normalizeOptions,
  optionsAfterDecide,
  supersedeSourceError,
  supersedeTargetError,
} from './decisions';
import {
  DELIVERABLE_MESSAGES,
  acceptError,
  acceptedEditError,
  applyCriteria,
  criteriaCounts,
  deliverableCode,
  deliverableDatesError,
  deliverableResolution,
  deliverableSequence,
  rejectError,
  signoffApprovalRows,
  signoffIsOpen,
} from './deliverables';
import {
  benefitClosedAtFor,
  benefitCode,
  benefitProgress,
  benefitSequence,
  benefitTargetProgress,
  goalCardId,
  parseGoalTargets,
  taskProgressPct,
} from './benefits';
import {
  isFuturePeriod,
  metricIsMeasured,
  metricParamsError,
  monthRange,
  nextMonthStart,
  periodOf,
  previousPeriod,
} from './benefit-metrics';
import { SCOPE_MESSAGES, normalizeOutOfScope, outOfScopeLinkError, presentScope, scopeLinkKey } from './scope';

describe('decision rules', () => {
  const options = normalizeOptions([{ title: 'A' }, { title: 'B', note: 'cheaper', chosen: true }, { title: 'C' }]);

  it('numbers a project decisions DEC-n under dec:<projectId>', () => {
    expect(decisionSequence('prj_1')).toEqual({ scope: 'dec:prj_1', prefix: 'DEC-' });
    expect(decisionCode(7)).toBe('DEC-7');
  });

  it('stores every option field and chooses exactly one', () => {
    expect(options).toEqual([
      { title: 'A', note: null, chosen: false },
      { title: 'B', note: 'cheaper', chosen: true },
      { title: 'C', note: null, chosen: false },
    ]);
    expect(chooseOption(options, 2).map((option) => option.chosen)).toEqual([false, false, true]);
    expect(optionsAfterDecide(options, undefined)).toEqual(options);
    expect(optionsAfterDecide(options, 0).map((option) => option.chosen)).toEqual([true, false, false]);
  });

  it('keeps the fields of a new decision to its status', () => {
    const base = { options: [], deciderId: null, decisionDueAt: null, decidedBy: null, decidedAt: null };
    expect(decisionCreateError({ ...base, status: 'proposed', deciderId: 'u1' })).toBeNull();
    expect(decisionCreateError({ ...base, status: 'proposed', decidedBy: 'u1' })).toBe(DECISION_MESSAGES.decidedOnly);
    expect(decisionCreateError({ ...base, status: 'decided', deciderId: 'u1' })).toBe(DECISION_MESSAGES.proposedOnly);
    expect(decisionCreateError({ ...base, status: 'decided', decisionDueAt: '2026-12-01T00:00:00Z' })).toBe(
      DECISION_MESSAGES.proposedOnly,
    );
    expect(decisionCreateError({ ...base, status: 'decided', options: normalizeOptions([{ title: 'A' }]) })).toBe(
      DECISION_MESSAGES.chooseTaken,
    );
    expect(decisionCreateError({ ...base, status: 'decided', options })).toBeNull();
    expect(
      decisionCreateError({ ...base, status: 'proposed', options: normalizeOptions([{ title: 'A', chosen: true }, { title: 'B', chosen: true }]) }),
    ).toBe(DECISION_MESSAGES.oneChosen);
  });

  it('locks a decided decision to title, context and consequences', () => {
    expect(decisionEditLockedError('proposed', { options: [] })).toBeNull();
    expect(decisionEditLockedError('decided', { options: [] })).toBe(DECISION_MESSAGES.decidedEdit);
    expect(decisionEditLockedError('superseded', { deciderId: 'u1' })).toBe(DECISION_MESSAGES.decidedEdit);
    expect(decisionEditLockedError('decided', {})).toBeNull();
  });

  it('asks again when the decider or the date changed, or the proposal was declined', () => {
    const due = new Date('2026-12-01T00:00:00.000Z');
    const same = { existingDeciderId: 'u1', nextDeciderId: 'u1', existingDueAt: due, nextDueAt: new Date(due), approvals: [] };
    expect(needsRerouting(same)).toBe(false);
    expect(needsRerouting({ ...same, nextDeciderId: 'u2' })).toBe(true);
    expect(needsRerouting({ ...same, nextDueAt: null })).toBe(true);
    expect(needsRerouting({ ...same, approvals: [{ decision: 'rejected' }] })).toBe(true);
    expect(needsRerouting({ ...same, approvals: [{ decision: 'pending' }] })).toBe(false);
  });

  it('decides only a proposed decision, and names the option taken', () => {
    expect(decideStateError('proposed')).toBeNull();
    expect(decideStateError('decided')).toBe(DECISION_MESSAGES.alreadyDecided);
    expect(decideStateError('superseded')).toBe(DECISION_MESSAGES.supersededNotDecidable);
    const open = normalizeOptions([{ title: 'A' }, { title: 'B' }]);
    expect(decideInputError(open, undefined)).toBe(DECISION_MESSAGES.chooseTaken);
    expect(decideInputError(open, 1)).toBeNull();
    expect(decideInputError(open, 2)).toBe(DECISION_MESSAGES.noSuchOption);
    expect(decideInputError(options, undefined)).toBeNull();
    expect(decideInputError([], undefined)).toBeNull();
  });

  it('supersedes a decided decision by another live one of the same project', () => {
    expect(supersedeSourceError('decided')).toBeNull();
    expect(supersedeSourceError('proposed')).toBe(DECISION_MESSAGES.notDecided);
    expect(supersedeSourceError('superseded')).toBe(DECISION_MESSAGES.alreadySuperseded);
    const source = { id: 'dec_1', projectId: 'p1' };
    expect(supersedeTargetError(source, { id: 'dec_2', projectId: 'p1', status: 'decided' })).toBeNull();
    expect(supersedeTargetError(source, { id: 'dec_1', projectId: 'p1', status: 'decided' })).toEqual({
      status: 400,
      message: DECISION_MESSAGES.selfSupersede,
    });
    expect(supersedeTargetError(source, { id: 'dec_2', projectId: 'p2', status: 'decided' })).toEqual({
      status: 400,
      message: DECISION_MESSAGES.otherProject,
    });
    expect(supersedeTargetError(source, { id: 'dec_2', projectId: 'p1', status: 'superseded' })).toEqual({
      status: 409,
      message: DECISION_MESSAGES.supersederSuperseded,
    });
  });

  it('asks the named decider through one approval, and only an approval decides', () => {
    const due = new Date('2026-12-01T00:00:00.000Z');
    expect(decisionApprovalRows('u1', due)).toEqual([
      { approverId: 'u1', roleLabel: 'Decider', step: 1, rule: { code: 'decision', params: { rule: 'named_decider' } }, dueAt: due },
    ]);
    const now = new Date('2026-11-03T10:00:00.000Z');
    expect(decisionResolution('approved', 'u2', 'u1', now)).toEqual({ status: 'decided', decidedBy: 'u2', decidedAt: now });
    expect(decisionResolution('approved', null, 'u1', now)).toEqual({ status: 'decided', decidedBy: 'u1', decidedAt: now });
    expect(decisionResolution('rejected', 'u1', 'u1', now)).toBeNull();
  });
});

describe('deliverable rules', () => {
  const now = new Date('2026-11-03T10:00:00.000Z');

  it('numbers deliverables Dn under del:<projectId>', () => {
    expect(deliverableSequence('prj_1')).toEqual({ scope: 'del:prj_1', prefix: 'D' });
    expect(deliverableCode(3)).toBe('D3');
  });

  it('stamps metAt when a criterion turns met and keeps it while it stays met', () => {
    const first = applyCriteria([], [{ text: 'Login works', met: true }, { text: 'Reset works' }], now);
    expect(first).toEqual([
      { text: 'Login works', met: true, metAt: now.toISOString() },
      { text: 'Reset works', met: false, metAt: null },
    ]);
    const later = new Date('2026-11-04T10:00:00.000Z');
    const second = applyCriteria(first, [{ text: 'Login works', met: true }, { text: 'Reset works', met: true }], later);
    expect(second.map((criterion) => criterion.metAt)).toEqual([now.toISOString(), later.toISOString()]);
    // Changing the text starts over; un-meeting clears.
    const third = applyCriteria(second, [{ text: 'Login works well', met: true }, { text: 'Reset works' }], later);
    expect(third.map((criterion) => criterion.metAt)).toEqual([later.toISOString(), null]);
    expect(criteriaCounts(second)).toEqual({ met: 2, total: 2 });
  });

  it('wants the end after the start', () => {
    const start = new Date('2026-11-01T00:00:00.000Z');
    expect(deliverableDatesError(start, new Date('2026-11-01T00:00:00.000Z'))).toBeNull();
    expect(deliverableDatesError(start, new Date('2026-10-31T00:00:00.000Z'))).toBe(DELIVERABLE_MESSAGES.datesOrder);
    expect(deliverableDatesError(null, new Date('2026-10-31T00:00:00.000Z'))).toBeNull();
  });

  it('accepts once every criterion is met, and locks an accepted deliverable', () => {
    const met = { text: 'a', met: true, metAt: now.toISOString() };
    const open = { text: 'b', met: false, metAt: null };
    expect(acceptError({ status: 'in_progress', acceptanceCriteria: [met] })).toBeNull();
    expect(acceptError({ status: 'in_progress', acceptanceCriteria: [] })).toBeNull();
    expect(acceptError({ status: 'in_progress', acceptanceCriteria: [met, open] })).toBe(DELIVERABLE_MESSAGES.criteriaOpen);
    expect(acceptError({ status: 'accepted', acceptanceCriteria: [met] })).toBe(DELIVERABLE_MESSAGES.alreadyAccepted);
    expect(acceptedEditError('accepted', ['position', 'clientVisible'])).toBeNull();
    expect(acceptedEditError('accepted', ['title'])).toBe(DELIVERABLE_MESSAGES.acceptedLocked);
    expect(acceptedEditError('in_progress', ['title'])).toBeNull();
    expect(rejectError('accepted')).toBe(DELIVERABLE_MESSAGES.notRejectable);
    expect(rejectError('in_progress')).toBeNull();
  });

  it('signs off by the sponsor first and then the client contact', () => {
    expect(signoffApprovalRows('u_sponsor', undefined, null)).toEqual([
      { approverKind: 'member', approverId: 'u_sponsor', roleLabel: 'Sponsor', step: 1, rule: { code: 'deliverable_sponsor' }, dueAt: null },
    ]);
    const rows = signoffApprovalRows('u_sponsor', 'con_1', now);
    expect(rows.map((row) => [row.approverKind, row.approverId, row.step, row.rule.code])).toEqual([
      ['member', 'u_sponsor', 1, 'deliverable_sponsor'],
      ['contact', 'con_1', 2, 'deliverable_client'],
    ]);
    expect(signoffIsOpen([{ decision: 'approved' }, { decision: 'pending' }])).toBe(true);
    expect(signoffIsOpen([{ decision: 'approved' }, { decision: 'rejected' }])).toBe(false);
  });

  it('accepts by the one who answered, else the last approver; a rejection rejects', () => {
    const rows = [
      { decidedBy: 'u_sponsor', decision: 'approved', step: 1 },
      { decidedBy: 'con_1', decision: 'approved', step: 2 },
    ];
    expect(deliverableResolution('approved', 'con_1', rows, now)).toEqual({ status: 'accepted', acceptedBy: 'con_1', acceptedAt: now });
    expect(deliverableResolution('approved', null, rows, now)).toEqual({ status: 'accepted', acceptedBy: 'con_1', acceptedAt: now });
    expect(deliverableResolution('rejected', 'u_sponsor', rows, now)).toEqual({ status: 'rejected' });
  });
});

describe('scope rules', () => {
  it('stores an out-of-scope item with every field, and wants a link whole', () => {
    expect(normalizeOutOfScope([{ text: 'Reporting', reason: 'Release 2', linkType: 'decision', linkId: 'dec_1' }, { text: 'Mobile app' }])).toEqual([
      { text: 'Reporting', reason: 'Release 2', linkType: 'decision', linkId: 'dec_1' },
      { text: 'Mobile app', reason: null, linkType: null, linkId: null },
    ]);
    expect(outOfScopeLinkError([{ text: 'x', linkType: 'decision' }])).toBe(SCOPE_MESSAGES.linkPair);
    expect(outOfScopeLinkError([{ text: 'x', linkId: 'dec_1' }])).toBe(SCOPE_MESSAGES.linkPair);
    expect(outOfScopeLinkError([{ text: 'x', linkType: 'decision', linkId: 'dec_1' }, { text: 'y' }])).toBeNull();
    expect(scopeLinkKey({ linkType: 'project', linkId: 'prj_2' })).toBe('project:prj_2');
    expect(scopeLinkKey({ linkType: null, linkId: null })).toBeNull();
  });

  it('answers an empty scope before the first save', () => {
    expect(presentScope('prj_1', null, new Map())).toEqual({
      id: null,
      projectId: 'prj_1',
      statement: null,
      inScope: [],
      outOfScope: [],
      createdBy: null,
      updatedBy: null,
      createdAt: null,
      updatedAt: null,
    });
  });
});

describe('benefit rules', () => {
  it('numbers benefits B-n under ben:<projectId>', () => {
    expect(benefitSequence('prj_1')).toEqual({ scope: 'ben:prj_1', prefix: 'B-' });
    expect(benefitCode(3)).toBe('B-3');
  });

  it('stamps closedAt on realised and closed, and clears it when open again', () => {
    const now = new Date('2026-11-03T10:00:00.000Z');
    const earlier = new Date('2026-10-01T10:00:00.000Z');
    expect(benefitClosedAtFor('realised', null, now)).toEqual(now);
    expect(benefitClosedAtFor('closed', earlier, now)).toEqual(earlier);
    expect(benefitClosedAtFor('measuring', earlier, now)).toBeNull();
    expect(benefitClosedAtFor('at_risk', null, now)).toBeNull();
  });

  it('measures progress from the baseline toward the target, clamped to 0 to 100', () => {
    expect(benefitProgress('1150', '400', '1090')).toBe(8);
    expect(benefitProgress('35', '70', '36')).toBe(3);
    expect(benefitProgress('35', '70', '70')).toBe(100);
    expect(benefitProgress('35', '70', '90')).toBe(100);
    expect(benefitProgress('35', '70', '20')).toBe(0);
    expect(benefitProgress('38000.0000', '0.0000', '38000.0000')).toBe(0);
    expect(benefitProgress(null, '70', '36')).toBeNull();
    expect(benefitProgress('35', null, '36')).toBeNull();
    expect(benefitProgress('35', '70', undefined)).toBeNull();
    expect(benefitProgress('50', '50', '50')).toBe(100);
    expect(benefitProgress('50', '50', '51')).toBeNull();
  });

  it('turns done tasks into a whole percentage, null without tasks', () => {
    expect(taskProgressPct(26, 46)).toBe(57);
    expect(taskProgressPct(0, 0)).toBeNull();
  });

  it('reads goal targets leniently and keeps their position', () => {
    const card = {
      id: 'goal_1',
      targets: [
        { benefitId: 'ben_1' },
        { nonsense: true },
        { label: 'Checkout tasks', taskFilter: { deliverableId: 'del_4' } },
        { label: 'No filter', taskFilter: {} },
      ],
    };
    expect(goalCardId(card)).toBe('goal_1');
    expect(goalCardId({})).toBeNull();
    expect(parseGoalTargets(card)).toEqual([
      { index: 0, target: { benefitId: 'ben_1' } },
      { index: 2, target: { label: 'Checkout tasks', taskFilter: { deliverableId: 'del_4' } } },
    ]);
    expect(parseGoalTargets({ targets: 'x' })).toEqual([]);
    expect(parseGoalTargets(null)).toEqual([]);
  });

  it('shows a target whose benefit is gone with no progress', () => {
    const gone = benefitTargetProgress(1, 'ben_x', null);
    expect(gone).toMatchObject({ index: 1, kind: 'benefit', benefitId: 'ben_x', progressPct: null, label: '' });
  });
});

describe('metric catalogue', () => {
  it('knows which metrics are measured and checks their parameters', () => {
    expect(metricIsMeasured('manual')).toBe(false);
    expect(metricIsMeasured('desk_tickets_by_tag')).toBe(true);
    expect(metricIsMeasured('nope')).toBe(false);
    expect(Object.keys(BENEFIT_METRIC_PARAMS)).toContain('books_supplier_cost');
    expect(metricParamsError('desk_tickets_by_tag', { tag: '  order status ' })).toEqual({ ok: true, params: { tag: 'order status' } });
    expect(metricParamsError('desk_tickets_by_tag', {})).toEqual({ ok: false, message: "Invalid parameters for the 'desk_tickets_by_tag' metric" });
    expect(metricParamsError('desk_tickets_by_tag', { tag: 'x', extra: 1 })).toMatchObject({ ok: false });
    expect(metricParamsError('books_supplier_cost', { supplierId: 'con_1' })).toEqual({ ok: true, params: { supplierId: 'con_1' } });
    expect(metricParamsError('commerce_repeat_online_share', { sources: [] })).toMatchObject({ ok: false });
    expect(metricParamsError('manual', {})).toEqual({ ok: true, params: {} });
    expect(metricParamsError('manual', { a: 1 })).toMatchObject({ ok: false });
    expect(metricParamsError('mystery', {})).toEqual({ ok: false, message: "Unknown metric 'mystery'" });
  });

  it('works in whole UTC months', () => {
    const now = new Date('2026-11-03T03:30:00.000Z');
    expect(periodOf(now)).toBe('2026-11');
    expect(previousPeriod(now)).toBe('2026-10');
    expect(previousPeriod(new Date('2027-01-01T00:00:00.000Z'))).toBe('2026-12');
    expect(nextMonthStart(now).toISOString()).toBe('2026-12-01T00:00:00.000Z');
    expect(nextMonthStart(new Date('2026-12-31T23:59:59.000Z')).toISOString()).toBe('2027-01-01T00:00:00.000Z');
    const range = monthRange('2026-02');
    expect([range.start.toISOString(), range.end.toISOString(), range.days]).toEqual([
      '2026-02-01T00:00:00.000Z',
      '2026-03-01T00:00:00.000Z',
      28,
    ]);
    expect(isFuturePeriod('2026-12', now)).toBe(true);
    expect(isFuturePeriod('2026-11', now)).toBe(false);
  });
});
