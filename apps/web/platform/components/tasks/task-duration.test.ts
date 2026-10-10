import { describe, expect, it } from 'vitest';
import { DURATION_PRESETS, formatMinutes, parseDurationMinutes } from './task-duration';

describe('formatMinutes', () => {
  it('reads minutes under an hour as minutes, and longer ones as hours + remainder', () => {
    expect(formatMinutes(30)).toBe('30m');
    expect(formatMinutes(60)).toBe('1h');
    expect(formatMinutes(90)).toBe('1h 30m');
    expect(formatMinutes(120)).toBe('2h');
  });

  it('formats every preset', () => {
    expect(DURATION_PRESETS.map(formatMinutes)).toEqual(['15m', '30m', '45m', '1h', '1h 30m', '2h']);
  });
});

describe('parseDurationMinutes', () => {
  it('accepts positive whole numbers', () => {
    expect(parseDurationMinutes('45')).toBe(45);
    expect(parseDurationMinutes(' 7 ')).toBe(7);
  });

  it('treats blank, zero, negative and non-numeric input as "no duration"', () => {
    expect(parseDurationMinutes('')).toBeNull();
    expect(parseDurationMinutes('0')).toBeNull();
    expect(parseDurationMinutes('-5')).toBeNull();
    expect(parseDurationMinutes('abc')).toBeNull();
  });
});
