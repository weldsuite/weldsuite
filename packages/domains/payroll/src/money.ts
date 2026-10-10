/**
 * Money in the payroll engines is integer cents. Decimal strings from the
 * database (`numeric`) come in through `toCents` and go out through
 * `fromCents`; nothing in between uses floating-point euros or dollars.
 *
 * Rounding follows the tax rules that apply, so each helper names its rule
 * instead of a generic `round`.
 */

export type Cents = number;

/** `"1234.56"` / `1234.56` → `123456`. Half away from zero on the third decimal. */
export function toCents(value: string | number | null | undefined): Cents {
  if (value === null || value === undefined || value === '') return 0;
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) throw new Error(`Not an amount: ${String(value)}`);
  return roundHalfAwayFromZero(n * 100);
}

/** `123456` → `"1234.56"` (for numeric columns and files). */
export function fromCents(cents: Cents): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(Math.trunc(cents));
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/** Commercial rounding to a whole number; the 1e-9 nudge absorbs binary noise (2.675 * 100). */
export function roundHalfAwayFromZero(n: number): number {
  return n >= 0 ? Math.floor(n + 0.5 + 1e-9) : -Math.floor(-n + 0.5 + 1e-9);
}

/** Round down to whole cents (toward zero for positives). */
export function floorCents(n: number): Cents {
  return n >= 0 ? Math.floor(n + 1e-9) : -Math.ceil(-n - 1e-9);
}

/** Round down to whole currency units (euros/dollars), in cents. */
export function floorToUnit(cents: Cents): Cents {
  return Math.floor(cents / 100 + 1e-9) * 100;
}

/** `rate` percent of `cents`, rounded half away from zero. */
export function percentOf(cents: Cents, ratePercent: number): Cents {
  return roundHalfAwayFromZero((cents * ratePercent) / 100);
}

export function sum(values: Iterable<Cents>): Cents {
  let total = 0;
  for (const v of values) total += v;
  return total;
}

export function clamp(cents: Cents, min: Cents, max: Cents): Cents {
  return Math.min(Math.max(cents, min), max);
}
