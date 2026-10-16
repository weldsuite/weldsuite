import { describe, expect, it } from 'vitest';
import { DEFAULT_TASK_HOURS_PER_DAY, dailyLoad, loadCategory, spreadTaskLoad } from './workload-math';

// 2026-06-01 is a Monday.
const mon = '2026-06-01T09:00:00';
const fri = '2026-06-05T09:00:00';
const sat = '2026-06-06T09:00:00';
const nextMon = '2026-06-08T09:00:00';

function task(input: Parameters<typeof spreadTaskLoad>[0]) {
  return { id: 't1', assigneeId: 'u1', ...spreadTaskLoad(input) };
}

describe('spreadTaskLoad', () => {
  it('spreads hours over working days only', () => {
    // Mon..next Mon spans 6 working days (Mon-Fri + Mon).
    const load = spreadTaskLoad({ startDate: mon, dueDate: nextMon, estimatedHours: 12 });
    expect(load.hoursPerDay).toBe(2);
    expect(load.scheduled).toBe(true);
    expect(load.weekendOnly).toBe(false);
  });

  it('does not cap the per-day load', () => {
    const load = spreadTaskLoad({ startDate: mon, dueDate: mon, estimatedHours: 20 });
    expect(load.hoursPerDay).toBe(20);
  });

  it('coerces string estimates and falls back to the default when missing', () => {
    expect(spreadTaskLoad({ startDate: mon, dueDate: fri, estimatedHours: '10.00' }).hoursPerDay).toBe(2);
    expect(spreadTaskLoad({ startDate: mon, dueDate: fri }).hoursPerDay).toBe(DEFAULT_TASK_HOURS_PER_DAY);
  });

  it('treats a task without dates as unscheduled', () => {
    const load = spreadTaskLoad({ estimatedHours: 8 });
    expect(load.scheduled).toBe(false);
    expect(load.hoursPerDay).toBe(0);
  });

  it('counts a single date as one day', () => {
    const load = spreadTaskLoad({ dueDate: fri, estimatedHours: 6 });
    expect(load.startAt.getTime()).toBe(load.endAt.getTime());
    expect(load.hoursPerDay).toBe(6);
  });

  it('puts a weekend-only task on the weekend instead of dropping it', () => {
    const load = spreadTaskLoad({ startDate: sat, dueDate: sat, estimatedHours: 4 });
    expect(load.weekendOnly).toBe(true);
    expect(load.hoursPerDay).toBe(4);
  });
});

describe('dailyLoad', () => {
  const week = task({ startDate: mon, dueDate: nextMon, estimatedHours: 12 });

  it('loads working days and leaves weekends empty', () => {
    expect(dailyLoad('u1', [week], new Date('2026-06-03T12:00:00')).totalHours).toBe(2);
    expect(dailyLoad('u1', [week], new Date('2026-06-06T12:00:00')).totalHours).toBe(0);
    expect(dailyLoad('u1', [week], new Date('2026-06-07T12:00:00')).totalHours).toBe(0);
  });

  it('includes the due date even when asked with a time of day', () => {
    expect(dailyLoad('u1', [week], new Date('2026-06-08T18:30:00')).totalHours).toBe(2);
  });

  it('ignores unscheduled tasks and other members', () => {
    const unscheduled = task({ estimatedHours: 8 });
    expect(dailyLoad('u1', [unscheduled], new Date('2026-06-03T12:00:00')).totalHours).toBe(0);
    expect(dailyLoad('u2', [week], new Date('2026-06-03T12:00:00')).totalHours).toBe(0);
  });
});

describe('loadCategory', () => {
  it('buckets by utilization', () => {
    expect(loadCategory(9, 8)).toBe('overloaded');
    expect(loadCategory(8, 8)).toBe('optimal');
    expect(loadCategory(3, 8)).toBe('underloaded');
    expect(loadCategory(0, 0)).toBe('underloaded');
  });
});
