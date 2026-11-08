/** The usual currency of a country, used to prefill a new legal entity. Unlisted countries get EUR. */
const CURRENCY_BY_COUNTRY: Record<string, string> = {
  US: 'USD',
  GB: 'GBP',
  CH: 'CHF',
  SE: 'SEK',
  DK: 'DKK',
  NO: 'NOK',
  PL: 'PLN',
  CZ: 'CZK',
  CA: 'CAD',
  AU: 'AUD',
  JP: 'JPY',
  CN: 'CNY',
  IN: 'INR',
  BR: 'BRL',
};

export function defaultCurrencyForCountry(countryCode: string): string {
  return CURRENCY_BY_COUNTRY[countryCode.toUpperCase()] ?? 'EUR';
}
