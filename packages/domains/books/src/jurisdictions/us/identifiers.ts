/**
 * US identifiers: federal tax IDs (EIN, SSN, ITIN), ABA routing numbers and
 * ZIP codes.
 *
 * Sources: docs/plans/weldbooks-us-research/federal.md §11 (EIN prefixes, SSN
 * and ITIN rules, TIN truncation on payee statements).
 *
 * Validators check format and the rules the issuing agency publishes. They
 * cannot tell whether a number was actually issued (that takes the IRS TIN
 * Matching service for 1099 payees).
 */

import type { TaxIdentifierValidation } from '../types';

export type TinType = 'ein' | 'ssn' | 'itin';

export const TIN_TYPES: readonly TinType[] = ['ein', 'ssn', 'itin'];

export function isTinType(value: unknown): value is TinType {
  return typeof value === 'string' && (TIN_TYPES as readonly string[]).includes(value);
}

/** Digits of a TIN or routing number with spaces and hyphens removed. */
function stripSeparators(value: string): string {
  return value.replace(/[\s-]/g, '');
}

// ---------------------------------------------------------------------------
// EIN
// ---------------------------------------------------------------------------

/**
 * Prefixes (first two digits) the IRS assigns to EINs, as inclusive ranges.
 * The IRS publishes these by campus and online; the list changes rarely.
 * Invalid: 00, 07-09, 17-19, 28-29, 49, 69-70, 78-79, 89, 96-97.
 */
export const EIN_VALID_PREFIX_RANGES: ReadonlyArray<readonly [number, number]> = [
  [1, 6],
  [10, 16],
  [20, 27],
  [30, 48],
  [50, 68],
  [71, 77],
  [80, 88],
  [90, 95],
  [98, 99],
];

export function isValidEinPrefix(prefix: string | number): boolean {
  const n = typeof prefix === 'number' ? prefix : Number.parseInt(prefix, 10);
  if (!Number.isInteger(n) || n < 0 || n > 99) return false;
  return EIN_VALID_PREFIX_RANGES.some(([from, to]) => n >= from && n <= to);
}

/** `XX-XXXXXXX` or nine digits. */
const EIN_RE = /^(\d{2})-(\d{7})$|^(\d{2})(\d{7})$/;

export function formatEin(digits: string): string {
  return `${digits.slice(0, 2)}-${digits.slice(2, 9)}`;
}

export function validateEin(value: string): TaxIdentifierValidation {
  const trimmed = value.trim();
  const match = EIN_RE.exec(trimmed);
  if (!match) {
    return { valid: false, error: 'EIN must be 9 digits, formatted XX-XXXXXXX (for example 12-3456789)' };
  }
  const digits = `${match[1] ?? match[3]}${match[2] ?? match[4]}`;
  const prefix = digits.slice(0, 2);
  if (!isValidEinPrefix(prefix)) {
    return { valid: false, error: `EIN prefix ${prefix} is not one the IRS assigns` };
  }
  return { valid: true, formatted: formatEin(digits) };
}

// ---------------------------------------------------------------------------
// SSN
// ---------------------------------------------------------------------------

/** `XXX-XX-XXXX` or nine digits. */
const SSN_RE = /^(\d{3})-(\d{2})-(\d{4})$|^(\d{3})(\d{2})(\d{4})$/;

/** Numbers the SSA voided after they were used in advertising or on sample cards. */
const VOIDED_SSNS: ReadonlySet<string> = new Set(['078051120', '219099999']);

export function formatSsn(digits: string): string {
  return `${digits.slice(0, 3)}-${digits.slice(3, 5)}-${digits.slice(5, 9)}`;
}

