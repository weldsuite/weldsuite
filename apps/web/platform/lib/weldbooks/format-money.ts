let iso4217Codes: Set<string> | null = null;

function supportedIso4217Codes(): Set<string> {
  if (iso4217Codes) return iso4217Codes;
  try {
    if (typeof Intl.supportedValuesOf === 'function') {
      iso4217Codes = new Set(Intl.supportedValuesOf('currency'));
      return iso4217Codes;
    }
  } catch {
    // Fall through to per-code Intl validation.
  }
  iso4217Codes = new Set();
  return iso4217Codes;
}

function isSupportedIso4217(code: string): boolean {
  if (!/^[A-Za-z]{3}$/.test(code)) return false;
  const upper = code.toUpperCase();
  const known = supportedIso4217Codes();
  if (known.size > 0) return known.has(upper);
  try {
    new Intl.NumberFormat('en', { style: 'currency', currency: upper }).format(0);
    return true;
  } catch {
    return false;
  }
}

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
  const code = currency && isSupportedIso4217(currency) ? currency.toUpperCase() : 'EUR';
  const loc = locale && locale.length > 0 ? locale : 'nl-NL';
  const amount = Number(value ?? 0);
  const safeAmount = Number.isFinite(amount) ? amount : 0;
  try {
    return new Intl.NumberFormat(loc, { style: 'currency', currency: code }).format(safeAmount);
  } catch {
    return new Intl.NumberFormat('nl-NL', { style: 'currency', currency: 'EUR' }).format(safeAmount);
  }
}
