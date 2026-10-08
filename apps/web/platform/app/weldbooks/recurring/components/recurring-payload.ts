import { cleanPostalAddress, type PostalAddress } from '@/components/address/postal-address';
import type { RecurringInvoice } from '@/lib/api/domains/weldbooks';
import type { RecurringTemplateTaxItem } from '@/lib/api/domains/weldbooks-sales-tax-preview';
import { cleanTaxRateId } from '@/lib/weldbooks/document-tax';
import { dimensionPayload, type SalesTaxLineValues } from '@/lib/weldbooks/document-tax-form';

export const RECURRING_FREQUENCIES = ['weekly', 'biweekly', 'monthly', 'quarterly', 'biannually', 'yearly'] as const;
export type RecurringFrequency = (typeof RECURRING_FREQUENCIES)[number];

/** A line of the recurring invoice form. */
export interface RecurringLineValues extends Partial<SalesTaxLineValues> {
  description: string;
  quantity: number | string;
  unitPrice: number | string;
  /** VAT / GST rate (NL, IN). */
  taxRateId?: string | null;
  /** Carried through an edit; the form doesn't show them. */
  unit?: string;
  accountId?: string;
}

export interface RecurringFormShape {
  name?: string;
  contactId: string;
  frequency: RecurringFrequency;
  nextIssueDate: string;
  endDate?: string;
  autoFinalize: boolean;
  autoSend: boolean;
  paymentTermsDays?: number | string;
  reference?: string;
  notes?: string;
  shipFromDifferent?: boolean;
  shipFromAddress?: PostalAddress;
  items: RecurringLineValues[];
}

export interface RecurringPayloadOptions {
  mode: 'add' | 'edit';
  /** The entity charges sales tax (a US entity): lines carry tax code, use and inclusion; the template an origin. */
  salesTax: boolean;
  currency?: string | null;
  /** The template as stored, so fields the form doesn't show (internal notes, revenue account) survive an edit. */
  existing?: RecurringInvoice['templateData'];
}

/** One template line. Template amounts are numbers (the schema of `recurring_invoices.template_data`). */
function templateItem(item: RecurringLineValues, salesTax: boolean): RecurringTemplateTaxItem {
  return {
    description: item.description,
    quantity: Number(item.quantity) || 0,
    unitPrice: Number(item.unitPrice) || 0,
    unit: item.unit || undefined,
    accountId: item.accountId || null,
    taxRateId: salesTax ? null : cleanTaxRateId(item.taxRateId),
    ...(salesTax
      ? {
          productId: item.productId || null,
          taxCode: item.taxCode || null,
          taxUse: item.taxUse || null,
          taxIncluded: item.taxIncluded ?? false,
        }
      : {}),
    ...dimensionPayload(item),
  };
}

/**
 * The create / update body of a recurring invoice. Tax is not calculated here:
 * the template keeps each line's tax code, use and inclusion (US) or rate
 * (VAT / GST), and the server taxes every invoice it generates from the
 * customer's address on that day.
 */
export function buildRecurringPayload(values: RecurringFormShape, options: RecurringPayloadOptions): Record<string, unknown> {
  const { salesTax, existing } = options;
  const shipFrom = values.shipFromDifferent ? cleanPostalAddress(values.shipFromAddress) : undefined;
  const terms = Number(values.paymentTermsDays);

  const templateData = {
    ...(existing ?? {}),
    items: values.items.map((item) => templateItem(item, salesTax)),
    notes: values.notes || undefined,
    reference: values.reference || undefined,
    paymentTermsDays: Number.isFinite(terms) && terms > 0 ? terms : undefined,
    currency: options.currency || existing?.currency || undefined,
    ...(salesTax ? { shipFromAddress: shipFrom ?? null } : {}),
  };

  return {
    name: values.name || undefined,
    contactId: values.contactId,
    frequency: values.frequency,
    nextIssueDate: values.nextIssueDate,
    endDate: values.endDate || undefined,
    autoFinalize: values.autoFinalize,
    autoSend: values.autoSend,
    templateData,
  };
}
