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

function usableLocale(locale: string | null | undefined): string | undefined {
  if (!locale) return undefined;
  try {
    return Intl.NumberFormat.supportedLocalesOf([locale]).length > 0 ? locale : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Format a WeldBooks amount with the entity (or document) currency and the
 * entity locale.
 *
 * Never assumes a currency: when the code is missing or not a valid ISO 4217
 * currency the amount is shown as a plain number with two decimals. A missing
 * or malformed locale falls back to the browser's.
 */
export function formatWeldbooksMoney(
  value: number | string | null | undefined,
  currency?: string | null,
  locale?: string | null,
): string {
  const code = currency && isSupportedIso4217(currency) ? currency.toUpperCase() : null;
  const loc = usableLocale(locale);
  const amount = Number(value ?? 0);
  const safeAmount = Number.isFinite(amount) ? amount : 0;
  if (!code) {
    return new Intl.NumberFormat(loc, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(safeAmount);
  }
  return new Intl.NumberFormat(loc, { style: 'currency', currency: code }).format(safeAmount);
}
