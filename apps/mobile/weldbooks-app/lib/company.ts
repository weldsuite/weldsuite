/**
 * What a company has to carry before one of its invoices can be finalised, and
 * the checks for the identifiers the company forms collect.
 *
 * books-api refuses to finalise an invoice while the company lacks the fields
 * its jurisdiction makes mandatory (`requiredFields` of the jurisdiction
 * adapter, plus the business address everywhere). The app asks for them up
 * front, warns on the draft before the attempt, and names them in the words of
 * the app language instead of the server's English sentence.
 *
 * The API's jurisdiction list says which fields apply (`invoiceRequiredFields`);
 * the built-in table mirrors it for older APIs, offline, and before it loads.
 * The app doesn't import `@weldsuite/books-domain` (server code), so the format
 * checks mirror `packages/domains/books/src/identifiers.ts` and the NL adapter;
 * books-api checks every value again, these only catch typos before a request.
 *
 * Kept pure (no React, no network) so the rules can be unit-tested.
 */

import { isApiError } from '@weldsuite/api-client/client';

import type { AccountingEntity, Jurisdiction, PostalAddress } from '@/types/accounting';

/** The company fields an invoice can require, as books-api names them. */
export const INVOICE_FIELDS = ['vatNumber', 'registrationNumber', 'iban', 'bic', 'address'] as const;
export type InvoiceField = (typeof INVOICE_FIELDS)[number];

export function isInvoiceField(value: unknown): value is InvoiceField {
  return typeof value === 'string' && (INVOICE_FIELDS as readonly string[]).includes(value);
}

/** What each jurisdiction adapter requires (`getInvoiceRequirements().requiredFields`, address added). */
export const BUILT_IN_INVOICE_FIELDS: Readonly<Record<string, readonly InvoiceField[]>> = {
  NL: ['vatNumber', 'registrationNumber', 'iban', 'address'],
  IN: ['vatNumber', 'registrationNumber', 'address'],
  BR: ['vatNumber', 'address'],
  US: ['address'],
};

/** The business address is on every invoice, whatever else a jurisdiction asks for. */
const ALWAYS_REQUIRED: readonly InvoiceField[] = ['address'];

/** The fields a company in this jurisdiction needs to finalise an invoice: the API's list, else the built-in one. */
export function requiredInvoiceFields(
  code: string | null | undefined,
  loaded?: readonly Jurisdiction[] | null,
): InvoiceField[] {
  if (!code) return [...ALWAYS_REQUIRED];
  const wanted = code.toUpperCase();
  const fromApi = loaded?.find((jurisdiction) => jurisdiction.code.toUpperCase() === wanted)?.invoiceRequiredFields;
  const listed = fromApi?.filter(isInvoiceField) ?? BUILT_IN_INVOICE_FIELDS[wanted] ?? [];
  return [...new Set<InvoiceField>([...listed, ...ALWAYS_REQUIRED])];
}

/** An address an invoice can print: a street line and a city at least. */
export function hasInvoiceAddress(address: PostalAddress | null | undefined): boolean {
  return Boolean(address?.line1?.trim() && address.city?.trim());
}

/** Which of `required` the company has not filled in yet. */
export function missingInvoiceFields(
  entity: Pick<AccountingEntity, 'vatNumber' | 'registrationNumber' | 'iban' | 'bic' | 'address'> | null | undefined,
  required: readonly InvoiceField[],
): InvoiceField[] {
  const present: Record<InvoiceField, boolean> = {
    vatNumber: Boolean(entity?.vatNumber?.trim()),
    registrationNumber: Boolean(entity?.registrationNumber?.trim()),
    iban: Boolean(entity?.iban?.trim()),
    bic: Boolean(entity?.bic?.trim()),
    address: hasInvoiceAddress(entity?.address),
  };
  return required.filter((field) => !present[field]);
}

/**
 * The fields a refused finalise names: `error.details.missingFields` of books-api's
 * `ENTITY_INVOICE_FIELDS_MISSING` answer. Empty for any other error, or an older API.
 */
export function missingFieldsFromError(err: unknown): InvoiceField[] {
  if (!isApiError(err)) return [];
  const body = err.body as { error?: { details?: { missingFields?: unknown } } } | null | undefined;
  const fields = body?.error?.details?.missingFields;
  return Array.isArray(fields) ? fields.filter(isInvoiceField) : [];
}

// ---------------------------------------------------------------------------
// IBAN
// ---------------------------------------------------------------------------

/** An IBAN without spaces, upper case. */
export function normalizeIban(raw: string): string {
  return raw.replaceAll(/\s+/g, '').toUpperCase();
}

/** An IBAN as typed: upper case, in groups of four. */
export function formatIbanInput(raw: string): string {
  const compact = normalizeIban(raw).replaceAll(/[^A-Z0-9]/g, '').slice(0, 34);
  return compact.replaceAll(/(.{4})(?=.)/g, '$1 ');
}

/**
 * Why an IBAN is not valid: its shape or its mod-97 check digits. The length per country
 * is left to books-api, which holds the registry.
 */
export function ibanProblem(raw: string): 'format' | 'checksum' | null {
  const iban = normalizeIban(raw);
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(iban)) return 'format';
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let remainder = 0;
  for (const char of rearranged) {
    const value = char >= 'A' && char <= 'Z' ? String(char.charCodeAt(0) - 55) : char;
    for (const digit of value) remainder = (remainder * 10 + Number(digit)) % 97;
  }
  return remainder === 1 ? null : 'checksum';
}

// ---------------------------------------------------------------------------
// Netherlands
// ---------------------------------------------------------------------------

/** A Dutch BTW number is NL, nine digits, B and two digits. */
export function btwProblem(raw: string): 'format' | null {
  return /^NL\d{9}B\d{2}$/.test(raw.replaceAll(/[\s.]/g, '').toUpperCase()) ? null : 'format';
}

/** The BTW number as books-api stores it: no spaces or dots, upper case. */
export function normalizeBtw(raw: string): string {
  return raw.replaceAll(/[\s.]/g, '').toUpperCase();
}

/** A KvK number is eight digits. */
export function kvkProblem(raw: string): 'format' | null {
  return /^\d{8}$/.test(raw.replaceAll(/\s/g, '')) ? null : 'format';
}

export function normalizeKvk(raw: string): string {
  return raw.replaceAll(/\s/g, '');
}

// ---------------------------------------------------------------------------
// Months
// ---------------------------------------------------------------------------

/**
 * The day a fiscal year starts, as words in `locale` ("1 January", "1 januari",
 * "January 1" for en-US). `month` is the entity's `fiscalYearStart` (1-12), which
 * the settings endpoint may send as a string. Anything else comes back as-is.
 */
export function fiscalYearStartLabel(month: number | string | null | undefined, locale: string): string | null {
  if (month === null || month === undefined || month === '') return null;
  const value = typeof month === 'number' ? month : Number(month);
  if (!Number.isInteger(value) || value < 1 || value > 12) return String(month);
  // UTC noon of the first, formatted in UTC: no time zone can slip it to another day.
  return new Date(Date.UTC(2024, value - 1, 1, 12)).toLocaleDateString(locale, {
    day: 'numeric',
    month: 'long',
    timeZone: 'UTC',
  });
}
