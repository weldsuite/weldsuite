import { addDays, isWeekend, isoWeek, monthGrid, monthWeeks, nextWeekday, parseIsoDate, startOfWeek, toIsoDate, todayIso, weekdaysBetween } from '../dates';

describe('ISO dates', () => {
  it('round-trips a local date', () => {
    expect(toIsoDate(new Date(2026, 2, 4))).toBe('2026-03-04');
    expect(parseIsoDate('2026-03-04')?.getDate()).toBe(4);
  });

  it('rejects strings that are not real calendar days', () => {
    expect(parseIsoDate('2026-02-30')).toBeNull();
    expect(parseIsoDate('4 March')).toBeNull();
    expect(parseIsoDate(null)).toBeNull();
  });

  it('adds days across month and year ends', () => {
    expect(addDays('2026-01-31', 1)).toBe('2026-02-01');
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
  });

  it('reads today from the given clock', () => {
    expect(todayIso(new Date(2026, 9, 24, 23, 59))).toBe('2026-10-24');
  });
});

describe('weekdaysBetween', () => {
  it('counts Monday to Friday, both ends included', () => {
    // 2026-10-19 is a Monday.
    expect(weekdaysBetween('2026-10-19', '2026-10-23')).toBe(5);
    expect(weekdaysBetween('2026-10-19', '2026-10-25')).toBe(5);
    expect(weekdaysBetween('2026-10-19', '2026-10-26')).toBe(6);
  });

  it('is zero for a weekend or a backwards range', () => {
    expect(weekdaysBetween('2026-10-24', '2026-10-25')).toBe(0);
    expect(weekdaysBetween('2026-10-23', '2026-10-19')).toBe(0);
    expect(isWeekend('2026-10-24')).toBe(true);
  });

  it('skips the weekend to the next working day', () => {
    expect(nextWeekday('2026-10-23')).toBe('2026-10-26');
    expect(nextWeekday('2026-10-24')).toBe('2026-10-26');
    expect(nextWeekday('2026-10-26')).toBe('2026-10-27');
  });
});

describe('monthGrid', () => {
  it('starts weeks on Monday and pads the edges', () => {
    // October 2026 starts on a Thursday and has 31 days.
    const weeks = monthGrid(2026, 9);
    expect(weeks[0]).toEqual([null, null, null, '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04']);
    expect(weeks.flat().filter(Boolean)).toHaveLength(31);
    expect(weeks.every((week) => week.length === 7)).toBe(true);
  });
});

describe('weeks', () => {
  it('finds the Monday of a week', () => {
    // 2026-10-25 is a Sunday, 2026-10-19 the Monday before.
    expect(startOfWeek('2026-10-25')).toBe('2026-10-19');
    expect(startOfWeek('2026-10-19')).toBe('2026-10-19');
    expect(startOfWeek('2026-11-01')).toBe('2026-10-26');
  });

  it('numbers weeks the ISO way', () => {
    expect(isoWeek('2026-10-25')).toBe(43);
    expect(isoWeek('2026-01-01')).toBe(1);
    expect(isoWeek('2027-01-01')).toBe(53);
    expect(isoWeek('2024-12-30')).toBe(1);
  });

  it('pads a month to whole weeks', () => {
    const weeks = monthWeeks('2026-10-25');
    expect(weeks[0][0]).toBe('2026-09-28');
    expect(weeks.at(-1)?.at(-1)).toBe('2026-11-01');
    expect(weeks).toHaveLength(5);
  });
});
