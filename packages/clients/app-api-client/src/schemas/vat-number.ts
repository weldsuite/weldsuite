// ============================================================================
// VAT / tax ID format check — shared by the platform (Business settings and the
// Billing details dialog) and app-api (`PUT /api/workspace-settings`), so the
// client and the server accept exactly the same values.
//
// A format check only says the number could exist: the right country prefix,
// length and characters. It does not say the number is registered (that is a
// VIES lookup, which WeldBooks does in `@weldsuite/books-domain/vies`).
//
// The EU patterns are the national-part formats VIES documents. They match
// `packages/domains/books/src/identifiers.ts` (`checkVatNumberFormat`): when a
// country's format changes, change both.
// ============================================================================

/** National part of a VAT number per VAT prefix, without the prefix. EU member states plus GB / XI. */
const VAT_PATTERNS: Record<string, RegExp> = {
  AT: /^U\d{8}$/,
  BE: /^[01]\d{9}$/,
  BG: /^\d{9,10}$/,
  CY: /^\d{8}[A-Z]$/,
  CZ: /^\d{8,10}$/,
  DE: /^\d{9}$/,
  DK: /^\d{8}$/,
  EE: /^\d{9}$/,
  EL: /^\d{9}$/,
  ES: /^[A-Z0-9]\d{7}[A-Z0-9]$/,
  FI: /^\d{8}$/,
  FR: /^[A-HJ-NP-Z0-9]{2}\d{9}$/,
  GB: /^(\d{9}|\d{12}|GD\d{3}|HA\d{3})$/,
  HR: /^\d{11}$/,
  HU: /^\d{8}$/,
  IE: /^(\d{7}[A-W][A-IW]?|\d[A-Z+*]\d{5}[A-W])$/,
  IT: /^\d{11}$/,
  LT: /^(\d{9}|\d{12})$/,
  LU: /^\d{8}$/,
  LV: /^\d{11}$/,
  MT: /^\d{8}$/,
  NL: /^\d{9}B\d{2}$/,
  PL: /^\d{10}$/,
  PT: /^\d{9}$/,
  RO: /^\d{2,10}$/,
  SE: /^\d{12}$/,
  SI: /^\d{8}$/,
  SK: /^\d{10}$/,
  XI: /^(\d{9}|\d{12}|GD\d{3}|HA\d{3})$/,
};

/** A correct example per VAT prefix, for error messages and placeholders. */
export const VAT_EXAMPLES: Record<string, string> = {
  AT: 'ATU12345678',
  BE: 'BE0123456789',
  BG: 'BG123456789',
  CY: 'CY12345678X',
  CZ: 'CZ12345678',
  DE: 'DE123456789',
  DK: 'DK12345678',
  EE: 'EE123456789',
  EL: 'EL123456789',
  ES: 'ESX1234567X',
  FI: 'FI12345678',
  FR: 'FR12345678901',
  GB: 'GB123456789',
  HR: 'HR12345678901',
  HU: 'HU12345678',
  IE: 'IE1234567X',
  IT: 'IT12345678901',
  LT: 'LT123456789',
  LU: 'LU12345678',
  LV: 'LV12345678901',
  MT: 'MT12345678',
  NL: 'NL123456789B01',
  PL: 'PL1234567890',
  PT: 'PT123456789',
  RO: 'RO1234567890',
  SE: 'SE123456789012',
  SI: 'SI12345678',
  SK: 'SK1234567890',
  XI: 'XI123456789',
};

/**
 * Tax IDs of countries without a known VAT pattern (a US EIN, an Indian GSTIN,
 * a Swiss UID, ...): 4 to 20 letters and digits with at least one digit, after
 * the usual separators are stripped. Lenient on purpose; it only rules out
 * free text such as "NOT A VAT!!".
 */
const LENIENT_TAX_ID = /^(?=.*\d)[A-Z0-9]{4,20}$/;

/** Upper-case, without the spaces, dots, hyphens and slashes people type into VAT numbers. */
export function normalizeVatNumber(raw: string | null | undefined): string {
  return (raw ?? '').replace(/[\s.\-/]/g, '').toUpperCase();
}

/** ISO 3166 alpha-2 country code to the prefix its VAT numbers carry (Greece is EL, not GR). */
export function vatPrefixForCountry(countryCode: string | null | undefined): string | null {
  const code = countryCode?.trim().toUpperCase();
  if (!code || code.length !== 2) return null;
  const prefix = code === 'GR' ? 'EL' : code;
  return prefix in VAT_PATTERNS ? prefix : null;
}

/** The VAT prefix a compact value starts with (`GR` counts as Greece's `EL`), or null. */
function typedVatPrefix(compact: string): string | null {
  const head = compact.slice(0, 2);
  if (head in VAT_PATTERNS) return head;
  if (head === 'GR') return 'EL';
  return null;
}

export interface VatNumberCheck {
  /** True for an empty value (the field is optional) and for a well-formed number. */
  valid: boolean;
  /** The VAT prefix the number was checked against (`NL`), or null for the lenient check. */
  prefix: string | null;
  /** A correct example for that prefix, when there is one. */
  example: string | null;
  /** The compact form that was checked (`NL123456789B01`). */
  compact: string;
}

/**
 * Check a VAT / tax ID against the format of the workspace's country.
 *
 * - Empty is valid: the field is optional.
 * - Country with a VAT pattern (EU, GB): a typed prefix picks the pattern
 *   (`BE0123456789` is checked as Belgian even for a Dutch workspace, a company
 *   can hold a VAT number elsewhere in the EU); without a prefix the country's
 *   own pattern applies (`123456789B01` for NL).
 * - No country given (a partial API update): a typed EU/GB prefix is checked
 *   against its pattern, anything else gets the lenient check.
 * - Any other country: the lenient check (letters and digits, at least one digit).
 */
export function checkVatNumber(raw: string | null | undefined, countryCode?: string | null): VatNumberCheck {
  const compact = normalizeVatNumber(raw);
  if (!compact) return { valid: true, prefix: null, example: null, compact };

  const hasCountry = Boolean(countryCode?.trim());
  const countryPrefix = vatPrefixForCountry(countryCode);
  const typed = typedVatPrefix(compact);
  // A country without a VAT pattern only ever gets the lenient check: its own
  // tax IDs may well start with two letters that happen to be an EU prefix.
  const prefix = hasCountry && !countryPrefix ? null : (typed ?? countryPrefix);

  const pattern = prefix ? VAT_PATTERNS[prefix] : undefined;
  if (!prefix || !pattern) {
    return { valid: LENIENT_TAX_ID.test(compact), prefix: null, example: null, compact };
  }

  const national = typed ? compact.slice(2) : compact;
  return {
    valid: pattern.test(national),
    prefix,
    example: VAT_EXAMPLES[prefix] ?? null,
    compact,
  };
}

export function isValidVatNumber(raw: string | null | undefined, countryCode?: string | null): boolean {
  return checkVatNumber(raw, countryCode).valid;
}

/** Placeholder for a VAT input: the country's example, or the Dutch one when there is none. */
export function vatPlaceholderForCountry(countryCode: string | null | undefined): string {
  const prefix = vatPrefixForCountry(countryCode);
  return (prefix && VAT_EXAMPLES[prefix]) || 'NL123456789B01';
}
