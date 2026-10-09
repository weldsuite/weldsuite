import { cleanPostalAddress, type PostalAddress } from '@/components/address/postal-address';
import type { TaxDocumentKind } from '@/lib/api/domains/weldbooks-sales-tax-preview';
import { cleanTaxRateId } from '@/lib/weldbooks/document-tax';
import {
  amountOrUndefined,
  amountString,
  dimensionPayload,
  salesTaxLinePayload,
  type SalesTaxLineValues,
} from '@/lib/weldbooks/document-tax-form';
import { invoiceAddressPayload } from './invoice-address-section';

/** A line of the invoice form (or its quick-create dialog). */
export interface InvoiceLineValues extends Partial<SalesTaxLineValues> {
  description: string;
  quantity: number | string;
  unitPrice: number | string;
  discountPercent?: number | string;
  taxRateId?: string | null;
  accountId?: string | null;
  unit?: string;
}

/** What the invoice form holds; the dialog leaves the optional parts out. */
export interface InvoiceFormShape {
  contactId: string;
  issueDate: string;
  dueDate: string;
  reference?: string;
  notes?: string;
  internalNotes?: string;
  billingAddress: PostalAddress;
  shipToDifferent: boolean;
  shippingAddress: PostalAddress;
  shipFromDifferent?: boolean;
  shipFromAddress?: PostalAddress;
  marketplaceFacilitated?: boolean;
  items: InvoiceLineValues[];
}

export interface InvoicePayloadOptions {
  mode: 'add' | 'edit';
  kind: TaxDocumentKind;
  /** The entity charges sales tax (a US entity): lines carry their tax code, use, inclusion and override. */
  salesTax: boolean;
  currency?: string | null;
}

/**
 * The create / update body of an invoice or credit memo. Amounts go as
 * strings (what the API validates); a VAT / GST entity sends its rate ids as
 * before, a US entity the sales tax fields of each line and the origin of the
 * sale. "No tax" is null: the API rejects placeholder ids such as `none`. On
 * edit an emptied address is sent so the stored one is cleared.
 */
export function buildInvoicePayload(values: InvoiceFormShape, options: InvoicePayloadOptions): Record<string, unknown> {
  const { mode, kind, salesTax } = options;

  const payload: Record<string, unknown> = {
    contactId: values.contactId,
    issueDate: values.issueDate,
    dueDate: values.dueDate,
    reference: values.reference || undefined,
    notes: values.notes || undefined,
    internalNotes: values.internalNotes || undefined,
    ...invoiceAddressPayload(values, mode),
    items: values.items.map((item) => ({
      description: item.description,
      quantity: amountString(item.quantity, '1'),
      unitPrice: amountString(item.unitPrice, '0'),
      taxRateId: salesTax ? null : cleanTaxRateId(item.taxRateId),
      accountId: item.accountId || undefined,
      unit: item.unit || undefined,
      discountPercent: amountOrUndefined(item.discountPercent),
      ...(salesTax ? salesTaxLinePayload(item) : {}),
      ...dimensionPayload(item),
      // A credit memo line says which invoice line it credits, so the tax is reversed per line.
      ...(kind === 'credit_memo' && item.originalLineId ? { originalLineId: item.originalLineId } : {}),
    })),
  };

  if (salesTax && kind !== 'credit_memo') {
    const shipFrom = values.shipFromDifferent ? cleanPostalAddress(values.shipFromAddress) : undefined;
    payload.shipFromAddress = shipFrom ?? (mode === 'edit' ? null : undefined);
    payload.marketplaceFacilitated = Boolean(values.marketplaceFacilitated);
  }
  if (options.currency) payload.currency = options.currency;
  return payload;
}
