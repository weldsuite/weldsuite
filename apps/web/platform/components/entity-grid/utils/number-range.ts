/**
 * The Min / Max a Number custom field is configured with, enforced where its
 * value is edited (grid cell, record panel). 150 and -5 used to be saved into
 * a 0–100 field (TASK-1462).
 */

export interface NumberRange {
  min?: number;
  max?: number;
}

type Translate = (path: string, params?: Record<string, unknown>) => string;

/** Why `value` is refused, or `null` when it fits the range. */
export function numberRangeError(value: number, range: NumberRange, t: Translate): string | null {
  const { min, max } = range;
  const tooLow = min !== undefined && value < min;
  const tooHigh = max !== undefined && value > max;
  if (!tooLow && !tooHigh) return null;
  if (min !== undefined && max !== undefined) return t('sweep.entities.numberBetween', { min, max });
  if (min !== undefined) return t('sweep.entities.numberAtLeast', { min });
  return t('sweep.entities.numberAtMost', { max });
}
