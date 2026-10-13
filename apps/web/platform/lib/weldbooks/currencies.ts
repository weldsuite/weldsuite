/** Currencies a WeldBooks document can be issued in (the ECB reference set the rates come from, plus INR). */
export const DOCUMENT_CURRENCIES = [
  'EUR',
  'USD',
  'GBP',
  'CHF',
  'SEK',
  'DKK',
  'NOK',
  'PLN',
  'CZK',
  'CAD',
  'AUD',
  'JPY',
  'CNY',
  'INR',
] as const;

/** The listed currencies, with any other code in use (a contact's, an older document's) kept selectable. */
export function currencyOptions(...inUse: Array<string | null | undefined>): string[] {
  const extra = inUse
    .map((code) => code?.toUpperCase())
    .filter((code): code is string => Boolean(code) && !(DOCUMENT_CURRENCIES as readonly string[]).includes(code as string));
  return [...new Set([...extra, ...DOCUMENT_CURRENCIES])];
}

/** True when a document in `currency` needs an exchange rate against the entity's base currency. */
export function isForeignCurrency(baseCurrency: string | null | undefined, currency: string | null | undefined): boolean {
  return Boolean(baseCurrency) && Boolean(currency) && baseCurrency!.toUpperCase() !== currency!.toUpperCase();
}

/**
 * The exchange rate field: empty = look the rate up for the document date, else a number above
 * zero (foreign units per base unit, 1 EUR = 1.08 USD is 1.08). `undefined` when the text is not one.
 */
export function parseExchangeRateInput(text: string | null | undefined): number | null | undefined {
  const value = (text ?? '').trim().replace(',', '.');
  if (value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * The exchange rate of a document as a payload field: the typed rate; `null` when the user emptied a
 * field that held one (the server looks the rate up again); otherwise nothing (the server keeps the
 * stored rate, or looks one up for a new document).
 */
export function exchangeRatePayload(
  text: string | null | undefined,
  resetToAutomatic = false,
): { exchangeRate?: string | null } {
  const parsed = parseExchangeRateInput(text);
  if (typeof parsed === 'number') return { exchangeRate: String(parsed) };
  return resetToAutomatic ? { exchangeRate: null } : {};
}
