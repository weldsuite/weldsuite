import { describe, expect, it } from 'vitest';
import { formatHoursDecimalAsHm, formatHoursMinutes } from './format-hours';

describe('formatHoursMinutes', () => {
  it('shows hours and minutes', () => {
    expect(formatHoursMinutes(135)).toBe('2h 15m');
  });

  it('drops the zero part', () => {
    expect(formatHoursMinutes(45)).toBe('45m');
    expect(formatHoursMinutes(180)).toBe('3h');
  });

  it('keeps a one-minute timer visible instead of rounding to 0h', () => {
    expect(formatHoursMinutes(1)).toBe('1m');
  });

  it('is safe for empty and invalid values', () => {
    expect(formatHoursMinutes(0)).toBe('0m');
    expect(formatHoursMinutes(Number.NaN)).toBe('0m');
    expect(formatHoursMinutes(-5)).toBe('0m');
  });

  it('rounds fractional minutes', () => {
    expect(formatHoursMinutes(59.6)).toBe('1h');
  });
});

describe('formatHoursDecimalAsHm', () => {
  it('converts decimal hours', () => {
    expect(formatHoursDecimalAsHm(2.25)).toBe('2h 15m');
    expect(formatHoursDecimalAsHm(0.5)).toBe('30m');
  });
});
