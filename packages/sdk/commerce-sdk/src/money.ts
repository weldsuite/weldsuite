/**
 * Money helpers. The API sends amounts as decimal strings ("19.99"); these
 * format and compare them without turning them into floats.
 */

const AMOUNT = /^(-)?(\d+)(?:\.(\d+))?$/;

function parts(amount: string): { negative: boolean; whole: string; fraction: string } {
  const match = AMOUNT.exec(amount.trim());
  if (!match) throw new TypeError(`Not a decimal amount: "${amount}"`);
  return { negative: match[1] === '-', whole: match[2] ?? '0', fraction: match[3] ?? '' };
}

/**
 * An amount in minor units (cents for EUR): `toMinorUnits("19.99")` is
 * `1999n`. Extra decimals beyond `decimals` must be zeros.
 */
export function toMinorUnits(amount: string, decimals = 2): bigint {
  const { negative, whole, fraction } = parts(amount);
  if (fraction.length > decimals && /[^0]/.test(fraction.slice(decimals))) {
    throw new TypeError(`"${amount}" has more than ${decimals} decimals`);
  }
  const padded = (fraction + '0'.repeat(decimals)).slice(0, decimals);
  const value = BigInt(whole + padded);
  return negative ? -value : value;
}

/** The decimal string of an amount in minor units: `fromMinorUnits(1999n)` is "19.99". */
export function fromMinorUnits(minor: bigint, decimals = 2): string {
  const negative = minor < 0n;
  const digits = (negative ? -minor : minor).toString().padStart(decimals + 1, '0');
  const whole = digits.slice(0, digits.length - decimals);
  const fraction = digits.slice(digits.length - decimals);
  const sign = negative ? '-' : '';
  return decimals > 0 ? `${sign}${whole}.${fraction}` : `${sign}${whole}`;
}

/** -1, 0 or 1, like a sort comparator: `compareMoney("9.50", "10.00")` is -1. */
export function compareMoney(a: string, b: string): -1 | 0 | 1 {
  const x = toMinorUnits(a, 6);
  const y = toMinorUnits(b, 6);
  if (x < y) return -1;
  return x > y ? 1 : 0;
}

/** Whether the amount is zero ("0.00"). */
export function isZeroMoney(amount: string): boolean {
  return toMinorUnits(amount, 6) === 0n;
}

export interface FormatMoneyOptions {
  /** A BCP 47 locale, e.g. "nl-NL". Defaults to the runtime's locale. */
  locale?: string | string[];
  /** How the currency shows: "symbol" (€, the default), "narrowSymbol", "code" (EUR) or "name". */
  currencyDisplay?: 'symbol' | 'narrowSymbol' | 'code' | 'name';
}

const formatters = new Map<string, Intl.NumberFormat>();

function formatter(currency: string, options: FormatMoneyOptions): Intl.NumberFormat {
  const key = `${currency}|${String(options.locale ?? '')}|${options.currencyDisplay ?? ''}`;
  let found = formatters.get(key);
  if (!found) {
    found = new Intl.NumberFormat(options.locale, {
      style: 'currency',
      currency,
      currencyDisplay: options.currencyDisplay ?? 'symbol',
    });
    formatters.set(key, found);
  }
  return found;
}

/**
 * Format an amount for display: `formatMoney("1234.5", "EUR", { locale: "nl-NL" })`
 * is "€ 1.234,50". The decimal string goes to `Intl.NumberFormat` as is, so
 * no float rounding creeps in.
 */
export function formatMoney(amount: string, currency: string, options: FormatMoneyOptions = {}): string {
  parts(amount);
  // Intl.NumberFormat formats a decimal string exactly (ES2023); older
  // engines read it as a number, which is exact for 2-decimal amounts.
  return formatter(currency, options).format(amount.trim() as unknown as number);
}

/** A formatter bound to one currency and locale, for lists of amounts. */
export function createMoneyFormatter(
  currency: string,
  options: FormatMoneyOptions = {},
): (amount: string) => string {
  return (amount) => formatMoney(amount, currency, options);
}

/**
 * Format a tax rate ("21.00", "5.50") as a percentage: "21%", "5.5%" (or the
 * locale's form, e.g. "21 %" in French).
 */
export function formatTaxRate(rate: string, locale?: string | string[]): string {
  const { negative, whole, fraction } = parts(rate);
  // Move the decimal point two places left on the digits, not with a division.
  const digits = whole.padStart(3, '0') + fraction;
  const point = whole.padStart(3, '0').length - 2;
  const ratio = `${negative ? '-' : ''}${digits.slice(0, point)}.${digits.slice(point)}`;
  return new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 2 }).format(
    ratio as unknown as number,
  );
}
