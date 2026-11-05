import { describe, expect, it } from 'vitest';
import fixtures from './testing/gate-fixtures.json';
import {
  GATE_MESSAGES,
  checkGate,
  criteriaError,
  criterionError,
  gateApproverIds,
  gateFactsNeeded,
  gateRequestError,
  gateResultOf,
  nextUpcomingPhase,
  normalizeCriterion,
  phaseToActivate,
  reorderError,
  type GateCriterion,
  type GateFacts,
  type GateWaiver,
} from './gates';

type Json = Record<string, unknown>;

/** Every field of `expected` must match `actual` exactly; arrays match element by element. */
function expectSubset(actual: unknown, expected: unknown, path: string): void {
  if (Array.isArray(expected)) {
    expect(Array.isArray(actual), `${path} is a list`).toBe(true);
    const list = actual as unknown[];
    expect(list.length, `${path} length`).toBe(expected.length);
    expected.forEach((item, index) => expectSubset(list[index], item, `${path}[${index}]`));
    return;
  }
  if (expected !== null && typeof expected === 'object') {
    expect(actual !== null && typeof actual === 'object', `${path} is an object`).toBe(true);
    for (const [key, value] of Object.entries(expected as Json)) {
      expectSubset((actual as Json)[key], value, `${path}.${key}`);
    }
    return;
  }
  expect(actual, path).toBe(expected);
}

describe('checkGate fixtures (shared with the Rust flow-domain)', () => {
  for (const fixture of fixtures.cases) {
    it(fixture.name, () => {
      const check = checkGate(fixture.criteria as GateCriterion[], fixture.facts as GateFacts, fixture.waivers as GateWaiver[]);
      expectSubset(check, fixture.expected, 'check');
    });
  }
});

describe('criterionError', () => {
  it('accepts every catalogue key with its parameters and a manual text', () => {
    const fine: unknown[] = [
      { key: 'deliverable_tasks_done', params: { deliverableId: 'dlv_1' } },
      { key: 'deliverable_accepted', params: { deliverableId: 'dlv_1' } },
      { key: 'no_open_risk_above', params: { band: 'critical' } },
      { key: 'no_open_risk_above', params: { band: 'low' } },
      { key: 'decision_decided', params: { decisionId: 'dec_1' } },
      { key: 'no_change_request_pending' },
      { key: 'spend_within_baseline' },
      { manual: 'Plan approved' },
    ];
    for (const criterion of fine) expect(criterionError(criterion), JSON.stringify(criterion)).toBeNull();
    expect(criteriaError(fine)).toBeNull();
  });

  it('refuses unknown keys and missing parameters with the catalogue messages', () => {
    expect(criterionError({ key: 'moon_phase' })).toBe(GATE_MESSAGES.unknownCriterion);
    expect(criterionError({ key: 'deliverable_tasks_done' })).toBe(GATE_MESSAGES.deliverableRequired);
    expect(criterionError({ key: 'deliverable_accepted', params: { deliverableId: ' ' } })).toBe(GATE_MESSAGES.deliverableRequired);
    expect(criterionError({ key: 'decision_decided', params: {} })).toBe(GATE_MESSAGES.decisionRequired);
    expect(criterionError({ key: 'no_open_risk_above', params: { band: 'extreme' } })).toBe(GATE_MESSAGES.bandRequired);
    expect(criterionError({ manual: '   ' })).toBe(GATE_MESSAGES.manualTextRequired);
    expect(criterionError({ manual: 5 })).toBe(GATE_MESSAGES.manualTextRequired);
    expect(criterionError('text')).toBe(GATE_MESSAGES.invalidCriterion);
    expect(criterionError(null)).toBe(GATE_MESSAGES.invalidCriterion);
    expect(criteriaError([{ manual: 'ok' }, { key: 'nope' }])).toBe(GATE_MESSAGES.unknownCriterion);
  });
});

describe('normalizeCriterion and gateFactsNeeded', () => {
  it('starts a manual criterion unmet and drops empty parameters', () => {
    expect(normalizeCriterion({ manual: '  Plan  ' })).toEqual({ manual: 'Plan', met: false, metAt: null });
    expect(normalizeCriterion({ manual: 'Plan', met: true, metAt: '2026-11-03T00:00:00.000Z' })).toEqual({
      manual: 'Plan',
      met: true,
      metAt: '2026-11-03T00:00:00.000Z',
    });
    expect(normalizeCriterion({ key: 'no_change_request_pending', params: {} })).toEqual({ key: 'no_change_request_pending' });
    expect(normalizeCriterion({ key: 'no_open_risk_above', params: { band: 'high' } })).toEqual({
      key: 'no_open_risk_above',
      params: { band: 'high' },
    });
  });

  it('lists only what the criteria need to read', () => {
    expect(
      gateFactsNeeded([
        { key: 'deliverable_tasks_done', params: { deliverableId: 'a' } },
        { key: 'deliverable_accepted', params: { deliverableId: 'a' } },
        { key: 'decision_decided', params: { decisionId: 'd' } },
        { key: 'spend_within_baseline' },
        { manual: 'x' },
      ]),
    ).toEqual({ deliverableIds: ['a'], decisionIds: ['d'], risks: false, changeRequests: false, spend: true });
    expect(gateFactsNeeded([])).toEqual({ deliverableIds: [], decisionIds: [], risks: false, changeRequests: false, spend: false });
  });
});

