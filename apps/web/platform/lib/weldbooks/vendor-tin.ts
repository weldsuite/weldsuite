/**
 * Client-side checks and formatting of a vendor's TIN (EIN, SSN or ITIN) for
 * the contact form and the public W-9 page. The server validates again
 * (`jurisdictions/us/identifiers.ts`); these rules only keep an obvious typo
 * from travelling. The EIN and SSN rules come from `us-entity.ts`.
 */
import {
  einProblem,
  formatEinInput,
  formatSsnInput,
  normalizeEin,
  normalizeSsn,
  ssnProblem,
  type TaxIdProblem,
} from './us-entity';

export type VendorTinType = 'ein' | 'ssn' | 'itin';

export const VENDOR_TIN_TYPES: readonly VendorTinType[] = ['ein', 'ssn', 'itin'];

export function isVendorTinType(value: unknown): value is VendorTinType {
  return typeof value === 'string' && (VENDOR_TIN_TYPES as readonly string[]).includes(value);
}

/** The fourth and fifth digit pairs the IRS issues for an ITIN. */
const ITIN_MIDDLE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [50, 65],
  [70, 88],
  [90, 92],
  [94, 99],
];

function digitsOf(value: string): string {
  return value.replace(/\D/g, '');
}

/** `null` when the ITIN is acceptable (or empty). */
export function itinProblem(value: string): TaxIdProblem | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (!/^\d{3}-\d{2}-\d{4}$/.test(trimmed) && !/^\d{9}$/.test(trimmed)) return 'format';
  const digits = digitsOf(trimmed);
  if (!digits.startsWith('9')) return 'area';
  const middle = Number.parseInt(digits.slice(3, 5), 10);
  return ITIN_MIDDLE_RANGES.some(([from, to]) => middle >= from && middle <= to) ? null : 'group';
}

/** `null` when the TIN is acceptable for its type (or empty). */
export function tinProblem(type: VendorTinType, value: string): TaxIdProblem | null {
  switch (type) {
    case 'ein':
      return einProblem(value);
    case 'ssn':
      return ssnProblem(value);
    case 'itin':
      return itinProblem(value);
  }
}

/** What the user has typed so far, with the dashes of the type: `12-3456789` or `123-45-6789`. */
export function formatTinInput(type: VendorTinType, value: string): string {
  return type === 'ein' ? formatEinInput(value) : formatSsnInput(value);
}

/** The TIN as it is sent: nine digits with the dashes of its type. */
export function normalizeTin(type: VendorTinType, value: string): string {
  return type === 'ein' ? normalizeEin(value) : normalizeSsn(value);
}

/** `**-***1234` for an EIN, `***-**-1234` for an SSN or ITIN: the IRS truncation format. */
export function maskedTin(type: VendorTinType | null | undefined, last4: string | null | undefined): string {
  const tail = last4 && /^\d{4}$/.test(last4) ? last4 : '****';
  return type === 'ein' ? `**-***${tail}` : `***-**-${tail}`;
}

/** Placeholder text of the input for a type. */
export function tinPlaceholder(type: VendorTinType | '' | null | undefined): string {
  if (type === 'ein') return '12-3456789';
  if (type === 'itin') return '9XX-XX-XXXX';
  return '123-45-6789';
}
