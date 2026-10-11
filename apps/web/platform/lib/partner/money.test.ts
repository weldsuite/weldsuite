import { describe, expect, it } from 'vitest';
import { formatPercentBps } from './money';

describe('formatPercentBps', () => {
  it('prints whole percentages without decimals', () => {
    expect(formatPercentBps(2000)).toBe('20');
    expect(formatPercentBps(0)).toBe('0');
  });

  it('trims trailing zeros of fractional percentages', () => {
    expect(formatPercentBps(1250)).toBe('12.5');
    expect(formatPercentBps(1205)).toBe('12.05');
    expect(formatPercentBps(1210)).toBe('12.1');
  });

  it('drops a dangling decimal point when rounding lands on a whole number', () => {
    expect(formatPercentBps(1000.1)).toBe('10');
    expect(formatPercentBps(0.1)).toBe('0');
  });
});
