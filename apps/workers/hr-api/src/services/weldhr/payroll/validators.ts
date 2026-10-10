/**
 * Identifier validators and maskers: BSN (elfproef), SSN, IBAN (mod-97),
 * ABA routing number. Local to hr-api so payment details are checked on the
 * way in whether or not the payment-file builders have landed; the domain
 * package has the same checks for IBAN and routing numbers behind its builders.
 */

export function digitsOnly(value: string): string {
  return value.replace(/\D/g, '');
}

/** BSN with the Dutch "elfproef": 9 digits (an 8-digit number is padded), weights 9…2 and -1. */
export function normalizeBsn(value: string): string | null {
  const digits = digitsOnly(value);
  if (digits.length < 8 || digits.length > 9) return null;
  const padded = digits.padStart(9, '0');
  let total = 0;
  for (let i = 0; i < 9; i += 1) {
    const weight = i === 8 ? -1 : 9 - i;
    total += Number(padded[i]) * weight;
  }
  if (total === 0 || total % 11 !== 0) return null;
  return padded;
}

/** US SSN: 9 digits, area not 000/666/9xx, group not 00, serial not 0000. */
export function normalizeSsn(value: string): string | null {
  if (!/^\d{3}-?\d{2}-?\d{4}$/.test(value.trim())) return null;
  const digits = digitsOnly(value);
  const area = digits.slice(0, 3);
  if (area === '000' || area === '666' || area.startsWith('9')) return null;
  if (digits.slice(3, 5) === '00' || digits.slice(5) === '0000') return null;
  return digits;
}

const IBAN_LENGTHS: Record<string, number> = {
  AD: 24, AE: 23, AL: 28, AT: 20, AZ: 28, BA: 20, BE: 16, BG: 22, BH: 22, BR: 29, BY: 28, CH: 21, CR: 22, CY: 28,
  CZ: 24, DE: 22, DK: 18, DO: 28, EE: 20, EG: 29, ES: 24, FI: 18, FO: 18, FR: 27, GB: 22, GE: 22, GI: 23, GL: 18,
  GR: 27, GT: 28, HR: 21, HU: 28, IE: 22, IL: 23, IQ: 23, IS: 26, IT: 27, JO: 30, KW: 30, KZ: 20, LB: 28, LC: 32,
  LI: 21, LT: 20, LU: 20, LV: 21, MC: 27, MD: 24, ME: 22, MK: 19, MR: 27, MT: 31, MU: 30, NL: 18, NO: 15, PK: 24,
  PL: 28, PS: 29, PT: 25, QA: 29, RO: 24, RS: 22, SA: 24, SC: 31, SE: 24, SI: 19, SK: 24, SM: 27, ST: 25, SV: 28,
  TL: 23, TN: 24, TR: 26, UA: 29, VA: 22, VG: 24, XK: 20,
};

/** Uppercase, spaces removed. */
export function normalizeIban(value: string): string {
  return value.replace(/\s+/g, '').toUpperCase();
}

export function isValidIban(raw: string): boolean {
  const iban = normalizeIban(raw);
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{1,30}$/.test(iban)) return false;
  const expected = IBAN_LENGTHS[iban.slice(0, 2)];
  if (!expected || iban.length !== expected) return false;
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let remainder = 0;
  for (const ch of rearranged) {
    const code = ch >= 'A' && ch <= 'Z' ? String(ch.charCodeAt(0) - 55) : ch;
    for (const digit of code) remainder = (remainder * 10 + Number(digit)) % 97;
  }
  return remainder === 1;
}

export function normalizeBic(value: string): string | null {
  const bic = value.replace(/\s+/g, '').toUpperCase();
  return /^[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}([A-Z0-9]{3})?$/.test(bic) ? bic : null;
}

/** ABA routing number: 9 digits with the 3-7-1 checksum. */
export function isValidRoutingNumber(value: string): boolean {
  if (!/^\d{9}$/.test(value)) return false;
  const d = [...value].map(Number);
  const sum = 3 * (d[0]! + d[3]! + d[6]!) + 7 * (d[1]! + d[4]! + d[7]!) + (d[2]! + d[5]! + d[8]!);
  return sum % 10 === 0;
}

// ---------------------------------------------------------------------------
// Masking
// ---------------------------------------------------------------------------

/** `•••••1234` */
export function maskNationalId(value: string | null | undefined): string | null {
  if (!value) return null;
  const digits = digitsOnly(value);
  return `•••••${digits.slice(-4)}`;
}

/** `NL91 •••• •••• 4300` */
export function maskIban(value: string | null | undefined): string | null {
  if (!value) return null;
  const iban = normalizeIban(value);
  if (iban.length <= 8) return `${iban.slice(0, 2)}••`;
  const head = iban.slice(0, 4);
  const tail = iban.slice(-4);
  const middleGroups = Math.max(1, Math.floor((iban.length - 8) / 4));
  return [head, ...Array.from({ length: middleGroups }, () => '••••'), tail].join(' ');
}

/** `•••• 6789` */
export function maskAccountNumber(value: string | null | undefined): string | null {
  if (!value) return null;
  return `•••• ${value.slice(-4)}`;
}

/** `***-**-1234`, for documents an employee or the UI sees. */
export function maskSsn(value: string | null | undefined): string | null {
  if (!value) return null;
  const digits = digitsOnly(value);
  return digits.length === 9 ? `***-**-${digits.slice(-4)}` : null;
}
