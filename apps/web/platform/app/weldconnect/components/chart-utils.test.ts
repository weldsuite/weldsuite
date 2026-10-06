import { describe, expect, it } from 'vitest';
import { formatTrendLabel, formatTrendTick, mapPeriodToApi, parseTrendDate } from './chart-utils';

describe('mapPeriodToApi', () => {
  it('maps every selector value to its own trends period', () => {
    expect(mapPeriodToApi('today')).toBe('day');
    expect(mapPeriodToApi('weekly')).toBe('week');
    expect(mapPeriodToApi('monthly')).toBe('month');
    expect(mapPeriodToApi('yearly')).toBe('year');
  });
});

describe('parseTrendDate', () => {
  it('keeps a date-only bucket on its own calendar day', () => {
    const date = parseTrendDate('2026-10-01');
    expect([date.getFullYear(), date.getMonth(), date.getDate()]).toEqual([2026, 9, 1]);
  });
});

describe('trend formatting', () => {
  it('shows month names for the yearly view, in the given locale', () => {
    expect(formatTrendTick('2026-03-01', 'year', 'en-US')).toBe('Mar');
    expect(formatTrendTick('2026-03-01', 'year', 'nl-NL')).toBe('mrt');
    expect(formatTrendLabel('2026-03-01', 'year', 'en-US')).toBe('March 2026');
  });

  it('shows day and month for the other views', () => {
    expect(formatTrendTick('2026-10-06', 'week', 'en-US')).toBe('Oct 6');
    expect(formatTrendLabel('2026-10-06', 'week', 'en-US')).toBe('Oct 6, 2026');
  });
});
