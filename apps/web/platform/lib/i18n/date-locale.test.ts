import { describe, expect, it } from 'vitest';
import { formatMediumDate, formatMonthYear, formatShortDate, getDateFnsLocale, getIntlLocale } from './date-locale';

const date = new Date(2026, 9, 12, 12, 0, 0);

describe('date-locale', () => {
  it('formats in the selected language', () => {
    expect(formatShortDate(date, 'en')).toBe('Oct 12');
    expect(formatShortDate(date, 'nl')).toMatch(/12 okt/);
    expect(formatMediumDate(date, 'en')).toBe('Oct 12, 2026');
    expect(formatMediumDate(date, 'nl')).toMatch(/12 okt\.? 2026/);
    expect(formatMonthYear(date, 'nl')).toMatch(/okt/);
  });

  it('returns an empty string for missing or invalid dates', () => {
    expect(formatShortDate(null, 'en')).toBe('');
    expect(formatMediumDate('not a date', 'nl')).toBe('');
  });

  it('maps languages to locales', () => {
    expect(getIntlLocale('nl')).toBe('nl-NL');
    expect(getDateFnsLocale('nl').code).toBe('nl');
    expect(getDateFnsLocale('en').code).toBe('en-US');
  });
});
