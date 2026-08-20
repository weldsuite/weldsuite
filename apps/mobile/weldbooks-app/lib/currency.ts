const currencyFormatters: Record<string, Intl.NumberFormat> = {};

function formatter(currency: string, locale: string): Intl.NumberFormat {
  const key = `${currency}-${locale}`;
  if (!currencyFormatters[key]) {
    currencyFormatters[key] = new Intl.NumberFormat(locale, {
      style: 'currency',
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  }
  return currencyFormatters[key];
}

/** Parse an app-api decimal string ("123.45") to a number, defaulting to 0. */
export function toNumber(value: number | string | null | undefined): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  const parsed = parseFloat(String(value ?? '0'));
  return Number.isNaN(parsed) ? 0 : parsed;
}

export function formatCurrency(
  amount: number | string | null | undefined,
  currency = 'EUR',
  locale = 'nl-NL',
): string {
  return formatter(currency, locale).format(toNumber(amount));
}

/**
 * Abbreviated form for KPI tiles where the full figure would wrap. Falls back
 * to the full format below 1,000 so small balances stay exact.
 */
export function formatCompactCurrency(
  amount: number | string | null | undefined,
  currency = 'EUR',
  locale = 'nl-NL',
): string {
  const value = toNumber(amount);
  const abs = Math.abs(value);
  if (abs >= 1_000) {
    const compact = new Intl.NumberFormat(locale, {
      style: 'currency',
      currency,
      notation: 'compact',
      maximumFractionDigits: 1,
    });
    return compact.format(value);
  }
  return formatCurrency(value, currency, locale);
}

/** Parse user input in either European (1.234,56) or US (1,234.56) format. */
export function parseAmount(value: string): number {
  const cleaned = value.replace(/[^\d.,-]/g, '');
  // Comma acts as the decimal separator when it is the last separator present.
  if (
    cleaned.includes(',') &&
    (!cleaned.includes('.') || cleaned.lastIndexOf(',') > cleaned.lastIndexOf('.'))
  ) {
    const parsed = parseFloat(cleaned.replace(/\./g, '').replace(',', '.'));
    return Number.isNaN(parsed) ? 0 : parsed;
  }
  const parsed = parseFloat(cleaned.replace(/,/g, ''));
  return Number.isNaN(parsed) ? 0 : parsed;
}

/** Percentage with one decimal, e.g. "12.5%". */
export function formatPercent(value: number, fractionDigits = 1): string {
  if (!Number.isFinite(value)) return '0%';
  return `${value.toFixed(fractionDigits)}%`;
}
