import { describe, expect, it } from 'vitest';
import type { Sprint } from '@weldsuite/app-api-client/schemas/flow-agile';
import {
  completedSprints,
  defaultSprintId,
  groupSprints,
  sprintDay,
  sprintKpis,
  sprintPoints,
  velocityBars,
} from './sprint-metrics';

function sprint(id: string, overrides: Partial<Sprint> = {}): Sprint {
  return {
    id,
    projectId: 'p1',
    name: `Sprint ${id}`,
    goal: null,
    status: 'planned',
    startDate: null,
    endDate: null,
    startedAt: null,
    completedAt: null,
    velocity: null,
    storyPointsCommitted: null,
    storyPointsCompleted: null,
    createdAt: `2026-01-0${id.length}T00:00:00Z`,
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function done(id: string, committed: number, completed: number, carried = 0, completedAt?: string): Sprint {
  return sprint(id, {
    status: 'completed',
    velocity: completed,
    completedAt: completedAt ?? `2026-02-${id.padStart(2, '0')}T00:00:00Z`,
    report: {
      committed: { points: committed, count: 5, taskIds: [] },
      completed: { points: completed, count: 4 },
      carriedOver: { points: committed - completed, count: carried, taskIds: [], toSprintId: null, toBacklog: 0 },
    },
  });
}

describe('defaultSprintId', () => {
  it('prefers the active sprint', () => {
    const list = [sprint('a', { startDate: '2026-03-01' }), sprint('b', { status: 'active' })];
    expect(defaultSprintId(list)).toBe('b');
  });

  it('falls back to the soonest planned sprint', () => {
    const list = [sprint('a', { startDate: '2026-04-01' }), sprint('b', { startDate: '2026-03-01' }), done('3', 10, 8)];
    expect(defaultSprintId(list)).toBe('b');
  });

  it('is null when only past sprints exist', () => {
    expect(defaultSprintId([done('1', 10, 8)])).toBeNull();
    expect(defaultSprintId([])).toBeNull();
  });
});

describe('groupSprints', () => {
  it('orders planned by start and past by completion, newest first', () => {
    const groups = groupSprints([
      done('1', 10, 8, 0, '2026-02-01T00:00:00Z'),
      done('2', 10, 8, 0, '2026-03-01T00:00:00Z'),
      sprint('x', { startDate: '2026-05-01' }),
      sprint('y', { startDate: '2026-04-01' }),
      sprint('z', { status: 'cancelled', completedAt: '2026-01-15T00:00:00Z' }),
    ]);
    expect(groups.active).toBeNull();
    expect(groups.planned.map((s) => s.id)).toEqual(['y', 'x']);
    expect(groups.past.map((s) => s.id)).toEqual(['2', '1', 'z']);
  });
});

describe('sprintDay', () => {
  const dates = { startDate: '2026-11-18', endDate: '2026-11-27' };
  const day = (iso: string) => Math.floor(Date.parse(`${iso}T00:00:00Z`) / 86_400_000);

  it('counts from the first day', () => {
    expect(sprintDay(dates, day('2026-11-18'))).toEqual({ day: 1, total: 10 });
    expect(sprintDay(dates, day('2026-11-22'))).toEqual({ day: 5, total: 10 });
  });

  it('clamps outside the sprint', () => {
    expect(sprintDay(dates, day('2026-11-01'))?.day).toBe(1);
    expect(sprintDay(dates, day('2026-12-20'))?.day).toBe(10);
  });

  it('is null without dates', () => {
    expect(sprintDay({ startDate: null, endDate: null })).toBeNull();
  });
});

describe('sprintPoints', () => {
  it('reads the report first, then the sprint columns', () => {
    expect(sprintPoints(done('1', 30, 25))).toEqual({ committed: 30, completed: 25 });
    expect(sprintPoints(sprint('2', { storyPointsCommitted: 12, storyPointsCompleted: 9 }))).toEqual({
      committed: 12,
      completed: 9,
    });
  });
});

describe('velocityBars', () => {
  it('keeps the last eight completed sprints, oldest first', () => {
    const list = Array.from({ length: 10 }, (_, i) => done(String(i + 1), 20, 10 + i));
    list.push(sprint('active', { status: 'active' }));
    const bars = velocityBars(list);
    expect(bars).toHaveLength(8);
    expect(bars[0].id).toBe('3');
    expect(bars[7]).toMatchObject({ id: '10', committed: 20, completed: 19 });
  });
});

describe('sprintKpis', () => {
  it('averages the last three completed sprints', () => {
    const list = [done('1', 20, 10), done('2', 30, 28, 1), done('3', 30, 30, 2), done('4', 30, 26, 3)];
    expect(completedSprints(list).map((s) => s.id)).toEqual(['1', '2', '3', '4']);
    expect(sprintKpis(list)).toEqual({
      averageVelocity: 28,
      lastVelocity: 26,
      reliability: 93,
      carriedOver: 2,
    });
  });

  it('is empty without completed sprints', () => {
    expect(sprintKpis([sprint('a')])).toEqual({
      averageVelocity: null,
      lastVelocity: null,
      reliability: null,
      carriedOver: null,
    });
  });

  it('has no reliability without committed points', () => {
    expect(sprintKpis([done('1', 0, 0)]).reliability).toBeNull();
  });
});
