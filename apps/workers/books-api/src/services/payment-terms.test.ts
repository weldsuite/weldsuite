import { describe, expect, it } from 'vitest';
import { parseTermsDays } from './payment-terms';

describe('parseTermsDays', () => {
  it('reads days, net days and days with a unit', () => {
    expect(parseTermsDays('30')).toBe(30);
    expect(parseTermsDays(' Net 14 ')).toBe(14);
    expect(parseTermsDays('net30')).toBe(30);
    expect(parseTermsDays('45 days')).toBe(45);
    expect(parseTermsDays('1 day')).toBe(1);
  });

  it('refuses anything else, so the invoice falls back to 30 days', () => {
    expect(parseTermsDays(null)).toBeNull();
    expect(parseTermsDays('')).toBeNull();
    expect(parseTermsDays('end of month')).toBeNull();
    expect(parseTermsDays('0')).toBeNull();
    expect(parseTermsDays('30 weeks')).toBeNull();
    expect(parseTermsDays('12345')).toBeNull();
  });
});
