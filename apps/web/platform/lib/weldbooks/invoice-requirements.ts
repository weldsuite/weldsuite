/**
 * The company details an invoice has to carry before it can be issued.
 *
 * books-api refuses to finalize (or send) an invoice while the entity lacks
 * the fields its jurisdiction makes mandatory: `requiredFields` of the
 * jurisdiction adapter, plus the business address everywhere
 * (`ENTITY_INVOICE_FIELDS_MISSING`). The platform asks for them before an
 * invoice is created, so the refusal doesn't come after the work is done.
 *
 * The jurisdiction list says which fields apply (`invoiceRequiredFields`); the
 * built-in table mirrors it for an older API and before the list has loaded.
 * Same rules as the mobile app's `lib/company.ts`.
 */

import type { AccountingEntity } from '@/lib/api/domains/weldbooks';
import { normalizeAccountingAddress } from './address';
import type { JurisdictionSummary } from './jurisdiction';

/** The entity fields an invoice can require, as books-api names them. */
export const INVOICE_FIELDS = ['vatNumber', 'registrationNumber', 'iban', 'bic', 'address'] as const;
export type InvoiceField = (typeof INVOICE_FIELDS)[number];

export function isInvoiceField(value: unknown): value is InvoiceField {
  return typeof value === 'string' && (INVOICE_FIELDS as readonly string[]).includes(value);
}

/** What each jurisdiction adapter requires (`getInvoiceRequirements().requiredFields`, address added). */
const BUILT_IN_INVOICE_FIELDS: Readonly<Record<string, readonly InvoiceField[]>> = {
  NL: ['vatNumber', 'registrationNumber', 'iban', 'address'],
  IN: ['vatNumber', 'registrationNumber', 'address'],
  BR: ['vatNumber', 'address'],
  US: ['address'],
};

/** The business address is on every invoice, whatever else a jurisdiction asks for. */
const ALWAYS_REQUIRED: readonly InvoiceField[] = ['address'];

/** The fields an entity in this jurisdiction needs to issue an invoice: the API's list, else the built-in one. */
export function requiredInvoiceFields(
  code: string | null | undefined,
  jurisdictions?: readonly Pick<JurisdictionSummary, 'code' | 'invoiceRequiredFields'>[] | null,
): InvoiceField[] {
  if (!code) return [...ALWAYS_REQUIRED];
  const wanted = code.toUpperCase();
  const fromApi = jurisdictions?.find((j) => j.code.toUpperCase() === wanted)?.invoiceRequiredFields;
  const listed = fromApi?.filter(isInvoiceField) ?? BUILT_IN_INVOICE_FIELDS[wanted] ?? [];
  return [...new Set<InvoiceField>([...listed, ...ALWAYS_REQUIRED])];
}

export type InvoiceEntityFields = Pick<AccountingEntity, 'taxIdentifiers' | 'bankDetails' | 'address'>;

/** An address an invoice can print: a street line and a city at least. */
export function hasInvoiceAddress(entity: Pick<AccountingEntity, 'address'> | null | undefined): boolean {
  const address = normalizeAccountingAddress(entity?.address);
  return Boolean(address?.line1?.trim() && address.city?.trim());
}

/** Which of `required` the entity has not filled in yet, in the order of `required`. */
export function missingInvoiceFields(
  entity: InvoiceEntityFields | null | undefined,
  required: readonly InvoiceField[],
): InvoiceField[] {
  const present: Record<InvoiceField, boolean> = {
    vatNumber: Boolean(entity?.taxIdentifiers?.vatNumber?.trim()),
    registrationNumber: Boolean(entity?.taxIdentifiers?.registrationNumber?.trim()),
    iban: Boolean(entity?.bankDetails?.iban?.trim()),
    bic: Boolean(entity?.bankDetails?.bic?.trim()),
    address: hasInvoiceAddress(entity),
  };
  return required.filter((field) => !present[field]);
}

/**
 * The fields a refused finalize or send names: `error.details.missingFields` of
 * books-api's `ENTITY_INVOICE_FIELDS_MISSING` answer. Empty for any other error.
 */
export function missingFieldsFromError(err: unknown): InvoiceField[] {
  const body = err && typeof err === 'object' ? (err as { body?: unknown }).body : undefined;
  const details = (body as { error?: { details?: { code?: unknown; missingFields?: unknown } } } | null | undefined)
    ?.error?.details;
  if (details?.code !== 'ENTITY_INVOICE_FIELDS_MISSING' || !Array.isArray(details.missingFields)) return [];
  return details.missingFields.filter(isInvoiceField);
}
