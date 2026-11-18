import { describe, expect, it } from 'vitest';
import { formatReportDuration } from './report';

/**
 * The same cases as `a_duration_never_shows_a_full_unit` in
 * rust/crates/emails/src/desk.rs: both backends format a report's durations alike.
 */
describe('formatReportDuration', () => {
  const en = (seconds: number) => formatReportDuration(seconds, 'en');

  it('writes seconds, minutes, hours and days', () => {
    expect(en(45)).toBe('45s');
    expect(en(-3)).toBe('0s');
    expect(en(1260)).toBe('21m');
    expect(en(3600)).toBe('1h');
    expect(en(15300)).toBe('4h 15m');
    expect(en(86_400)).toBe('1d');
    expect(en(183_600)).toBe('2d 3h');
    expect(formatReportDuration(15300, 'nl')).toBe('4u 15m');
  });

  it('turns a full minute into 1m', () => {
    expect(en(59)).toBe('59s');
    expect(en(59.4)).toBe('59s');
    expect(en(59.5)).toBe('1m');
    expect(en(60)).toBe('1m');
    expect(en(89)).toBe('1m');
    expect(en(90)).toBe('2m');
  });

  it('turns 59m 30s and up into an hour, never 60m', () => {
    expect(en(3569)).toBe('59m');
    expect(en(3570)).toBe('1h');
    expect(en(3599)).toBe('1h');
    expect(en(3600)).toBe('1h');
    expect(en(3629)).toBe('1h');
    expect(en(3630)).toBe('1h 1m');
    expect(en(7169)).toBe('1h 59m');
    expect(en(7170)).toBe('2h');
    expect(formatReportDuration(3599, 'nl')).toBe('1u');
  });

  it('turns 23h 59m 30s and up into a day, never 24h or 23h 60m', () => {
    expect(en(86_369)).toBe('23h 59m');
    expect(en(86_370)).toBe('1d');
    expect(en(86_399)).toBe('1d');
    expect(en(86_400)).toBe('1d');
    expect(en(89_999)).toBe('1d 1h');
    expect(formatReportDuration(86_399, 'nl')).toBe('1d');
  });

  it('keeps whole hours only next to days', () => {
    expect(en(169_200)).toBe('1d 23h');
    expect(en(172_799)).toBe('2d');
  });
});
