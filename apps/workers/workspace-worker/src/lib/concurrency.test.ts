import { describe, expect, it } from 'vitest';
import { mapWithConcurrency } from './concurrency';

describe('mapWithConcurrency', () => {
  it('keeps the order of the items and never exceeds the limit', async () => {
    let inFlight = 0;
    let peak = 0;
    const result = await mapWithConcurrency([5, 1, 4, 2, 3, 6, 7], 3, async (n) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, n));
      inFlight -= 1;
      return n * 10;
    });
    expect(result).toEqual([50, 10, 40, 20, 30, 60, 70]);
    expect(peak).toBe(3);
  });

  it('handles an empty list and a limit larger than the list', async () => {
    expect(await mapWithConcurrency([], 5, async (n: number) => n)).toEqual([]);
    expect(await mapWithConcurrency([1, 2], 50, async (n) => n + 1)).toEqual([2, 3]);
  });
});
