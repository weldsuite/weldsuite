import { describe, it, expect } from 'vitest';
import { meterPercent, meterTone } from './usage-meter';

describe('meterPercent', () => {
  it('is the used share of the limit, rounded and capped at 100', () => {
    expect(meterPercent(0, 150)).toBe(0);
    expect(meterPercent(75, 150)).toBe(50);
    expect(meterPercent(1, 3)).toBe(33);
    expect(meterPercent(150, 150)).toBe(100);
    expect(meterPercent(400, 150)).toBe(100);
  });

  it('is empty without a limit', () => {
    expect(meterPercent(9999, null)).toBe(0);
  });

  it('treats a limit of zero as full once anything was used', () => {
    expect(meterPercent(0, 0)).toBe(0);
    expect(meterPercent(3, 0)).toBe(100);
  });
});

describe('meterTone', () => {
  it('is ok well under the limit', () => {
    expect(meterTone(0, 100)).toBe('ok');
    expect(meterTone(79, 100)).toBe('ok');
  });

  it('warns from 80% of the limit', () => {
    expect(meterTone(80, 100)).toBe('warning');
    expect(meterTone(99, 100)).toBe('warning');
  });

  it('is full at and over the limit', () => {
    expect(meterTone(100, 100)).toBe('full');
    expect(meterTone(130, 100)).toBe('full');
  });

  it('is never full without a limit', () => {
    expect(meterTone(1_000_000, null)).toBe('ok');
  });

  it('handles a limit of zero', () => {
    expect(meterTone(0, 0)).toBe('ok');
    expect(meterTone(1, 0)).toBe('full');
  });
});
