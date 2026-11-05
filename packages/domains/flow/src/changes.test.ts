import { describe, expect, it } from 'vitest';
import {
  CHANGE_MESSAGES,
  boardOutsiders,
  changeApproverRows,
  changeCode,
  changeImpactError,
  changeSequence,
  computeEffects,
  consequenceLines,
  impactChanged,
  decisionSequence,
  deliverableCode,
  deliverableSequence,
  effectiveChangeControl,
  isOpenChange,
  routeChange,
  touchesImpact,
  unknownDeliverableMessage,
  unknownMilestoneMessage,
} from './changes';
import type { PlanState } from './baselines';

describe('numbering', () => {
  it('keeps one counter per register and project', () => {
    expect(changeSequence('prj1')).toEqual({ scope: 'cr:prj1', prefix: 'CR-' });
    expect(decisionSequence('prj1')).toEqual({ scope: 'dec:prj1', prefix: 'DEC-' });
    expect(deliverableSequence('prj1')).toEqual({ scope: 'del:prj1', prefix: 'D' });
    expect(changeCode(8)).toBe('CR-8');
    expect(deliverableCode(3)).toBe('D3');
  });
});

describe('effectiveChangeControl', () => {
  it('defaults to 5.000, 5 working days and an empty board', () => {
    expect(effectiveChangeControl(null)).toEqual({ costLimit: 5000, scheduleLimitDays: 5, boardMemberIds: [] });
    expect(effectiveChangeControl({})).toEqual({ costLimit: 5000, scheduleLimitDays: 5, boardMemberIds: [] });
  });

  it('takes the project own limits and board, without duplicates', () => {
    expect(
      effectiveChangeControl({ changeControl: { costLimit: 1000, scheduleLimitDays: 2, boardMemberIds: ['a', 'b', 'a'] } }),
    ).toEqual({ costLimit: 1000, scheduleLimitDays: 2, boardMemberIds: ['a', 'b'] });
  });
});

describe('routeChange', () => {
  const settings = { changeControl: { costLimit: 5000, scheduleLimitDays: 5, boardMemberIds: ['b1', 'b2'] } };

  it('sends a change under both limits to the project manager', () => {
    const routing = routeChange({ costDelta: '4999.99', scheduleDeltaDays: 4, settings, projectManagerId: 'pm' });
    expect(routing).toMatchObject({ route: 'manager', overLimit: false, noBoard: false, approverIds: ['pm'], ruleCode: 'change_manager' });
  });

  it('sends a change at or over a limit to the whole board', () => {
    const cost = routeChange({ costDelta: 5000, scheduleDeltaDays: null, settings, projectManagerId: 'pm' });
    expect(cost).toMatchObject({ route: 'board', overLimit: true, approverIds: ['b1', 'b2'], ruleCode: 'change_board_over_limit' });
    const days = routeChange({ costDelta: null, scheduleDeltaDays: 5, settings, projectManagerId: 'pm' });
    expect(days.route).toBe('board');
    expect(days.params).toEqual({
      costDelta: null,
      costLimit: 5000,
      scheduleDeltaDays: 5,
      scheduleLimitDays: 5,
      overLimit: true,
      noBoard: false,
    });
  });

  it('keeps a change that saves money or time with the project manager', () => {
    const routing = routeChange({ costDelta: -90_000, scheduleDeltaDays: -30, settings, projectManagerId: 'pm' });
    expect(routing).toMatchObject({ route: 'manager', overLimit: false });
  });

  it('with no board, sends everything to the manager and flags it', () => {
    const routing = routeChange({ costDelta: 8000, scheduleDeltaDays: 0, settings: {}, projectManagerId: 'pm' });
    expect(routing).toMatchObject({ route: 'manager', overLimit: true, noBoard: true, approverIds: ['pm'], ruleCode: 'change_manager' });
  });

  it('has no approver when the project has no manager and no board applies', () => {
    expect(routeChange({ costDelta: 1, scheduleDeltaDays: 1, settings: {}, projectManagerId: null }).approverIds).toEqual([]);
  });

  it('asks each approver in step 1, with the reason and the due date', () => {
    const routing = routeChange({ costDelta: 8000, scheduleDeltaDays: null, settings, projectManagerId: 'pm' });
    const due = new Date('2026-11-09T00:00:00Z');
    const rows = changeApproverRows(routing, due);
    expect(rows.map((r) => [r.approverId, r.roleLabel, r.rule.code, r.dueAt])).toEqual([
      ['b1', 'Change board', 'change_board_over_limit', due],
      ['b2', 'Change board', 'change_board_over_limit', due],
    ]);
    expect(rows[0]?.rule.params).toMatchObject({ costDelta: 8000, costLimit: 5000 });
  });

  it('lists the board members who are not on the project', () => {
    expect(boardOutsiders(['a', 'b', 'c'], new Set(['a', 'c']))).toEqual(['b']);
  });
});

