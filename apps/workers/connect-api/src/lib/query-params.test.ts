import { describe, it, expect } from 'vitest';
import { parseLimit } from './query-params';

describe('parseLimit', () => {
  it('uses the fallback when the value is missing, empty or not a number', () => {
    expect(parseLimit(undefined, 25, 100)).toBe(25);
    expect(parseLimit('', 25, 100)).toBe(25);
    expect(parseLimit('abc', 25, 100)).toBe(25);
    expect(parseLimit('NaN', 25, 100)).toBe(25);
  });

  it('clamps to 1..max', () => {
    expect(parseLimit('0', 25, 100)).toBe(1);
    expect(parseLimit('-5', 25, 100)).toBe(1);
    expect(parseLimit('7', 25, 100)).toBe(7);
    expect(parseLimit('100000', 25, 100)).toBe(100);
  });

  it('never returns more than max, even for the fallback', () => {
    expect(parseLimit(undefined, 25, 10)).toBe(10);
  });
});
