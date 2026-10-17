/**
 * Format checks for the identifiers people type into WeldBooks: EU VAT numbers
 * and IBANs. Pure functions, no network (VIES lookups live in `vies.ts`).
 *
 * A format check only says the value could exist: the right country prefix, the
 * right length and characters (and for an IBAN the mod-97 check digits). It does
 * not say the number is registered; that is VIES.
 *
 * This is the platform's copy of `packages/domains/books/src/identifiers.ts` (the SPA does not depend
 * on the domain package): keep the two in sync.
 */

// ---------------------------------------------------------------------------
// VAT numbers
// ---------------------------------------------------------------------------

/** National part of a VAT number per VAT prefix (what VIES documents), without the prefix. */
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

/** An example per VAT prefix, for error messages. */
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

/** ISO 3166 country code to the prefix its VAT numbers carry (Greece is EL, not GR). */
function vatPrefixOf(countryCode: string | null | undefined): string | null {
  const code = countryCode?.trim().toUpperCase();
  if (!code || code.length !== 2) return null;
  const prefix = code === 'GR' ? 'EL' : code;
  return prefix in VAT_PATTERNS ? prefix : null;
}

export interface VatFormatCheck {
  /** False only when the value is shaped like a VAT number of a country and is wrong for it. */
  valid: boolean;
  /** The VAT prefix the check ran for (`BE`), when there was one. */
  prefix: string | null;
  /** The number in its compact upper-case form (`BE0123456789`), when it passed. */
  formatted: string | null;
  /** Example of a correct number for that prefix. */
  example: string | null;
}

/**
 * Check a typed VAT number against the format of its country.
 *
 * - With a country prefix (`BE0123456789`, `nl 1234.56.789 b01`): the national part has to match that country.
 * - Without one, the contact's country decides (`0123456789` for a Belgian contact is checked as a Belgian number).
 * - A value that carries no EU prefix, for a country without a pattern (a US EIN, an Indian GSTIN, ...) is not
 *   judged here: `valid` stays true and `prefix` is null.
 */
export function checkVatNumberFormat(raw: string | null | undefined, countryCode?: string | null): VatFormatCheck {
  const compact = (raw ?? '').replace(/[\s.\-/]/g, '').toUpperCase();
  const skip: VatFormatCheck = { valid: true, prefix: null, formatted: compact || null, example: null };
  if (!compact) return skip;

  const typedPrefix = /^[A-Z]{2}/.test(compact) && compact.slice(0, 2) in VAT_PATTERNS ? compact.slice(0, 2) : null;
  // "GR" is what people type for Greece; its VAT numbers carry EL.
  const greek = !typedPrefix && compact.startsWith('GR') && /^GR\d/.test(compact);
  const prefix = typedPrefix ?? (greek ? 'EL' : vatPrefixOf(countryCode));
  if (!prefix) return skip;

  const national = typedPrefix || greek ? compact.slice(2) : compact;
  const valid = VAT_PATTERNS[prefix].test(national);
  return {
    valid,
    prefix,
    formatted: valid ? `${prefix}${national}` : null,
    example: VAT_EXAMPLES[prefix] ?? null,
  };
}

// ---------------------------------------------------------------------------
// IBAN
// ---------------------------------------------------------------------------

/** Total IBAN length per country (SWIFT IBAN registry). */
export const IBAN_LENGTHS: Record<string, number> = {
  AD: 24, AE: 23, AL: 28, AT: 20, AZ: 28, BA: 20, BE: 16, BG: 22, BH: 22, BR: 29, BY: 28, CH: 21, CR: 22,
  CY: 28, CZ: 24, DE: 22, DK: 18, DO: 28, EE: 20, EG: 29, ES: 24, FI: 18, FO: 18, FR: 27, GB: 22, GE: 22,
  GI: 23, GL: 18, GR: 27, GT: 28, HR: 21, HU: 28, IE: 22, IL: 23, IQ: 23, IS: 26, IT: 27, JO: 30, KW: 30,
  KZ: 20, LB: 28, LC: 32, LI: 21, LT: 20, LU: 20, LV: 21, MC: 27, MD: 24, ME: 22, MK: 19, MR: 27, MT: 31,
  MU: 30, NL: 18, NO: 15, PK: 24, PL: 28, PS: 29, PT: 25, QA: 29, RO: 24, RS: 22, SA: 24, SC: 31, SE: 24,
  SI: 19, SK: 24, SM: 27, ST: 25, SV: 28, TL: 23, TN: 24, TR: 26, UA: 29, VA: 22, VG: 24, XK: 20,
};

/** An IBAN without spaces, upper case. */
export function normalizeIban(raw: string): string {
  return raw.replace(/\s+/g, '').toUpperCase();
}

export type IbanProblem = 'format' | 'country_length' | 'checksum';

/**
 * Why an IBAN is not valid, or null when it is: its shape, its length for the
 * country (a country outside the registry only has to be 15 to 34 long), and
 * the mod-97 check digits.
 */