describe('changeImpactError', () => {
  const known = { milestoneIds: new Set(['m1', 'm2']), deliverableIds: new Set(['d1', 'd2']) };
  const to = '2026-11-20T00:00:00.000Z';

  it('accepts an impact that points at the project own milestones and deliverables', () => {
    expect(
      changeImpactError(
        {
          planChanges: { milestones: [{ milestoneId: 'm1', to }], deliverables: [{ deliverableId: 'd1', plannedEnd: to }] },
          scopeChanges: { add: [{ title: 'Training' }], remove: ['d2'] },
        },
        known,
      ),
    ).toBeNull();
    expect(changeImpactError({}, known)).toBeNull();
  });

  it('refuses ids the project does not have', () => {
    expect(changeImpactError({ planChanges: { milestones: [{ milestoneId: 'x', to }] } }, known)).toBe(unknownMilestoneMessage('x'));
    expect(changeImpactError({ planChanges: { deliverables: [{ deliverableId: 'y' }] } }, known)).toBe(unknownDeliverableMessage('y'));
    expect(changeImpactError({ scopeChanges: { remove: ['z'] } }, known)).toBe(unknownDeliverableMessage('z'));
  });

  it('refuses a double move and a deliverable moved and removed at once', () => {
    expect(
      changeImpactError({ planChanges: { milestones: [{ milestoneId: 'm1', to }, { milestoneId: 'm1', to }] } }, known),
    ).toBe(CHANGE_MESSAGES.twiceMilestone);
    expect(
      changeImpactError({ planChanges: { deliverables: [{ deliverableId: 'd1' }, { deliverableId: 'd1' }] } }, known),
    ).toBe(CHANGE_MESSAGES.twiceDeliverable);
    expect(
      changeImpactError({ planChanges: { deliverables: [{ deliverableId: 'd1' }] }, scopeChanges: { remove: ['d1'] } }, known),
    ).toBe(CHANGE_MESSAGES.movedAndRemoved);
  });

  it('refuses a deliverable that starts after it ends', () => {
    expect(
      changeImpactError(
        { planChanges: { deliverables: [{ deliverableId: 'd1', plannedStart: '2026-12-01T00:00:00.000Z', plannedEnd: to }] } },
        known,
      ),
    ).toBe(CHANGE_MESSAGES.startAfterEnd);
  });
});

describe('touchesImpact and statuses', () => {
  it('tells an impact edit from a text edit', () => {
    expect(touchesImpact({ title: 'x' })).toBe(false);
    expect(touchesImpact({ costDelta: 1 })).toBe(true);
    expect(touchesImpact({ planChanges: null })).toBe(true);
    expect(touchesImpact({ scheduleDeltaDays: undefined })).toBe(false);
  });

  it('knows which statuses are open', () => {
    expect(['draft', 'assessing', 'awaiting_approval'].every(isOpenChange)).toBe(true);
    expect(['approved', 'rejected', 'implemented', 'withdrawn'].some(isOpenChange)).toBe(false);
  });
});

