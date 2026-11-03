import { describe, expect, it } from 'vitest';
import fixtures from './testing/schedule-fixtures.json';
import {
  computeSchedule,
  dateOf,
  dayNumber,
  isoDate,
  isoWeekday,
  normalizeCalendar,
  previewMove,
  projectDeliverables,
  withTimeOfDay,
  workingDaysBetween,
  type MoveRequest,
  type ScheduleCalendar,
  type ScheduleInput,
} from './schedule';

type Json = Record<string, unknown>;

interface FixtureInput extends Omit<ScheduleInput, 'calendar'> {
  calendar?: ScheduleCalendar;
}

const baseCalendar = fixtures.calendar as ScheduleCalendar;
const withCalendar = (input: FixtureInput): ScheduleInput => ({ ...input, calendar: input.calendar ?? baseCalendar });

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

describe('computeSchedule fixtures (shared with the Rust flow-domain)', () => {
  for (const fixture of fixtures.schedule) {
    it(fixture.name, () => {
      const result = computeSchedule(withCalendar(fixture.input as FixtureInput));
      const { tasks: expectedTasks, ...rest } = fixture.expected as unknown as Json & { tasks?: Record<string, Json> };
      expectSubset(result, rest, 'result');
      const byId = new Map(result.tasks.map((task) => [task.id, task]));
      for (const [id, expected] of Object.entries(expectedTasks ?? {})) {
        expect(byId.has(id), `task ${id} is in the result`).toBe(true);
        expectSubset(byId.get(id), expected, `tasks.${id}`);
      }
      // One entry per input task, in order.
      expect(result.tasks.map((task) => task.id)).toEqual((fixture.input.tasks as Array<{ id: string }>).map((task) => task.id));
    });
  }
});

describe('previewMove fixtures (shared with the Rust flow-domain)', () => {
  for (const fixture of fixtures.moves) {
    it(fixture.name, () => {
      const result = previewMove(withCalendar(fixture.input as FixtureInput), fixture.move as MoveRequest);
      const { schedule: _schedule, ...rest } = result as typeof result & { schedule?: unknown };
      expectSubset(rest, fixture.expected, 'result');
    });
  }

  it('answers with the schedule after the move, whose early dates are what a save writes', () => {
    const fixture = fixtures.moves[0];
    const result = previewMove(withCalendar(fixture.input as FixtureInput), fixture.move as MoveRequest);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const byId = new Map(result.schedule.tasks.map((task) => [task.id, task]));
    expect(byId.get('A')?.plannedStart).toBe('2026-11-04');
    expect(byId.get('B')?.earlyStart).toBe('2026-11-11');
    expect(byId.get('C')?.earlyFinish).toBe('2026-11-17');
    // The task nobody waits for does not move.
    expect(byId.get('X')?.shiftDays).toBe(0);
  });
});

describe('dates', () => {
  it('reads real calendar dates only', () => {
    expect(dayNumber('1970-01-01')).toBe(0);
    expect(dayNumber('2026-11-02')).toBe(20_759);
    expect(dayNumber('2026-02-30')).toBeNull();
    expect(dayNumber('2026-13-01')).toBeNull();
    expect(dayNumber('26-11-02')).toBeNull();
    expect(dayNumber('2026-11-02T00:00:00Z')).toBeNull();
    expect(dayNumber(null)).toBeNull();
    expect(dayNumber('')).toBeNull();
    expect(dayNumber('2028-02-29')).not.toBeNull();
    expect(dayNumber('2027-02-29')).toBeNull();
  });

  it('round-trips a day number and knows the ISO weekday', () => {
    expect(isoDate(dayNumber('2026-11-02') as number)).toBe('2026-11-02');
    expect(isoWeekday(dayNumber('2026-11-02') as number)).toBe(1);
    expect(isoWeekday(dayNumber('2026-11-08') as number)).toBe(7);
    expect(isoWeekday(0)).toBe(4);
    expect(isoWeekday(-1)).toBe(3);
  });

  it('counts working days between two dates, signed', () => {
    expect(workingDaysBetween(baseCalendar, '2026-11-02', '2026-11-09')).toBe(5);
    expect(workingDaysBetween(baseCalendar, '2026-11-09', '2026-11-02')).toBe(-5);
    expect(workingDaysBetween(baseCalendar, '2026-11-06', '2026-11-09')).toBe(1);
    expect(workingDaysBetween(baseCalendar, '2026-11-02', '2026-11-02')).toBe(0);
    expect(workingDaysBetween({ workingDays: [1, 2, 3, 4, 5], holidays: ['2026-11-09'] }, '2026-11-06', '2026-11-10')).toBe(1);
    expect(workingDaysBetween(baseCalendar, 'nope', '2026-11-02')).toBeNull();
  });

  it('keeps the time of day of a stored date when a save moves it', () => {
    const stored = new Date('2026-11-02T09:30:00.000Z');
    expect(withTimeOfDay('2026-11-09', stored).toISOString()).toBe('2026-11-09T09:30:00.000Z');
    expect(withTimeOfDay('2026-11-09', null).toISOString()).toBe('2026-11-09T00:00:00.000Z');
    expect(dateOf(stored)).toBe('2026-11-02');
    expect(dateOf(null)).toBeNull();
    expect(dateOf('not a date')).toBeNull();
  });
});

describe('normalizeCalendar', () => {
  it('falls back to Monday to Friday and drops unusable entries', () => {
    expect(normalizeCalendar(null)).toEqual({ workingDays: [1, 2, 3, 4, 5], holidays: [] });
    expect(normalizeCalendar({ workingDays: [], holidays: ['x', '2026-12-25', '2026-12-25'] })).toEqual({
      workingDays: [1, 2, 3, 4, 5],
      holidays: ['2026-12-25'],
    });
    expect(normalizeCalendar({ workingDays: [7, 0, 3, 3, 8, 1.5, 'x'] })).toEqual({ workingDays: [3, 7], holidays: [] });
  });

  it('survives a calendar with no working day in sight', () => {
    // Every weekday a holiday for ten years is absurd, but must not hang.
    const result = computeSchedule({
      tasks: [{ id: 'A', status: 'todo', startDate: '2026-11-02', dueDate: '2026-11-03' }],
      links: [],
      calendar: { workingDays: [1], holidays: [] },
    });
    expect(result.tasks[0].durationDays).toBe(1);
  });
});

describe('projectDeliverables', () => {
  it('ends a deliverable with its latest task', () => {
    const schedule = computeSchedule(
      withCalendar({
        tasks: [
          { id: 'A', status: 'todo', startDate: '2026-11-02', dueDate: '2026-11-04' },
          { id: 'B', status: 'todo', startDate: '2026-11-09', dueDate: '2026-11-10' },
          { id: 'C', status: 'cancelled', startDate: '2026-11-02', dueDate: '2026-12-01' },
        ],
        links: [],
      }),
    );
    expect(
      projectDeliverables(
        ['d1', 'd2', 'd3'],
        [
          { deliverableId: 'd1', taskId: 'A' },
          { deliverableId: 'd1', taskId: 'B' },
          { deliverableId: 'd2', taskId: 'C' },
        ],
        schedule,
      ),
    ).toEqual([
      { deliverableId: 'd1', projectedEnd: '2026-11-10' },
      { deliverableId: 'd2', projectedEnd: null },
      { deliverableId: 'd3', projectedEnd: null },
    ]);
  });
});
