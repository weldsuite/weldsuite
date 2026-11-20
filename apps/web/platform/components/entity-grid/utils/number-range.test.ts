import { describe, expect, it } from 'vitest';
import { numberRangeError } from './number-range';

const t = (path: string, params?: Record<string, unknown>) => `${path}:${JSON.stringify(params ?? {})}`;

describe('numberRangeError (TASK-1462)', () => {
  it('accepts a value inside the range, or any value without one', () => {
    expect(numberRangeError(50, { min: 0, max: 100 }, t)).toBeNull();
    expect(numberRangeError(0, { min: 0, max: 100 }, t)).toBeNull();
    expect(numberRangeError(100, { min: 0, max: 100 }, t)).toBeNull();
    expect(numberRangeError(-5, {}, t)).toBeNull();
  });

  it('refuses 150 and -5 for a 0–100 field', () => {
    expect(numberRangeError(150, { min: 0, max: 100 }, t)).toBe('sweep.entities.numberBetween:{"min":0,"max":100}');
    expect(numberRangeError(-5, { min: 0, max: 100 }, t)).toBe('sweep.entities.numberBetween:{"min":0,"max":100}');
  });

  it('names the one bound that is set', () => {
    expect(numberRangeError(-1, { min: 0 }, t)).toBe('sweep.entities.numberAtLeast:{"min":0}');
    expect(numberRangeError(11, { max: 10 }, t)).toBe('sweep.entities.numberAtMost:{"max":10}');
  });
});
