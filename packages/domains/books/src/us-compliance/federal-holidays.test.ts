import { describe, it, expect } from 'vitest';
import { addDays, addMonths, diffDays, isIsoDate, nthWeekdayOfMonth, lastWeekdayOfMonth, weekdayOf } from './dates';
import { isBusinessDay, isLegalHoliday, legalHolidays, rollToBusinessDay } from './federal-holidays';

describe('dates', () => {
  it('validates ISO dates', () => {
    expect(isIsoDate('2026-02-28')).toBe(true);
    expect(isIsoDate('2026-02-29')).toBe(false);
    expect(isIsoDate('2028-02-29')).toBe(true);
    expect(isIsoDate('2026-13-01')).toBe(false);
    expect(isIsoDate('26-01-01')).toBe(false);
  });

  it('does arithmetic on whole days without time zones', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2028-03-01', -1)).toBe('2028-02-29');
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonths('2026-11-15', 3)).toBe('2027-02-15');
    expect(addMonths('2026-03-31', -13)).toBe('2025-02-28');
    expect(diffDays('2026-01-01', '2027-01-01')).toBe(365);
    expect(weekdayOf('2027-01-31')).toBe(0);
  });

  it('finds nth and last weekdays', () => {
    expect(nthWeekdayOfMonth(2027, 2, 1, 3)).toBe('2027-02-15');
    expect(lastWeekdayOfMonth(2026, 5, 1)).toBe('2026-05-25');
  });
});

describe('legal holidays', () => {
  it('lists the 2026 holidays', () => {
    const dates = legalHolidays(2026).map((holiday) => holiday.date);
    expect(dates).toEqual([
      '2026-01-01',
      '2026-01-19',
      '2026-02-16',
      '2026-04-16',
      '2026-05-25',
      '2026-06-19',
      '2026-07-03', // 4 July is a Saturday: observed Friday
      '2026-09-07',
      '2026-10-12',
      '2026-11-11',
      '2026-11-26',
      '2026-12-25',
    ]);
  });

  it('observes a Sunday holiday on Monday and a Saturday holiday on Friday', () => {
    expect(isLegalHoliday('2023-01-02')).toBe(true); // 1 Jan 2023 is a Sunday
    expect(isLegalHoliday('2021-12-31')).toBe(true); // 1 Jan 2022 is a Saturday
    expect(isLegalHoliday('2022-01-03')).toBe(false);
  });

  it('includes Inauguration Day in inauguration years only', () => {
    expect(legalHolidays(2029).find((holiday) => holiday.name === 'Inauguration Day')?.date).toBe('2029-01-20'); // Saturday, not moved to Friday
    expect(legalHolidays(2037).some((holiday) => holiday.name === 'Inauguration Day')).toBe(true);
    expect(legalHolidays(2026).some((holiday) => holiday.name === 'Inauguration Day')).toBe(false);
  });

  it('rolls weekend and holiday due dates forward', () => {
    expect(rollToBusinessDay('2027-01-31')).toBe('2027-02-01'); // Sunday
    expect(rollToBusinessDay('2026-06-15')).toBe('2026-06-15'); // Monday
    expect(rollToBusinessDay('2027-02-15')).toBe('2027-02-16'); // Washington's Birthday
    expect(rollToBusinessDay('2026-09-15')).toBe('2026-09-15');
    expect(isBusinessDay('2026-11-26')).toBe(false);
  });

  it('moves the April deadline with DC Emancipation Day', () => {
    expect(rollToBusinessDay('2022-04-15')).toBe('2022-04-18'); // Emancipation Day observed Friday
    expect(rollToBusinessDay('2023-04-15')).toBe('2023-04-18'); // Saturday, Monday is the observed holiday
    expect(rollToBusinessDay('2028-04-15')).toBe('2028-04-18');
    expect(rollToBusinessDay('2026-04-15')).toBe('2026-04-15');
    expect(rollToBusinessDay('2025-04-15')).toBe('2025-04-15');
  });
});