describe('computeEffects', () => {
  const plan: PlanState = {
    goLive: new Date('2026-12-01T00:00:00.000Z'),
    milestones: [{ id: 'm1', name: 'Beta', dueDate: new Date('2026-11-20T00:00:00.000Z') }],
    deliverables: [
      { id: 'd1', number: 1, title: 'App', plannedStart: new Date('2026-11-01T00:00:00.000Z'), plannedEnd: new Date('2026-11-15T00:00:00.000Z') },
      { id: 'd2', number: 2, title: 'Manual', plannedStart: null, plannedEnd: null },
    ],
    budgetedAmount: '12000.00',
    budgetedHours: null,
    budgetCurrency: 'EUR',
    scopeStatement: null,
  };
  const change = {
    costDelta: '8000.00',
    planChanges: {
      goLive: '2026-12-09T00:00:00.000Z',
      milestones: [{ milestoneId: 'm1', to: '2026-11-28T00:00:00.000Z' }],
      deliverables: [{ deliverableId: 'd1', plannedEnd: '2026-11-22T00:00:00.000Z' }],
    },
    scopeChanges: { add: [{ title: 'Training' }], remove: ['d2'] },
  };

  it('computes what the change does to the plan before it is approved', () => {
    const effects = computeEffects(change, plan, false);
    expect(effects.goLive).toEqual({ from: '2026-12-01T00:00:00.000Z', to: '2026-12-09T00:00:00.000Z', deltaDays: 8 });
    expect(effects.milestones).toEqual([{ id: 'm1', name: 'Beta', from: '2026-11-20T00:00:00.000Z', to: '2026-11-28T00:00:00.000Z', deltaDays: 8 }]);
    expect(effects.deliverables.moved).toEqual([
      { id: 'd1', code: 'D1', title: 'App', plannedStart: '2026-11-01T00:00:00.000Z', plannedEnd: '2026-11-22T00:00:00.000Z' },
    ]);
    expect(effects.deliverables.added).toEqual([{ title: 'Training', plannedStart: null, plannedEnd: null }]);
    expect(effects.deliverables.removed).toEqual([{ id: 'd2', code: 'D2', title: 'Manual' }]);
    expect(effects.budget).toEqual({ currency: 'EUR', from: '12000.00', to: '20000.00', delta: '8000.00' });
  });

  it('reads an applied change against the live plan, which already holds the new values', () => {
    const effects = computeEffects(change, plan, true);
    expect(effects.goLive?.from).toBeNull();
    expect(effects.milestones[0]?.from).toBeNull();
    expect(effects.budget).toEqual({ currency: 'EUR', from: '4000.00', to: '12000.00', delta: '8000.00' });
  });

  it('has no budget line without a cost delta, and no go-live without a new date', () => {
    const effects = computeEffects({ costDelta: null, planChanges: null, scopeChanges: null }, plan, false);
    expect(effects.budget).toBeNull();
    expect(effects.goLive).toBeNull();
    expect(computeEffects({ costDelta: '0.00', planChanges: null, scopeChanges: null }, plan, false).budget).toBeNull();
  });

  it('writes one plain line per effect for the decision it records', () => {
    expect(consequenceLines(computeEffects(change, plan, false))).toEqual([
      'Go-live moves to 2026-12-09',
      'Milestone "Beta" moves to 2026-11-28',
      'Deliverable D1 "App" is rescheduled',
      'Deliverable "Training" is added to the scope',
      'Deliverable D2 "Manual" is removed from the scope',
      'The budget rises by 8000.00 EUR',
    ]);
    const saves = computeEffects({ costDelta: '-250.00', planChanges: null, scopeChanges: null }, plan, false);
    expect(consequenceLines(saves)).toEqual(['The budget falls by 250.00 EUR']);
  });
});

describe('impactChanged', () => {
  const existing = {
    costDelta: '8000.00',
    scheduleDeltaDays: 4,
    planChanges: { milestones: [{ milestoneId: 'm1', to: '2026-11-28T00:00:00.000Z' }] },
    scopeChanges: null,
  };

  it('is false for the same impact sent again, whatever the key order', () => {
    expect(impactChanged(existing, {})).toBe(false);
    expect(impactChanged(existing, { costDelta: 8000, scheduleDeltaDays: 4 })).toBe(false);
    expect(impactChanged(existing, { planChanges: { milestones: [{ to: '2026-11-28T00:00:00.000Z', milestoneId: 'm1' }] }, scopeChanges: null })).toBe(false);
  });

  it('is true when a figure or a change differs', () => {
    expect(impactChanged(existing, { costDelta: 8001 })).toBe(true);
    expect(impactChanged(existing, { costDelta: null })).toBe(true);
    expect(impactChanged(existing, { scheduleDeltaDays: null })).toBe(true);
    expect(impactChanged(existing, { planChanges: null })).toBe(true);
    expect(impactChanged(existing, { scopeChanges: { remove: ['d1'] } })).toBe(true);
  });
});