export function validateSsn(value: string): TaxIdentifierValidation {
  const trimmed = value.trim();
  const match = SSN_RE.exec(trimmed);
  if (!match) {
    return { valid: false, error: 'SSN must be 9 digits, formatted XXX-XX-XXXX (for example 123-45-6789)' };
  }
  const area = match[1] ?? match[4] ?? '';
  const group = match[2] ?? match[5] ?? '';
  const serial = match[3] ?? match[6] ?? '';
  const areaNumber = Number.parseInt(area, 10);

  if (areaNumber === 0 || areaNumber === 666 || areaNumber >= 900) {
    return { valid: false, error: `SSN area number ${area} is not issued` };
  }
  if (group === '00') return { valid: false, error: 'SSN group number 00 is not issued' };
  if (serial === '0000') return { valid: false, error: 'SSN serial number 0000 is not issued' };
  const digits = `${area}${group}${serial}`;
  if (VOIDED_SSNS.has(digits)) return { valid: false, error: 'This SSN was voided by the SSA' };
  return { valid: true, formatted: formatSsn(digits) };
}

// ---------------------------------------------------------------------------
// ITIN
// ---------------------------------------------------------------------------

/**
 * Fourth and fifth digits an ITIN may carry (50-65, 70-88, 90-92, 94-99).
 * 93 is reserved for adoption taxpayer identification numbers (ATIN).
 */
export const ITIN_VALID_MIDDLE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [50, 65],
  [70, 88],
  [90, 92],
  [94, 99],
];

export function validateItin(value: string): TaxIdentifierValidation {
  const trimmed = value.trim();
  const match = SSN_RE.exec(trimmed);
  if (!match) {
    return { valid: false, error: 'ITIN must be 9 digits, formatted 9XX-XX-XXXX (for example 912-70-1234)' };
  }
  const area = match[1] ?? match[4] ?? '';
  const group = match[2] ?? match[5] ?? '';
  const serial = match[3] ?? match[6] ?? '';
  if (!area.startsWith('9')) {
    return { valid: false, error: 'An ITIN starts with 9' };
  }
  const middle = Number.parseInt(group, 10);
  if (!ITIN_VALID_MIDDLE_RANGES.some(([from, to]) => middle >= from && middle <= to)) {
    return { valid: false, error: `ITIN digits 4-5 (${group}) are outside the ranges the IRS issues` };
  }
  return { valid: true, formatted: formatSsn(`${area}${group}${serial}`) };
}

// ---------------------------------------------------------------------------
// TIN dispatch, masking
// ---------------------------------------------------------------------------

export function validateTin(type: TinType, value: string): TaxIdentifierValidation {
  switch (type) {
    case 'ein':
      return validateEin(value);
    case 'ssn':
      return validateSsn(value);
    case 'itin':
      return validateItin(value);
  }
}

/**
 * Last four digits of a TIN, or null when the value isn't nine digits. This is
 * the only part stored in plain text (`tin_last4`, `ssn_last4`).
 */
export function tinLast4(value: string): string | null {
  if (!/^[\d\s-]+$/.test(value)) return null;
  const digits = stripSeparators(value);
  return digits.length === 9 ? digits.slice(5) : null;
}

/**
 * Truncated TIN for display and recipient copies: `***-**-6789` for an SSN or
 * ITIN, `**-***6789` for an EIN (the IRS truncation format). Without `type`,
 * a `XX-XXXXXXX` value is taken as an EIN and everything else as an SSN.
 * Never returns more than the last four digits.
 */
export function maskTin(value: string, type?: TinType): string {
  const trimmed = value.trim();
  const kind: 'ein' | 'personal' =
    type !== undefined ? (type === 'ein' ? 'ein' : 'personal') : /^\d{2}-\d{7}$/.test(trimmed) ? 'ein' : 'personal';
  const digits = /^[\d\s-]*$/.test(trimmed) ? stripSeparators(trimmed) : '';
  const last4 = digits.length >= 4 ? digits.slice(-4) : '****';
  return kind === 'ein' ? `**-***${last4}` : `***-**-${last4}`;
}

// ---------------------------------------------------------------------------
// State tax ID (free text)
// ---------------------------------------------------------------------------

/**
 * A state sales tax permit or account number. Formats differ in every state
 * (and some are alphanumeric), so only sanity checks apply.
 */
