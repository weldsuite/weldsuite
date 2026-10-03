import { describe, it, expect } from 'vitest';
import { defaultQuickCreateRange, shiftEndDate } from './quick-create-dates';

describe('defaultQuickCreateRange', () => {
  it('starts at the next full hour and lasts an hour', () => {
    expect(defaultQuickCreateRange(undefined, undefined, new Date(2026, 9, 2, 14, 20))).toEqual({
      startDate: '2026-10-02',
      startTime: '15:00',
      endDate: '2026-10-02',
      endTime: '16:00',
    });
  });

  it('rolls over to tomorrow late in the evening instead of a time that already passed', () => {
    expect(defaultQuickCreateRange(undefined, undefined, new Date(2026, 9, 2, 23, 25))).toEqual({
      startDate: '2026-10-03',
      startTime: '00:00',
      endDate: '2026-10-03',
      endTime: '01:00',
    });
  });

  it('ends after midnight on the next day for a late start', () => {
    expect(defaultQuickCreateRange(undefined, undefined, new Date(2026, 9, 2, 22, 40))).toEqual({
      startDate: '2026-10-02',
      startTime: '23:00',
      endDate: '2026-10-03',
      endTime: '00:00',
    });
  });

  it('uses the given start and end', () => {
    const range = defaultQuickCreateRange(new Date(2026, 9, 5, 10, 0), new Date(2026, 9, 5, 11, 30));
    expect(range).toEqual({ startDate: '2026-10-05', startTime: '10:00', endDate: '2026-10-05', endTime: '11:30' });
  });

  it('makes a given start without an end one hour long', () => {
    const range = defaultQuickCreateRange(new Date(2026, 9, 5, 23, 30));
    expect(range).toEqual({ startDate: '2026-10-05', startTime: '23:30', endDate: '2026-10-06', endTime: '00:30' });
  });
});

describe('shiftEndDate', () => {
  it('moves the end date by as many days as the start date moved', () => {
    expect(shiftEndDate('2026-10-02', '2026-10-05', '2026-10-02')).toBe('2026-10-05');
    expect(shiftEndDate('2026-10-02', '2026-10-05', '2026-10-03')).toBe('2026-10-06');
    expect(shiftEndDate('2026-10-05', '2026-10-01', '2026-10-05')).toBe('2026-10-01');
  });

  it('leaves the end date alone when the start date did not change', () => {
    expect(shiftEndDate('2026-10-02', '2026-10-02', '2026-10-04')).toBe('2026-10-04');
  });
});
