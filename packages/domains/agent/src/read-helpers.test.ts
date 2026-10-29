import { describe, expect, it } from 'vitest';
import { dueCutoff, taskAssigneeIds, todayIn } from './read-helpers';

describe('dueCutoff', () => {
  const at = (input: string, zone: string | null) => dueCutoff(input, zone)?.at.toISOString();

  it('takes a plain date as that whole day: the bound is the next local midnight, exclusive', () => {
    expect(dueCutoff('2026-10-27', 'UTC')).toEqual({ at: new Date('2026-10-28T00:00:00.000Z'), inclusive: false });
  });

  it('cuts the day in the person\'s time zone, not at UTC midnight', () => {
    // Amsterdam is UTC+1 on 27 October 2026 (summer time ended on the 25th).
    expect(at('2026-10-27', 'Europe/Amsterdam')).toBe('2026-10-27T23:00:00.000Z');
    // Los Angeles is still on summer time (UTC-7).
    expect(at('2026-10-27', 'America/Los_Angeles')).toBe('2026-10-28T07:00:00.000Z');
    // Auckland is UTC+13: its day ends before the UTC day does (the zones past UTC+12 are the awkward ones).
    expect(at('2026-10-27', 'Pacific/Auckland')).toBe('2026-10-27T11:00:00.000Z');
    expect(at('2026-10-27', 'Pacific/Kiritimati')).toBe('2026-10-27T10:00:00.000Z');
  });

  it('survives the day the clocks change', () => {
    // 25 October 2026 is 25 hours long in Amsterdam; the day still ends at the next local midnight.
    expect(at('2026-10-25', 'Europe/Amsterdam')).toBe('2026-10-25T23:00:00.000Z');
    expect(at('2026-03-29', 'Europe/Amsterdam')).toBe('2026-03-29T22:00:00.000Z');
  });

  it('falls back to UTC for a missing or unknown zone', () => {
    expect(at('2026-10-27', null)).toBe('2026-10-28T00:00:00.000Z');
    expect(at('2026-10-27', 'Mars/Olympus')).toBe('2026-10-28T00:00:00.000Z');
  });

  it('takes a date-time as an exact instant, inclusive', () => {
    expect(dueCutoff('2026-10-27T15:30:00Z', 'Europe/Amsterdam')).toEqual({
      at: new Date('2026-10-27T15:30:00.000Z'),
      inclusive: true,
    });
  });

  it('refuses what is not a date', () => {
    expect(dueCutoff('next friday', 'UTC')).toBeNull();
    expect(dueCutoff('2026-02-31', 'UTC')).toBeNull();
    expect(dueCutoff('2026-13-01', 'UTC')).toBeNull();
    expect(dueCutoff('', 'UTC')).toBeNull();
  });
});

describe('todayIn', () => {
  it('reads today on the wall clock of the person\'s zone', () => {
    const now = new Date('2026-10-26T23:30:00Z');
    expect(todayIn('UTC', now)).toBe('2026-10-26');
    expect(todayIn('Europe/Amsterdam', now)).toBe('2026-10-27');
    expect(todayIn('America/Los_Angeles', now)).toBe('2026-10-26');
    expect(todayIn(null, now)).toBe('2026-10-26');
    expect(todayIn('Mars/Olympus', now)).toBe('2026-10-26');
  });
});

describe('taskAssigneeIds', () => {
  it('lists the primary assignee and the others once each', () => {
    expect(taskAssigneeIds({ assigneeId: 'a', assigneeIds: ['a', 'b', 'b'] })).toEqual(['a', 'b']);
    expect(taskAssigneeIds({ assigneeId: null, assigneeIds: ['c'] })).toEqual(['c']);
    expect(taskAssigneeIds({ assigneeId: null, assigneeIds: null })).toEqual([]);
  });
});