describe('gateResultOf', () => {
  it('stores the criteria with their facts and the waivers that apply', () => {
    const criteria: GateCriterion[] = [{ key: 'no_change_request_pending' }, { manual: 'Plan' }];
    const facts: GateFacts = { deliverables: [], risks: [], decisions: [], changeRequests: [{ id: 'cr', number: 1, title: 'x' }], spend: null };
    const waivers: GateWaiver[] = [
      { index: 0, note: 'later', by: 'u', at: '2026-11-03T10:00:00.000Z' },
      { index: 5, note: 'stale', by: 'u', at: '2026-11-03T10:00:00.000Z' },
    ];
    const result = gateResultOf(checkGate(criteria, facts, waivers), criteria, waivers, '2026-11-03T11:00:00.000Z');
    expect(result.checkedAt).toBe('2026-11-03T11:00:00.000Z');
    expect(result.criteria).toHaveLength(2);
    expect(result.criteria[0]).toMatchObject({ met: false, detail: { count: 1 } });
    expect(result.waived).toEqual([{ index: 0, note: 'later', by: 'u', at: '2026-11-03T10:00:00.000Z' }]);
  });
});

describe('phase lifecycle rules', () => {
  const phases = [
    { id: 'p1', position: 0, status: 'passed' },
    { id: 'p2', position: 1, status: 'active' },
    { id: 'p3', position: 2, status: 'upcoming' },
    { id: 'p4', position: 3, status: 'upcoming' },
  ];

  it('activates the first upcoming phase only when none is active', () => {
    expect(phaseToActivate(phases)).toBeNull();
    expect(phaseToActivate([{ id: 'a', position: 1, status: 'passed' }, { id: 'c', position: 3, status: 'upcoming' }, { id: 'b', position: 2, status: 'upcoming' }])).toBe('b');
    expect(phaseToActivate([{ id: 'a', position: 1, status: 'passed' }])).toBeNull();
    expect(phaseToActivate([])).toBeNull();
    // Equal positions fall back to the id.
    expect(phaseToActivate([{ id: 'y', position: 0, status: 'upcoming' }, { id: 'x', position: 0, status: 'upcoming' }])).toBe('x');
  });

  it('finds the next upcoming phase after one', () => {
    expect(nextUpcomingPhase(phases, 'p2')).toBe('p3');
    expect(nextUpcomingPhase(phases, 'p3')).toBe('p4');
    expect(nextUpcomingPhase(phases, 'p4')).toBeNull();
    expect(nextUpcomingPhase(phases, 'missing')).toBeNull();
  });

  it('accepts a reorder that lists every phase once and keeps the passed ones first', () => {
    expect(reorderError(phases, ['p1', 'p2', 'p4', 'p3'])).toBeNull();
    expect(reorderError(phases, ['p1', 'p2', 'p3'])).toBe(GATE_MESSAGES.reorderIncomplete);
    expect(reorderError(phases, ['p1', 'p2', 'p3', 'p3'])).toBe(GATE_MESSAGES.reorderIncomplete);
    expect(reorderError(phases, ['p1', 'p2', 'p3', 'zzz'])).toBe(GATE_MESSAGES.reorderIncomplete);
    expect(reorderError(phases, ['p2', 'p1', 'p3', 'p4'])).toBe(GATE_MESSAGES.reorderPassed);
    expect(reorderError(phases, ['p2', 'p3', 'p4', 'p1'])).toBe(GATE_MESSAGES.reorderPassed);
  });

  it('refuses a reorder that puts an upcoming phase ahead of the active one', () => {
    expect(reorderError(phases, ['p1', 'p3', 'p2', 'p4'])).toBe(GATE_MESSAGES.reorderActive);
    expect(reorderError(phases, ['p1', 'p4', 'p3', 'p2'])).toBe(GATE_MESSAGES.reorderActive);
    // With no active phase, upcoming ones may go in any order.
    const idle = phases.map((phase) => (phase.status === 'active' ? { ...phase, status: 'upcoming' } : phase));
    expect(reorderError(idle, ['p1', 'p4', 'p2', 'p3'])).toBeNull();
  });

  it('says why a gate cannot be requested, in a fixed order', () => {
    const ready = { allSatisfied: true };
    expect(gateRequestError({ status: 'active', gateRequestedAt: null }, ready, true)).toBeNull();
    expect(gateRequestError({ status: 'passed', gateRequestedAt: null }, ready, true)).toBe(GATE_MESSAGES.phasePassed);
    expect(gateRequestError({ status: 'upcoming', gateRequestedAt: null }, ready, true)).toBe(GATE_MESSAGES.phaseNotActive);
    expect(gateRequestError({ status: 'active', gateRequestedAt: new Date() }, ready, true)).toBe(GATE_MESSAGES.alreadyRequested);
    expect(gateRequestError({ status: 'active', gateRequestedAt: null }, { allSatisfied: false }, true)).toBe(GATE_MESSAGES.notAllSatisfied);
    expect(gateRequestError({ status: 'active', gateRequestedAt: null }, ready, false)).toBe(GATE_MESSAGES.noApprover);
  });

  it('asks the sponsor and one board member, once each', () => {
    expect(gateApproverIds('sponsor', ['board', 'other'])).toEqual(['sponsor', 'board']);
    expect(gateApproverIds('sponsor', ['sponsor'])).toEqual(['sponsor']);
    expect(gateApproverIds('sponsor', [])).toEqual(['sponsor']);
    expect(gateApproverIds('sponsor', undefined)).toEqual(['sponsor']);
    expect(gateApproverIds(null, ['board'])).toEqual([]);
  });
});
