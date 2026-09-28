import { describe, expect, it } from 'vitest';
import { majorToCents, pickWholesaleMajor } from './phone-number-pricing';

describe('majorToCents', () => {
  it('rounds a major-unit amount to cents', () => {
    expect(majorToCents('5.00')).toBe(500);
    expect(majorToCents('1.5')).toBe(150);
  });

  it('returns 0 for missing or non-positive values', () => {
    expect(majorToCents('0')).toBe(0);
    expect(majorToCents(null)).toBe(0);
    expect(majorToCents('nope')).toBe(0);
  });
});

describe('pickWholesaleMajor', () => {
  it('prefers a positive catalog amount over live Telnyx', () => {
    expect(pickWholesaleMajor('3.00', '9.00')).toBe('3.00');
  });

  it('falls back to live Telnyx when catalog setup is zero', () => {
    expect(pickWholesaleMajor('0', '1.50')).toBe('1.50');
    expect(pickWholesaleMajor('0.00', '2.00')).toBe('2.00');
  });

  it('returns null when neither side has a price', () => {
    expect(pickWholesaleMajor('0', '0')).toBeNull();
    expect(pickWholesaleMajor(null, undefined)).toBeNull();
  });
});
