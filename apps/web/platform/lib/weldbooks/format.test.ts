import { describe, expect, it } from 'vitest';
import {
  addDaysToIsoDate,
  formatWeldbooksDate,
  formatWeldbooksMonth,
  isExplicitDatePattern,
  localToday,
  toCalendarDate,
  weldbooksDateLocale,
} from './format';

describe('localToday', () => {
  it('uses the local calendar day, not the UTC one', () => {
    // 23:30 on 4 October in a UTC-7 browser is already 5 October in UTC.
    const now = new Date(2026, 9, 4, 23, 30);
    expect(localToday(null, now)).toBe('2026-10-04');
  });

  it('follows an explicit time zone', () => {
    const instant = new Date('2026-10-04T23:30:00Z');
    expect(localToday('Europe/Amsterdam', instant)).toBe('2026-10-05');
    expect(localToday('America/Los_Angeles', instant)).toBe('2026-10-04');
  });
});

describe('addDaysToIsoDate', () => {
  it('rolls over months and years', () => {
    expect(addDaysToIsoDate('2026-12-15', 30)).toBe('2027-01-14');
    expect(addDaysToIsoDate('2026-03-01', -1)).toBe('2026-02-28');
  });
});

describe('toCalendarDate', () => {
  it('keeps the written day of date-only strings and UTC midnight timestamps', () => {
    expect(toCalendarDate('2026-10-04')).toBe('2026-10-04');
    expect(toCalendarDate('2026-10-04T00:00:00.000Z')).toBe('2026-10-04');
  });

  it('returns null for empty or invalid values', () => {
    expect(toCalendarDate(null)).toBeNull();
    expect(toCalendarDate('')).toBeNull();
    expect(toCalendarDate('not a date')).toBeNull();
  });
});

describe('formatWeldbooksDate', () => {
  it('uses the medium style of the locale when no explicit pattern is set', () => {
    expect(formatWeldbooksDate('2026-10-04', { locale: 'en-US' })).toBe('Oct 4, 2026');
    expect(formatWeldbooksDate('2026-10-04T00:00:00.000Z', { locale: 'en-US' })).toBe('Oct 4, 2026');
  });

  it('applies an explicit date pattern preference', () => {
    expect(formatWeldbooksDate('2026-10-04', { dateFormat: 'DD-MM-YYYY' })).toBe('04-10-2026');
    expect(formatWeldbooksDate('2026-10-04', { dateFormat: 'YYYY/MM/DD' })).toBe('2026/10/04');
  });

  it('treats the column default MM/DD/YYYY as no preference', () => {
    expect(formatWeldbooksDate('2026-10-04', { dateFormat: 'MM/DD/YYYY', locale: 'en-US' })).toBe('Oct 4, 2026');
  });

  it('shows a dash for empty values', () => {
    expect(formatWeldbooksDate(null)).toBe('—');
    expect(formatWeldbooksDate(undefined, { empty: '-' })).toBe('-');
  });
});

describe('isExplicitDatePattern', () => {
  it('accepts complete patterns only', () => {
    expect(isExplicitDatePattern('DD.MM.YYYY')).toBe(true);
    expect(isExplicitDatePattern('DD-DD-YYYY')).toBe(false);
    expect(isExplicitDatePattern('D/M/YY')).toBe(false);
    expect(isExplicitDatePattern(null)).toBe(false);
  });
});

describe('weldbooksDateLocale', () => {
  it('combines the UI language with the entity region', () => {
    expect(weldbooksDateLocale('en', 'nl-NL')).toBe('en-NL');
    expect(weldbooksDateLocale('nl', 'en-US')).toBe('nl-US');
  });

  it('falls back to what is available', () => {
    expect(weldbooksDateLocale(undefined, 'en-IN')).toBe('en-IN');
    expect(weldbooksDateLocale('en', undefined)).toBe('en');
  });
});

describe('formatWeldbooksMonth', () => {
  it('labels the month of a calendar date', () => {
    expect(formatWeldbooksMonth('2026-10-31', { locale: 'en-US' })).toBe('October 2026');
  });
});
