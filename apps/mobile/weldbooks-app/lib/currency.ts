type NumericInput = number | string | null | undefined;

const currencyFormatters: Record<string, Intl.NumberFormat> = {};

/** A three-letter currency code `Intl` can be asked to format, e.g. `USD`. */
function usableCurrency(currency: string | null | undefined): string | null {
  return currency && /^[A-Za-z]{3}$/.test(currency) ? currency.toUpperCase() : null;
}

function formatter(currency: string | null, locale: string): Intl.NumberFormat {
  const key = `${currency ?? 'plain'}-${locale}`;
  if (!currencyFormatters[key]) {
    currencyFormatters[key] = currency
      ? new Intl.NumberFormat(locale, {
          style: 'currency',
          currency,
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        })
      : // No (or a malformed) currency code: show the figure rather than crash a list.
        new Intl.NumberFormat(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  return currencyFormatters[key];
}

/** Parse an app-api decimal string ("123.45") to a number, defaulting to 0. */
export function toNumber(value: NumericInput): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  const parsed = Number.parseFloat(String(value ?? '0'));
  return Number.isNaN(parsed) ? 0 : parsed;
}

/**
 * Money in the given currency and locale. Both are required: the entity (or the
 * document) decides them, and a default here would put euros on a US invoice.
 */
export function formatCurrency(amount: NumericInput, currency: string, locale: string): string {
  return formatter(usableCurrency(currency), locale).format(toNumber(amount));
}

/**
 * Abbreviated form for KPI tiles where the full figure would wrap. Falls back
 * to the full format below 1,000 so small balances stay exact.
 */
export function formatCompactCurrency(amount: NumericInput, currency: string, locale: string): string {
  const value = toNumber(amount);
  const abs = Math.abs(value);
  const code = usableCurrency(currency);
  if (abs >= 1_000 && code) {
    const compact = new Intl.NumberFormat(locale, {
      style: 'currency',
      currency: code,
      notation: 'compact',
      maximumFractionDigits: 1,
    });
    return compact.format(value);
  }
  return formatCurrency(value, currency, locale);
}

/**
 * Parse user input in either European (1.234,56) or US (1,234.56) format.
 *
 * A lone separator with three digits after it ("1,234") is ambiguous: it is a
 * thousands separator in US format and a decimal comma in European format. The
 * `locale` the user is working in settles it; without one the comma is read as
 * a decimal (what a Dutch keypad types).
 */
export function parseAmount(value: string, locale?: string): number {
  const cleaned = value.replaceAll(/[^\d.,-]/g, '');
  const usesDecimalPoint = !!locale && /^en([-_]|$)/i.test(locale);

  if (usesDecimalPoint && /^-?\d{1,3}(,\d{3})+$/.test(cleaned)) {
    const parsed = Number.parseFloat(cleaned.replaceAll(',', ''));
    return Number.isNaN(parsed) ? 0 : parsed;
  }
  // Comma acts as the decimal separator when it is the last separator present.
  if (
    cleaned.includes(',') &&
    (!cleaned.includes('.') || cleaned.lastIndexOf(',') > cleaned.lastIndexOf('.'))
  ) {
    const parsed = Number.parseFloat(cleaned.replaceAll('.', '').replace(',', '.'));
    return Number.isNaN(parsed) ? 0 : parsed;
  }
  const parsed = Number.parseFloat(cleaned.replaceAll(',', ''));
  return Number.isNaN(parsed) ? 0 : parsed;
}

/** Percentage with one decimal, e.g. "12.5%". */
export function formatPercent(value: number, fractionDigits = 1): string {
  if (!Number.isFinite(value)) return '0%';
  return `${value.toFixed(fractionDigits)}%`;
}
