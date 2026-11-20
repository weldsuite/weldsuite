/** The smallest of 1, 2, 2.5 and 5 times a power of ten that is at least `value`. */
function niceStep(value: number): number {
  const power = 10 ** Math.floor(Math.log10(value));
  const step = [1, 2, 2.5, 5, 10].find((f) => f * power >= value - 1e-9) ?? 10;
  return step * power;
}

/**
 * Round y-axis values (0, 10K, 20K, 30K) that take in `min` to `max` and zero:
 * 3 or 4 even steps (at most five labels in a card), whichever wastes the
 * least room above and below the data, 3 on a tie.
 * Nothing but zero gives just the zero line.
 */
export function niceTicks(min: number, max: number): number[] {
  const low = Math.min(0, min);
  const high = Math.max(0, max);
  if (high - low <= 0) return [0];
  const [best] = [3, 4]
    .map((intervals) => {
      const step = niceStep((high - low) / intervals);
      return { from: Math.floor(low / step) * step, to: Math.ceil(high / step) * step, step };
    })
    .sort((a, b) => a.to - a.from - (b.to - b.from));
  const count = Math.round((best.to - best.from) / best.step) + 1;
  // toPrecision drops float noise such as 0.30000000000000004.
  return Array.from({ length: count }, (_, i) => Number((best.from + i * best.step).toPrecision(12)));
}
