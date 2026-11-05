import { describe, expect, it } from 'vitest';
import {
  baselineIsEmpty,
  buildSnapshot,
  compareSnapshots,
  dayDelta,
  decimal,
  decimalDelta,
  decimalSum,
  toCents,
  type PlanState,
} from './baselines';

const d = (iso: string) => new Date(iso);

const plan = (overrides: Partial<PlanState> = {}): PlanState => ({
  goLive: d('2026-12-01T00:00:00.000Z'),
  milestones: [
    { id: 'm2', name: 'Beta', dueDate: d('2026-11-20T00:00:00.000Z') },
    { id: 'm1', name: 'Alpha', dueDate: d('2026-11-10T00:00:00.000Z') },
  ],
  deliverables: [
    { id: 'd2', number: 2, title: 'Manual', plannedStart: d('2026-11-05T00:00:00.000Z'), plannedEnd: d('2026-11-25T00:00:00.000Z') },
    { id: 'd1', number: 1, title: 'App', plannedStart: null, plannedEnd: d('2026-11-15T00:00:00.000Z') },
  ],
  budgetedAmount: '12000.00',
  budgetedHours: '300.00',
  budgetCurrency: 'EUR',
  scopeStatement: 'Ship the app',
  ...overrides,
});

describe('decimals', () => {
  it('reads and writes two decimals', () => {
    expect(decimal('12000')).toBe('12000.00');
    expect(decimal(12.5)).toBe('12.50');
    expect(decimal('-3.1')).toBe('-3.10');
    expect(decimal(null)).toBeNull();
    expect(decimal('')).toBeNull();
    expect(decimal('abc')).toBeNull();
    expect(toCents('0.05')).toBe(5n);
  });

  it('adds and subtracts exactly', () => {
    expect(decimalSum('0.10', 0.2)).toBe('0.30');
    expect(decimalSum(null, 8000)).toBe('8000.00');
    expect(decimalSum('100.00', -250.5)).toBe('-150.50');
    expect(decimalDelta('100.00', '112.50')).toBe('12.50');
    expect(decimalDelta(null, '5.00')).toBe('5.00');
    expect(decimalDelta(null, null)).toBeNull();
  });
});

describe('dayDelta', () => {
  it('counts whole days between two moments, negative when earlier', () => {
    expect(dayDelta('2026-11-10T00:00:00.000Z', '2026-11-18T00:00:00.000Z')).toBe(8);
    expect(dayDelta('2026-11-18T00:00:00.000Z', '2026-11-10T00:00:00.000Z')).toBe(-8);
    expect(dayDelta(null, '2026-11-10T00:00:00.000Z')).toBeNull();
    expect(dayDelta('2026-11-10T00:00:00.000Z', null)).toBeNull();
  });
});

describe('buildSnapshot', () => {
  it('orders milestones by due date and deliverables by number, and writes ISO dates', () => {
    const snapshot = buildSnapshot(plan());
    expect(snapshot.milestones.map((m) => m.id)).toEqual(['m1', 'm2']);
    expect(snapshot.deliverables.map((x) => x.id)).toEqual(['d1', 'd2']);
    expect(snapshot.goLive).toBe('2026-12-01T00:00:00.000Z');
    expect(snapshot.deliverables[0]).toEqual({ id: 'd1', number: 1, title: 'App', plannedStart: null, plannedEnd: '2026-11-15T00:00:00.000Z' });
    expect(snapshot.budgetedAmount).toBe('12000.00');
    expect(snapshot.scopeStatement).toBe('Ship the app');
  });

  it('freezes the same plan to the same snapshot whatever the input order', () => {
    const shuffled = plan({ milestones: [...plan().milestones].reverse(), deliverables: [...plan().deliverables].reverse() });
    expect(buildSnapshot(shuffled)).toEqual(buildSnapshot(plan()));
  });

  it('says when there is nothing to freeze', () => {
    expect(baselineIsEmpty({ goLive: null, milestones: [], deliverables: [] })).toBe(true);
    expect(baselineIsEmpty({ goLive: d('2026-12-01T00:00:00.000Z'), milestones: [], deliverables: [] })).toBe(false);
    expect(baselineIsEmpty(plan({ goLive: null }))).toBe(false);
  });
});

describe('compareSnapshots', () => {
  it('shows slip per milestone and deliverable, and the go-live and budget', () => {
    const from = buildSnapshot(plan());
    const to = buildSnapshot(
      plan({
        goLive: d('2026-12-09T00:00:00.000Z'),
        milestones: [
          { id: 'm1', name: 'Alpha', dueDate: d('2026-11-10T00:00:00.000Z') },
          { id: 'm2', name: 'Beta', dueDate: d('2026-11-28T00:00:00.000Z') },
        ],
        deliverables: [
          { id: 'd1', number: 1, title: 'App', plannedStart: null, plannedEnd: d('2026-11-15T00:00:00.000Z') },
          { id: 'd2', number: 2, title: 'Manual', plannedStart: d('2026-11-05T00:00:00.000Z'), plannedEnd: d('2026-12-03T00:00:00.000Z') },
        ],
        budgetedAmount: '20000.00',
      }),
    );
    const diff = compareSnapshots(from, to);
    expect(diff.goLive).toEqual({ from: '2026-12-01T00:00:00.000Z', to: '2026-12-09T00:00:00.000Z', deltaDays: 8 });
    expect(diff.milestones.map((m) => [m.id, m.change, m.deltaDays])).toEqual([
      ['m1', 'unchanged', 0],
      ['m2', 'moved', 8],
    ]);
    expect(diff.deliverables.map((x) => [x.id, x.change, x.end.deltaDays])).toEqual([
      ['d1', 'unchanged', 0],
      ['d2', 'moved', 8],
    ]);
    expect(diff.budget).toEqual({ from: '12000.00', to: '20000.00', delta: '8000.00' });
    expect(diff.hours.delta).toBe('0.00');
  });

  it('marks added and removed items', () => {
    const from = buildSnapshot(plan());
    const to = buildSnapshot(
      plan({
        milestones: [{ id: 'm3', name: 'Gamma', dueDate: d('2026-11-30T00:00:00.000Z') }],
        deliverables: [
          { id: 'd1', number: 1, title: 'App', plannedStart: null, plannedEnd: d('2026-11-15T00:00:00.000Z') },
          { id: 'd3', number: 3, title: 'Training', plannedStart: null, plannedEnd: null },
        ],
      }),
    );
    const diff = compareSnapshots(from, to);
    expect(diff.milestones.map((m) => [m.id, m.change])).toEqual([
      ['m1', 'removed'],
      ['m2', 'removed'],
      ['m3', 'added'],
    ]);
    expect(diff.deliverables.map((x) => [x.id, x.change])).toEqual([
      ['d1', 'unchanged'],
      ['d2', 'removed'],
      ['d3', 'added'],
    ]);
  });

  it('is empty of change for two equal snapshots', () => {
    const snapshot = buildSnapshot(plan());
    const diff = compareSnapshots(snapshot, snapshot);
    expect(diff.milestones.every((m) => m.change === 'unchanged')).toBe(true);
    expect(diff.goLive.deltaDays).toBe(0);
    expect(diff.budget.delta).toBe('0.00');
  });
});
