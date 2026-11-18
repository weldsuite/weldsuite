import type { JurisdictionFeatures } from './jurisdiction';

export const WELDBOOKS_TAX_HREF = '/weldbooks/vat';
export const WELDBOOKS_FORM_1099_HREF = '/weldbooks/form-1099';
export const WELDBOOKS_RECEIVED_NFE_HREF = '/weldbooks/received-nfe';

/** Screens that only exist for jurisdictions with US sales tax. */
export const WELDBOOKS_SALES_TAX_HREFS: ReadonlySet<string> = new Set([
  '/weldbooks/sales-tax',
  '/weldbooks/sales-tax/certificates',
  '/weldbooks/sales-tax/nexus',
  '/weldbooks/tax-calendar',
  '/weldbooks/payment-runs',
  '/weldbooks/deposits',
  '/weldbooks/banking/statements',
  '/weldbooks/reports/tax-worksheet',
]);

/**
 * Whether the WeldBooks menu entry for `href` is offered to the selected
 * entity. The sidebar and the command palette both read this, so a Dutch
 * entity never gets a US-only page from either. Until the jurisdiction is
 * known (`known` false) every gated entry stays hidden.
 */
export function isWeldbooksHrefVisible(
  href: string,
  { known, features }: Readonly<{ known: boolean; features: JurisdictionFeatures }>,
): boolean {
  if (href === WELDBOOKS_TAX_HREF) return known && (features.vatReturn || features.gstReturn || features.brTaxReturn);
  if (href === WELDBOOKS_RECEIVED_NFE_HREF) return known && features.fiscalDocuments;
  if (href === WELDBOOKS_FORM_1099_HREF) return known && features.form1099;
  if (WELDBOOKS_SALES_TAX_HREFS.has(href)) return known && features.salesTax;
  return true;
}
