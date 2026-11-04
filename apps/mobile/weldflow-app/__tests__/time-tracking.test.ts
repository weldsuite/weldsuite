import {
  addDays,
  elapsedMs,
  formatElapsed,
  groupEntriesByDay,
  parseLoggedMinutes,
  splitMinutes,
  toDateKey,
  weekRange,
} from '@/lib/time-tracking';
import type { TimeEntry } from '@/types/weldflow';

function entry(id: string, date: string, duration: string): TimeEntry {
  return {
    id,
    projectId: 'prj_1',
    taskId: 'task_1',
    userId: 'user_1',
    date,
    duration,
    description: null,
    startTime: null,
    endTime: null,
    billable: true,
    status: 'draft',
  };
}

describe('weekRange', () => {
  it('runs Monday to Sunday', () => {
    // Wednesday 4 Nov 2026
    expect(weekRange(new Date(2026, 10, 4))).toEqual({ from: '2026-11-02', to: '2026-11-08' });
  });

  it('puts a Sunday in the week that started the Monday before', () => {
    expect(weekRange(new Date(2026, 10, 8, 23, 30))).toEqual({
      from: '2026-11-02',
      to: '2026-11-08',
    });
  });

  it('crosses a month and year boundary', () => {
    // Friday 1 Jan 2027
    expect(weekRange(new Date(2027, 0, 1))).toEqual({ from: '2026-12-28', to: '2027-01-03' });
  });
});

describe('calendar days', () => {
  it('formats the local day and adds days across month ends', () => {
    expect(toDateKey(new Date(2026, 0, 5))).toBe('2026-01-05');
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });
});

describe('formatElapsed', () => {
  it('shows minutes and seconds under an hour', () => {
    expect(formatElapsed(0)).toBe('0:00');
    expect(formatElapsed(247_000)).toBe('4:07');
  });

  it('adds hours from one hour on', () => {
    expect(formatElapsed(3_847_000)).toBe('1:04:07');
  });

  it('never goes negative', () => {
    expect(formatElapsed(-5000)).toBe('0:00');
    expect(elapsedMs('2026-11-03T10:00:00Z', Date.parse('2026-11-03T09:59:00Z'))).toBe(0);
  });

  it('treats a malformed start as zero', () => {
    expect(elapsedMs('not a date', Date.now())).toBe(0);
  });
});

describe('splitMinutes', () => {
  it('rounds to the minute', () => {
    expect(splitMinutes(90.4)).toEqual({ hours: 1, minutes: 30 });
    expect(splitMinutes(59.6)).toEqual({ hours: 1, minutes: 0 });
  });
});

describe('parseLoggedMinutes', () => {
  it('adds hours and minutes', () => {
    expect(parseLoggedMinutes('1', '30')).toBe(90);
    expect(parseLoggedMinutes('', '45')).toBe(45);
    expect(parseLoggedMinutes('2', '')).toBe(120);
  });

  it('accepts minutes over 60', () => {
    expect(parseLoggedMinutes('0', '90')).toBe(90);
  });

  it('refuses nothing, fractions and more than a day', () => {
    expect(parseLoggedMinutes('', '')).toBeNull();
    expect(parseLoggedMinutes('0', '0')).toBeNull();
    expect(parseLoggedMinutes('1.5', '')).toBeNull();
    expect(parseLoggedMinutes('24', '1')).toBeNull();
    expect(parseLoggedMinutes('24', '0')).toBe(1440);
  });
});

describe('groupEntriesByDay', () => {
  it('groups per day, newest first, with totals', () => {
    const days = groupEntriesByDay([
      entry('a', '2026-11-02', '30.00'),
      entry('b', '2026-11-04', '90.50'),
      entry('c', '2026-11-02', '15'),
    ]);
    expect(days.map((d) => d.date)).toEqual(['2026-11-04', '2026-11-02']);
    expect(days[0].minutes).toBeCloseTo(90.5);
    expect(days[1].minutes).toBe(45);
    expect(days[1].entries.map((e) => e.id)).toEqual(['a', 'c']);
  });

  it('reads a timestamp-shaped date as its day and ignores a bad duration', () => {
    const days = groupEntriesByDay([entry('a', '2026-11-02T00:00:00.000Z', 'x')]);
    expect(days).toEqual([expect.objectContaining({ date: '2026-11-02', minutes: 0 })]);
  });
});
