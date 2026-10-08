import type { PostalAddress } from '@/components/address/postal-address';
import { useTaxPreview, type TaxPreviewState } from '@/hooks/queries/use-weldbooks-tax-preview';
import type { TaxDocumentKind, TaxPreviewLine } from '@/lib/api/domains/weldbooks-sales-tax-preview';
import { buildTaxPreviewRequest, type TaxFormLine } from '@/lib/weldbooks/document-tax';
import { useCurrentJurisdiction } from '@/lib/weldbooks/use-jurisdiction';

export interface DocumentTaxPreviewArgs {
  kind: TaxDocumentKind;
  contactId?: string | null;
  issueDate?: string | null;
  currency?: string | null;
  billingAddress?: PostalAddress | null;
  /** Ship-to is a separate address only when this is set. */
  shipToDifferent?: boolean;
  shippingAddress?: PostalAddress | null;
  /** Ship-from is a separate origin only when this is set; otherwise the entity address applies. */
  shipFromDifferent?: boolean;
  shipFromAddress?: PostalAddress | null;
  deliveryAddress?: PostalAddress | null;
  marketplaceFacilitated?: boolean;
  originalInvoiceId?: string | null;
  lines: TaxFormLine[];
}

export interface DocumentTaxTotals {
  subtotal: number;
  discountTotal: number;
  taxTotal: number;
  total: number;
}

export interface DocumentTaxPreview {
  /** The entity charges sales tax (a US entity). */
  salesTax: boolean;
  preview: TaxPreviewState;
  /** The server's totals; zeros while nothing is priced or calculated yet. */
  totals: DocumentTaxTotals;
  /** The server's tax of line `index`, once calculated. */
  lineTax: (index: number) => TaxPreviewLine | undefined;
}

const ZERO_TOTALS: DocumentTaxTotals = { subtotal: 0, discountTotal: 0, taxTotal: 0, total: 0 };

/**
 * The preview of a document form: its state sent to the server's tax
 * calculation (debounced), for every jurisdiction. The forms show these
 * totals and per-line taxes instead of calculating anything themselves.
 */
export function useDocumentTaxPreview(args: Readonly<DocumentTaxPreviewArgs>): DocumentTaxPreview {
  const { features, isResolved } = useCurrentJurisdiction();
  const salesTax = features.salesTax;

  const request = buildTaxPreviewRequest({
    kind: args.kind,
    salesTax,
    contactId: args.contactId,
    issueDate: args.issueDate,
    currency: args.currency,
    billingAddress: args.billingAddress,
    shippingAddress: args.shipToDifferent ? args.shippingAddress : null,
    shipFromAddress: args.shipFromDifferent ? args.shipFromAddress : null,
    deliveryAddress: args.deliveryAddress,
    marketplaceFacilitated: args.marketplaceFacilitated,
    originalInvoiceId: args.originalInvoiceId,
    lines: args.lines,
  });
  const preview = useTaxPreview(request, { enabled: isResolved });

  const result = preview.result;
  const totals: DocumentTaxTotals = result
    ? {
        subtotal: Number(result.subtotal),
        discountTotal: Number(result.discountTotal),
        taxTotal: Number(result.taxTotal),
        total: Number(result.total),
      }
    : ZERO_TOTALS;

  return {
    salesTax,
    preview,
    totals,
    lineTax: (index) => result?.lines.find((line) => line.index === index),
  };
}