export function validateStateTaxId(value: string): TaxIdentifierValidation {
  const trimmed = value.trim();
  if (trimmed.length === 0) return { valid: false, error: 'State tax ID is required' };
  if (trimmed.length > 40) return { valid: false, error: 'State tax ID is too long (40 characters at most)' };
  if (!/^[A-Za-z0-9][A-Za-z0-9 ./#-]*$/.test(trimmed)) {
    return { valid: false, error: 'State tax ID may only contain letters, digits, spaces and - . / #' };
  }
  return { valid: true, formatted: trimmed };
}

// ---------------------------------------------------------------------------
// ABA routing number
// ---------------------------------------------------------------------------

/**
 * First two digits of a routing number identify the Federal Reserve district
 * (plus thrift institutions at +20 and electronic ACH at +60): 00-12, 21-32,
 * 61-72 and 80.
 */
export const ABA_VALID_PREFIX_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0, 12],
  [21, 32],
  [61, 72],
  [80, 80],
];

export function isValidAbaPrefix(prefix: string | number): boolean {
  const n = typeof prefix === 'number' ? prefix : Number.parseInt(prefix, 10);
  if (!Number.isInteger(n) || n < 0 || n > 99) return false;
  return ABA_VALID_PREFIX_RANGES.some(([from, to]) => n >= from && n <= to);
}

/** 3(d1+d4+d7) + 7(d2+d5+d8) + (d3+d6+d9) must be a multiple of 10. */
export function isValidAbaChecksum(digits: string): boolean {
  if (!/^\d{9}$/.test(digits)) return false;
  const d = [...digits].map(Number);
  const sum =
    3 * (d[0] + d[3] + d[6]) + 7 * (d[1] + d[4] + d[7]) + (d[2] + d[5] + d[8]);
  return sum % 10 === 0;
}

export function validateRoutingNumber(value: string): TaxIdentifierValidation {
  const trimmed = value.trim();
  if (!/^[\d\s]+$/.test(trimmed)) {
    return { valid: false, error: 'Routing number must be 9 digits' };
  }
  const digits = trimmed.replace(/\s/g, '');
  if (digits.length !== 9) return { valid: false, error: 'Routing number must be 9 digits' };
  if (/^0+$/.test(digits)) return { valid: false, error: 'Routing number is not valid' };
  if (!isValidAbaPrefix(digits.slice(0, 2))) {
    return { valid: false, error: `Routing number prefix ${digits.slice(0, 2)} is not a Federal Reserve district` };
  }
  if (!isValidAbaChecksum(digits)) {
    return { valid: false, error: 'Routing number checksum does not match, check for a typo' };
  }
  return { valid: true, formatted: digits };
}

// ---------------------------------------------------------------------------
// ZIP
// ---------------------------------------------------------------------------

export interface ZipValidation extends TaxIdentifierValidation {
  /** First five digits. */
  zip5?: string;
  /** The four-digit add-on, when given. */
  plus4?: string;
}

/**
 * `12345`, `12345-6789` or nine digits. ZIP codes are text: leading zeros
 * (Massachusetts, New Jersey, Puerto Rico) must survive storage.
 */
export function validateZip(value: string): ZipValidation {
  const trimmed = value.trim();
  const match = /^(\d{5})(?:-?(\d{4}))?$/.exec(trimmed);
  if (!match) {
    return { valid: false, error: 'ZIP code must be 5 digits or ZIP+4 (12345 or 12345-6789)' };
  }
  const zip5 = match[1];
  const plus4 = match[2];
  if (zip5 === '00000') return { valid: false, error: 'ZIP code is not valid' };
  return {
    valid: true,
    formatted: plus4 ? `${zip5}-${plus4}` : zip5,
    zip5,
    ...(plus4 ? { plus4 } : {}),
  };
}

/** The canonical `12345` / `12345-6789` form, or null when the value isn't a ZIP. */
export function normalizeZip(value: string | null | undefined): string | null {
  if (value == null) return null;
  const result = validateZip(value);
  return result.valid ? (result.formatted ?? null) : null;
}

/** The five-digit part of a ZIP, for rate lookups and zone matching. */
export function zip5(value: string | null | undefined): string | null {
  if (value == null) return null;
  const result = validateZip(value);
  return result.valid ? (result.zip5 ?? null) : null;
}