export function ibanProblem(raw: string): IbanProblem | null {
  const iban = normalizeIban(raw);
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(iban)) return 'format';
  const expected = IBAN_LENGTHS[iban.slice(0, 2)];
  if (expected !== undefined && iban.length !== expected) return 'country_length';
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let remainder = 0;
  for (const char of rearranged) {
    const value = char >= 'A' && char <= 'Z' ? String(char.charCodeAt(0) - 55) : char;
    for (const digit of value) remainder = (remainder * 10 + Number(digit)) % 97;
  }
  return remainder === 1 ? null : 'checksum';
}

export function isValidIban(raw: string): boolean {
  return ibanProblem(raw) === null;
}

// ---------------------------------------------------------------------------
// Brazil: CNPJ, CPF, Inscrição Estadual, CEP
// ---------------------------------------------------------------------------
// Platform copy of `packages/domains/books/src/jurisdictions/br/identifiers.ts`: keep the two in sync.

/** Why a Brazilian identifier is not valid: the shape, or its check digits. */
export type BrIdProblem = 'format' | 'checksum';

/** A CNPJ without its mask, upper case (the first 12 characters may be letters since July 2026). */
export function normalizeCnpj(value: string): string {
  return value.replace(/[\s./-]/g, '').toUpperCase();
}

export function normalizeCpf(value: string): string {
  return value.replace(/[\s.-]/g, '');
}

function mod11Digit(values: number[], weights: number[]): number {
  let sum = 0;
  for (let i = 0; i < values.length; i++) sum += values[i] * weights[i];
  const remainder = sum % 11;
  return remainder < 2 ? 0 : 11 - remainder;
}

const CNPJ_WEIGHTS_1 = [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
const CNPJ_WEIGHTS_2 = [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];

/** The two check digits of a CNPJ from its first 12 characters (digits count their value, A..Z count 17..42). */
export function cnpjCheckDigits(first12: string): string {
  const values = [...first12].map((ch) => ch.charCodeAt(0) - 48);
  const d1 = mod11Digit(values, CNPJ_WEIGHTS_1);
  const d2 = mod11Digit([...values, d1], CNPJ_WEIGHTS_2);
  return `${d1}${d2}`;
}

export function formatCnpj(value: string): string {
  const n = normalizeCnpj(value);
  return `${n.slice(0, 2)}.${n.slice(2, 5)}.${n.slice(5, 8)}/${n.slice(8, 12)}-${n.slice(12)}`;
}

export function formatCpf(value: string): string {
  const n = normalizeCpf(value);
  return `${n.slice(0, 3)}.${n.slice(3, 6)}.${n.slice(6, 9)}-${n.slice(9)}`;
}

/** Why a CNPJ is not valid (alphanumeric ones included), or null when it is. */
export function cnpjProblem(value: string): BrIdProblem | null {
  const n = normalizeCnpj(value);
  if (!/^[0-9A-Z]{12}\d{2}$/.test(n) || /^(.)\1{13}$/.test(n)) return 'format';
  return cnpjCheckDigits(n.slice(0, 12)) === n.slice(12) ? null : 'checksum';
}

export function isValidCnpj(value: string): boolean {
  return cnpjProblem(value) === null;
}

/** Why a CPF is not valid, or null when it is. */
export function cpfProblem(value: string): BrIdProblem | null {
  const n = normalizeCpf(value);
  if (!/^\d{11}$/.test(n) || /^(\d)\1{10}$/.test(n)) return 'format';
  const digits = [...n].map(Number);
  const dv = (count: number, start: number) => {
    let sum = 0;
    for (let i = 0; i < count; i++) sum += digits[i] * (start - i);
    const remainder = (sum * 10) % 11;
    return remainder === 10 ? 0 : remainder;
  };
  return dv(9, 10) === digits[9] && dv(10, 11) === digits[10] ? null : 'checksum';
}

export function isValidCpf(value: string): boolean {
  return cpfProblem(value) === null;
}

/** A CNPJ (company) or a CPF (person), told apart by length: eleven digits is a CPF. */
export function brTaxIdKind(value: string): 'cnpj' | 'cpf' {
  const compact = normalizeCnpj(value);
  return compact.length === 11 && /^\d+$/.test(compact) ? 'cpf' : 'cnpj';
}

export function brTaxIdProblem(value: string): BrIdProblem | null {
  return brTaxIdKind(value) === 'cpf' ? cpfProblem(value) : cnpjProblem(value);
}

/** Inscrição Estadual: every state has its own check digit, so only the shape is checked (2 to 14 digits, or ISENTO). */
export function isValidInscricaoEstadual(value: string): boolean {
  const trimmed = value.trim().toUpperCase();
  return trimmed === 'ISENTO' || /^\d{2,14}$/.test(trimmed.replace(/[\s./-]/g, ''));
}

/** A CEP as 00000-000, or undefined when it does not have eight digits. */
export function normalizeCep(value: string): string | undefined {
  const digits = value.replace(/\D/g, '');
  return digits.length === 8 ? `${digits.slice(0, 5)}-${digits.slice(5)}` : undefined;
}

/** IBGE municipality code: seven digits, the first two the state's code. */
export function isValidMunicipalityCode(value: string): boolean {
  return /^\d{7}$/.test(value.trim());
}
