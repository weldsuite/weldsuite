import { describe, it, expect } from 'vitest';
import { getUtcOffset, TIMEZONES } from './timezones';

describe('getUtcOffset', () => {
  it('returns GMT+00:00 for UTC', () => {
    expect(getUtcOffset('UTC')).toMatch(/GMT[+-]?(00|0):?(00)?/);
  });

  it('handles an unknown timezone gracefully', () => {
    expect(getUtcOffset('Mars/Olympus_Mons')).toBe('GMT');
  });

  it('returns a GMT-prefixed string for valid IANA zones', () => {
    expect(getUtcOffset('Europe/Amsterdam')).toMatch(/^GMT/);
    expect(getUtcOffset('America/New_York')).toMatch(/^GMT/);
  });
});

describe('TIMEZONES list', () => {
  it('UTC is the first entry', () => {
    expect(TIMEZONES[0]?.id).toBe('UTC');
  });

  it('every entry has id + label', () => {
    for (const tz of TIMEZONES) {
      expect(tz.id.length).toBeGreaterThan(0);
      expect(tz.label).toContain(tz.id.replace(/_/g, ' '));
    }
  });

  it('contains common zones', () => {
    const ids = TIMEZONES.map((t) => t.id);
    expect(ids).toContain('Europe/Amsterdam');
    expect(ids).toContain('America/New_York');
  });
});
