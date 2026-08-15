const ISO_CURRENCY = /^[A-Za-z]{3}$/;

/**
 * Format a WeldBooks amount with the entity (or document) currency.
 *
 * Falls back to EUR only when the code is missing or not a valid ISO 4217
 * currency — never assume Euro just because the locale is nl-NL.
 */
export function formatWeldbooksMoney(
  value: number | string | null | undefined,
  currency?: string | null,
  locale?: string | null,
): string {
  const code = currency && ISO_CURRENCY.test(currency) ? currency.toUpperCase() : 'EUR';
  const loc = locale && locale.length > 0 ? locale : 'nl-NL';
  const amount = Number(value ?? 0);
  const safeAmount = Number.isFinite(amount) ? amount : 0;
  try {
    return new Intl.NumberFormat(loc, { style: 'currency', currency: code }).format(safeAmount);
  } catch {
    return new Intl.NumberFormat(loc, { style: 'currency', currency: 'EUR' }).format(safeAmount);
  }
}
