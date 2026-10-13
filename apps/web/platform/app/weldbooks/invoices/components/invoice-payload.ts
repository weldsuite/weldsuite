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
import { exchangeRatePayload } from '@/lib/weldbooks/currencies';
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
  /** India GST: HSN or SAC code. */
  hsnSac?: string;
}

/** What the invoice form holds; the dialog leaves the optional parts out. */
export interface InvoiceFormShape {
  contactId: string;
  issueDate: string;
  dueDate: string;
  reference?: string;
  notes?: string;
  internalNotes?: string;
  /** ISO 4217 code; empty = `options.currency`. */
  currency?: string;
  /** Typed exchange rate (foreign units per base unit); empty = the rate of the issue date. */
  exchangeRate?: string;
  billingAddress: PostalAddress;
  shipToDifferent: boolean;
  shippingAddress: PostalAddress;
  shipFromDifferent?: boolean;
  shipFromAddress?: PostalAddress;
  marketplaceFacilitated?: boolean;
  /** India GST: two-digit state code ('' = derive it from the customer). */
  placeOfSupply?: string;
  items: InvoiceLineValues[];
}

export interface InvoicePayloadOptions {
  mode: 'add' | 'edit';
  kind: TaxDocumentKind;
  /** The entity charges sales tax (a US entity): lines carry their tax code, use, inclusion and override. */
  salesTax: boolean;
  currency?: string | null;
  /** The user emptied an exchange rate the invoice held: look it up again. */
  resetExchangeRate?: boolean;
  /** The entity charges India GST: lines carry their HSN/SAC and the invoice its place of supply. */
  gst?: boolean;
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
      ...(options.gst ? { hsnSac: item.hsnSac?.trim() || null } : {}),
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
  // An empty place of supply is "derive it from the customer": on edit it is sent as null so a stored one is dropped.
  if (options.gst) payload.placeOfSupply = values.placeOfSupply || (mode === 'edit' ? null : undefined);
  const currency = values.currency || options.currency;
  if (currency) payload.currency = currency;
  Object.assign(payload, exchangeRatePayload(values.exchangeRate, options.resetExchangeRate));
  return payload;
}
