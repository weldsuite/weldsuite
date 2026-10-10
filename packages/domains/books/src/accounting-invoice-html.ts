/**
 * Invoice HTML Generator
 *
 * Entity/locale driven. The calling route passes the entity (providing locale, currency,
 * tax identifiers, branding) and the jurisdiction adapter supplies translated labels.
 *
 * Cloudflare Workers do not support native PDF libraries — this generates printable HTML
 * that can be converted to PDF via the browser's print dialog or a headless renderer.
 */

import type { Entity, StoredPostalAddress } from '@weldsuite/db/schema';
import { formatPostalAddressLines, normalizePostalAddress } from './accounting-address';
import { getAdapter } from './jurisdictions/registry';
import type { InvoiceLabels } from './jurisdictions/types';
import { formatExemptSaleNotice } from './jurisdictions/us/invoice-format';

interface InvoiceLineItem {
  description: string;
  quantity: string;
  unitPrice: string;
  unit?: string | null;
  discountPercent?: string | null;
  taxRate?: string | null;
  lineTotal: string;
  lineTotalWithTax?: string;
  taxAmount?: string;
}

interface TaxBreakdownItem {
  taxRateName?: string;
  taxRate: number;
  taxableAmount: number;
  taxAmount: number;
  // US sales tax: one row per jurisdiction and line.
  lineId?: string;
  jurisdictionCode?: string;
  jurisdictionName?: string;
  jurisdictionLevel?: string;
  stateCode?: string;
  exemptAmount?: number;
  exemptReason?: string;
  certificateId?: string;
}

export interface InvoiceRenderData {
  invoiceNumber: string;
  type: string;
  issueDate: string;
  dueDate: string;
  currency: string;
  contactName: string;
  contactEmail?: string | null;
  /** Buyer's VAT number — mandatory on reverse-charge / intracommunautaire invoices. */
  contactVatNumber?: string | null;
  /**
   * Legally required statements rendered prominently on the document, e.g.
   * "BTW verlegd" (reverse charge) or the KOR exemption wording. The route
   * decides which apply based on the tax rates used and the entity's regime.
   */
  complianceNotices?: string[];
  /** Buyer's billing address, in the shared or the legacy (street/houseNumber) shape. */
  billingAddress?: StoredPostalAddress | null;
  /** Ship-to address; printed in its own block when it differs from the billing address. */
  shippingAddress?: StoredPostalAddress | null;
  reference?: string | null;
  notes?: string | null;
  items: InvoiceLineItem[];
  subtotal: string;
  discountTotal: string;
  taxTotal: string;
  total: string;
  amountPaid?: string;
  balanceDue?: string;
  taxBreakdown?: TaxBreakdownItem[];
  /** US: certificate number by certificate id, for the exempt-sale notice. */
  certificateNumbers?: Record<string, string | null | undefined>;
}

function makeCurrencyFmt(locale: string, currency: string) {
  return (value: string | number) =>
    new Intl.NumberFormat(locale, { style: 'currency', currency }).format(Number(value) || 0);
}

function makeDateFmt(locale: string) {
  return (dateStr: string) => {
    try {
      return new Intl.DateTimeFormat(locale, {
        day: '2-digit',
        month: 'long',
        year: 'numeric',
      }).format(new Date(dateStr));
    } catch {
      return dateStr;
    }
  };
}

/** Zero, negative or NaN (an unparseable amount): nothing to render. */
function isNotPositive(n: number): boolean {
  return Number.isNaN(n) || n <= 0;
}

function escapeHtml(str: string): string {
  return str
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll('\'', '&#039;');
}

/**
 * Branding colours are interpolated into inline `style` attributes, where
 * escaping alone still lets a value smuggle extra CSS in ("red;background:
 * url(...)"). Only plain colour values pass; anything else gets the default.
 */
const SAFE_COLOR = /^(#[0-9a-f]{3,8}|[a-z]{3,20}|(rgb|rgba|hsl|hsla)\([\d.,%\s/]+\))$/i;

function safeColor(value: string | null | undefined, fallback: string): string {
  const color = value?.trim();
  return color && SAFE_COLOR.test(color) ? escapeHtml(color) : fallback;
}

/** Logo URLs: http(s) or an inline image only, never `javascript:` and friends. */
function safeImageUrl(value: string | null | undefined): string | null {
  const url = value?.trim();
  return url && /^(https?:\/\/|data:image\/)/i.test(url) ? url : null;
}

type CurrencyFmt = (value: string | number) => string;
type Branding = NonNullable<Entity['branding']>;
type TaxIdentifiers = NonNullable<Entity['taxIdentifiers']>;
type BankDetails = NonNullable<Entity['bankDetails']>;

function buildItemRows(items: InvoiceLineItem[], fmtCurrency: CurrencyFmt): string {
  return items
    .map(
      (item) => `
    <tr>
      <td style="padding:8px 12px;border-bottom:1px solid #eee;">${escapeHtml(item.description)}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:center;">${escapeHtml(String(item.quantity))}${item.unit ? ` ${escapeHtml(item.unit)}` : ''}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:right;">${fmtCurrency(item.unitPrice)}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:right;">${item.taxRate ? `${escapeHtml(String(item.taxRate))}%` : '—'}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:right;font-weight:500;">${fmtCurrency(item.lineTotal)}</td>
    </tr>
  `,
    )
    .join('');
}

function buildTaxRows(
  taxBreakdown: TaxBreakdownItem[],
  labels: InvoiceLabels,
  fmtCurrency: CurrencyFmt,
): string {
  return taxBreakdown
    .map(
      (tb) => `
    <tr>
      <td style="padding:4px 0;">${labels.tax} ${escapeHtml(String(tb.taxRate))}% ${fmtCurrency(tb.taxableAmount)}</td>
      <td style="padding:4px 0;text-align:right;">${fmtCurrency(tb.taxAmount)}</td>
    </tr>
  `,
    )
    .join('');
}

const LEVEL_ORDER: Record<string, number> = { state: 0, county: 1, city: 2, district: 3 };

/** US sales tax rows: one per jurisdiction with the rate and the taxable amount, state first. */
function buildUsTaxRows(
  taxBreakdown: TaxBreakdownItem[],
  labels: InvoiceLabels,
  fmtCurrency: CurrencyFmt,
): string {
  const groups = new Map<string, { name: string; level: string; rate: number; taxable: number; tax: number }>();
  for (const row of taxBreakdown) {
    if (row.taxAmount === 0 && row.taxableAmount === 0) continue;
    const name = row.jurisdictionName ?? row.taxRateName ?? '';
    const key = `${row.jurisdictionCode ?? name}|${row.jurisdictionLevel ?? ''}|${row.taxRate}`;
    const group = groups.get(key);
    if (group) {
      group.taxable += row.taxableAmount;
      group.tax += row.taxAmount;
    } else {
      groups.set(key, {
        name,
        level: row.jurisdictionLevel ?? 'state',
        rate: row.taxRate,
        taxable: row.taxableAmount,
        tax: row.taxAmount,
      });
    }
  }
  return [...groups.values()]
    .sort((a, b) => (LEVEL_ORDER[a.level] ?? 9) - (LEVEL_ORDER[b.level] ?? 9) || a.name.localeCompare(b.name))
    .map(
      (g) => `
    <tr>
      <td style="padding:4px 0;">${escapeHtml(labels.tax)} - ${escapeHtml(g.name)} ${escapeHtml(String(g.rate))}% on ${fmtCurrency(g.taxable)}</td>
      <td style="padding:4px 0;text-align:right;">${fmtCurrency(g.tax)}</td>
    </tr>
  `,
    )
    .join('');
}

/**
 * "Exempt sale: Resale. Certificate no. X." once per certificate. A line taxed
 * by several agencies repeats its exempt part on each agency's row, so each
 * line counts once.
 */
function buildUsExemptNotices(
  taxBreakdown: TaxBreakdownItem[],
  certificateNumbers: InvoiceRenderData['certificateNumbers'],
  fmtCurrency: CurrencyFmt,
): string {
  const seenLines = new Set<string>();
  const notices = new Map<string, { reason: string; certificateId?: string; amount: number }>();
  for (const row of taxBreakdown) {
    if (!row.exemptReason || isNotPositive(row.exemptAmount ?? 0)) continue;
    if (row.lineId) {
      if (seenLines.has(row.lineId)) continue;
      seenLines.add(row.lineId);
    }
    const key = `${row.exemptReason}|${row.certificateId ?? ''}`;
    const notice = notices.get(key);
    if (notice) notice.amount += row.exemptAmount ?? 0;
    else notices.set(key, { reason: row.exemptReason, certificateId: row.certificateId, amount: row.exemptAmount ?? 0 });
  }
  if (notices.size === 0) return '';
  const lines = [...notices.values()]
    .map((n) => {
      const number = n.certificateId ? certificateNumbers?.[n.certificateId] : null;
      return `<div>${escapeHtml(formatExemptSaleNotice(n.reason, number))} (${fmtCurrency(n.amount)} not taxed)</div>`;
    })
    .join('');
  return `
      <div style="margin-top:12px;font-size:12px;color:#666;">${lines}</div>`;
}

/**
 * An address as escaped HTML lines (either stored shape; state and county
 * included). `omitCountry` drops the country line when it equals that code.
 */
function buildAddressBlock(
  address: StoredPostalAddress | null | undefined,
  omitCountry?: string,
): string {
  return formatPostalAddressLines(address, { omitCountry }).map(escapeHtml).join('<br>');
}

/** The ship-to address, only when there is one and it isn't the billing address. */
function distinctShippingAddress(invoice: InvoiceRenderData): StoredPostalAddress | null {
  const shipping = normalizePostalAddress(invoice.shippingAddress);
  if (!shipping) return null;
  const billing = normalizePostalAddress(invoice.billingAddress);
  return JSON.stringify(shipping) === JSON.stringify(billing) ? null : shipping;
}

function buildShipToBlock(shipToBlock: string, labels: InvoiceLabels): string {
  if (!shipToBlock) return '';
  return `<div style="margin-top:16px;">
        <div style="font-size:11px;text-transform:uppercase;color:#999;margin-bottom:8px;">${escapeHtml(labels.shipTo)}</div>
        <div style="font-size:14px;color:#555;">${shipToBlock}</div>
      </div>`;
}

function buildLogoHtml(branding: Branding, entityName: string, primaryColor: string): string {
  const logoUrl = safeImageUrl(branding.logoUrl);
  return logoUrl
    ? `<img src="${escapeHtml(logoUrl)}" alt="${escapeHtml(entityName)}" style="max-height:60px;max-width:200px;" />`
    : `<div style="font-size:24px;font-weight:bold;color:${primaryColor};">${escapeHtml(entityName)}</div>`;
}

function buildSellerTaxIds(taxIds: TaxIdentifiers, labels: InvoiceLabels): string {
  const registration = taxIds.registrationNumber
    ? `<div style="font-size:13px;color:#666;margin-top:8px;">${labels.registrationLabel}: ${escapeHtml(taxIds.registrationNumber)}</div>`
    : '';
  const vat = taxIds.vatNumber
    ? `<div style="font-size:13px;color:#666;">${labels.vatNumberLabel}: ${escapeHtml(taxIds.vatNumber)}</div>`
    : '';
  return `${registration}\n      ${vat}`;
}

function buildBuyerDetails(
  invoice: InvoiceRenderData,
  addressBlock: string,
  labels: InvoiceLabels,
): string {
  const address = addressBlock ? `<div style="font-size:14px;color:#555;">${addressBlock}</div>` : '';
  const email = invoice.contactEmail
    ? `<div style="font-size:13px;color:#666;margin-top:4px;">${escapeHtml(invoice.contactEmail)}</div>`
    : '';
  const vat = invoice.contactVatNumber
    ? `<div style="font-size:13px;color:#666;">${labels.vatNumberLabel}: ${escapeHtml(invoice.contactVatNumber)}</div>`
    : '';
  return `${address}\n      ${email}\n      ${vat}`;
}

function buildReferenceBlock(reference: string | null | undefined): string {
  if (!reference) return '';
  return `<div>
      <div style="font-size:11px;text-transform:uppercase;color:#999;">Ref.</div>
      <div style="font-weight:500;">${escapeHtml(reference)}</div>
    </div>`;
}

function buildDiscountRow(
  discountTotal: string,
  labels: InvoiceLabels,
  fmtCurrency: CurrencyFmt,
): string {
  if (isNotPositive(Number.parseFloat(discountTotal))) return '';
  return `
        <tr>
          <td style="padding:6px 0;color:#666;">${labels.discount}</td>
          <td style="padding:6px 0;text-align:right;color:#e74c3c;">-${fmtCurrency(discountTotal)}</td>
        </tr>`;
}

function buildPaidRows(
  amountPaid: number,
  balanceDue: number,
  labels: InvoiceLabels,
  fmtCurrency: CurrencyFmt,
): string {
  if (isNotPositive(amountPaid)) return '';
  return `
        <tr>
          <td style="padding:4px 0;color:#666;">${labels.amountPaid}</td>
          <td style="padding:4px 0;text-align:right;color:#27ae60;">-${fmtCurrency(amountPaid)}</td>
        </tr>
        <tr>
          <td style="padding:4px 0;font-weight:600;">${labels.balanceDue}</td>
          <td style="padding:4px 0;text-align:right;font-weight:600;">${fmtCurrency(balanceDue)}</td>
        </tr>`;
}

function buildComplianceBlock(notices: string[]): string {
  if (notices.length === 0) return '';
  const rows = notices
    .map((n) => `<div style="font-size:13px;font-weight:600;color:#5c4d00;">${escapeHtml(n)}</div>`)
    .join('');
  return `
  <div style="margin-top:24px;padding:12px 16px;background:#fffbe6;border:1px solid #f0e6b8;border-radius:6px;">
    ${rows}
  </div>`;
}

function buildBankDetailsHtml(bankDetails: BankDetails): string {
  const iban = bankDetails.iban ? `<div>IBAN: <strong>${escapeHtml(bankDetails.iban)}</strong></div>` : '';
  const bic = bankDetails.bic ? `<div>BIC: ${escapeHtml(bankDetails.bic)}</div>` : '';
  const account =
    bankDetails.accountNumber && !bankDetails.iban
      ? `<div>Account: <strong>${escapeHtml(bankDetails.accountNumber)}</strong></div>`
      : '';
  const routing = bankDetails.routingNumber
    ? `<div>Routing: ${escapeHtml(bankDetails.routingNumber)}</div>`
    : '';
  return `${iban}\n      ${bic}\n      ${account}\n      ${routing}`;
}

function buildPaymentInstructionsNote(text: string | null | undefined): string {
  return text
    ? `<div style="margin-top:8px;font-size:13px;color:#666;">${escapeHtml(text)}</div>`
    : '';
}

function buildNotesBlock(notes: string | null | undefined): string {
  if (!notes) return '';
  return `
  <div style="margin-top:20px;">
    <div style="font-weight:600;margin-bottom:4px;">Notes</div>
    <div style="font-size:14px;color:#555;white-space:pre-wrap;">${escapeHtml(notes)}</div>
  </div>`;
}

function buildTermsBlock(terms: string | null | undefined): string {
  if (!terms) return '';
  return `
  <div style="margin-top:30px;padding-top:20px;border-top:1px solid #eee;">
    <div style="font-size:12px;color:#666;">${escapeHtml(terms)}</div>
  </div>`;
}

function buildRequiredFooterBlock(footer: string | null | undefined): string {
  if (!footer) return '';
  return `
  <div style="margin-top:20px;font-size:11px;color:#999;">${escapeHtml(footer)}</div>`;
}

function buildFooterTextBlock(footerText: string | null | undefined): string {
  if (!footerText) return '';
  return `
  <div style="margin-top:30px;text-align:center;font-size:12px;color:#999;">
    ${escapeHtml(footerText)}
  </div>`;
}

export function generateInvoiceHtml(invoice: InvoiceRenderData, entity: Entity): string {
  const locale = entity.locale || 'en-US';
  const currency = invoice.currency || entity.baseCurrency || 'EUR';
  const adapter = getAdapter(entity.jurisdictionCode);
  const requirements = adapter.getInvoiceRequirements(locale);
  const labels: InvoiceLabels = requirements.labels;

  const fmtCurrency = makeCurrencyFmt(locale, currency);
  const fmtDate = makeDateFmt(locale);

  const branding = entity.branding ?? {};
  const primaryColor = safeColor(branding.primaryColor, '#1a1a2e');
  const accentColor = safeColor(branding.accentColor, '#16213e');

  const typeLabel = invoice.type === 'credit_note' ? labels.creditNote : labels.invoice;

  const taxIds = entity.taxIdentifiers ?? {};
  const bankDetails = entity.bankDetails ?? {};

  const itemRows = buildItemRows(invoice.items, fmtCurrency);
  // US sales tax prints per jurisdiction, and an exempt sale prints its reason and certificate.
  const taxBreakdown = invoice.taxBreakdown || [];
  const usSalesTax = adapter.features.salesTax && taxBreakdown.some((row) => row.jurisdictionName);
  const taxRows = usSalesTax
    ? buildUsTaxRows(taxBreakdown, labels, fmtCurrency)
    : buildTaxRows(taxBreakdown, labels, fmtCurrency);
  const exemptNotices = usSalesTax
    ? buildUsExemptNotices(taxBreakdown, invoice.certificateNumbers, fmtCurrency)
    : '';
  // Countries print only when the invoice crosses a border: the buyer's
  // addresses drop the seller's own country, and the seller's address shows
  // its country only to a foreign buyer.
  const sellerCountry = (
    normalizePostalAddress(entity.address)?.country ?? entity.jurisdictionCode
  ).toUpperCase();
  const buyerCountry = normalizePostalAddress(invoice.billingAddress)?.country;
  const crossBorder = !!buyerCountry && buyerCountry !== sellerCountry;
  const addressBlock = buildAddressBlock(invoice.billingAddress, sellerCountry);
  const shipToBlock = buildAddressBlock(distinctShippingAddress(invoice), sellerCountry);
  const entityAddressBlock = buildAddressBlock(entity.address, crossBorder ? undefined : sellerCountry);
  const logoHtml = buildLogoHtml(branding, entity.name, primaryColor);

  const balanceDue = Number.parseFloat(invoice.balanceDue || invoice.total);
  const amountPaid = Number.parseFloat(invoice.amountPaid || '0');

  return `<!DOCTYPE html>
<html lang="${escapeHtml(locale.split('-')[0])}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${typeLabel} ${escapeHtml(invoice.invoiceNumber)}</title>
<style>
  @media print {
    body { margin: 0; }
    .no-print { display: none !important; }
  }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; color: #333; line-height: 1.5; margin: 0; padding: 0; }
  .container { max-width: 800px; margin: 0 auto; padding: 40px; }
  table { border-collapse: collapse; width: 100%; }
</style>
</head>
<body>
<div class="container">
  <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:40px;">
    <div>${logoHtml}</div>
    <div style="text-align:right;">
      <div style="font-size:28px;font-weight:bold;color:${primaryColor};text-transform:uppercase;">${typeLabel}</div>
      <div style="font-size:16px;color:#666;margin-top:4px;">${escapeHtml(invoice.invoiceNumber)}</div>
    </div>
  </div>

  <div style="display:flex;justify-content:space-between;margin-bottom:30px;">
    <div style="flex:1;">
      <div style="font-size:11px;text-transform:uppercase;color:#999;margin-bottom:8px;">${escapeHtml(labels.from)}</div>
      <div style="font-weight:600;">${escapeHtml(entity.legalName ?? entity.name)}</div>
      <div style="font-size:14px;color:#555;">${entityAddressBlock}</div>
      ${buildSellerTaxIds(taxIds, labels)}
    </div>
    <div style="flex:1;text-align:right;">
      <div style="font-size:11px;text-transform:uppercase;color:#999;margin-bottom:8px;">${labels.billTo}</div>
      <div style="font-weight:600;">${escapeHtml(invoice.contactName)}</div>
      ${buildBuyerDetails(invoice, addressBlock, labels)}
      ${buildShipToBlock(shipToBlock, labels)}
    </div>
  </div>

  <div style="display:flex;gap:40px;margin-bottom:30px;padding:16px;background:#f8f9fa;border-radius:6px;">
    <div>
      <div style="font-size:11px;text-transform:uppercase;color:#999;">${labels.date}</div>
      <div style="font-weight:500;">${fmtDate(invoice.issueDate)}</div>
    </div>
    <div>
      <div style="font-size:11px;text-transform:uppercase;color:#999;">${labels.dueDate}</div>
      <div style="font-weight:500;">${fmtDate(invoice.dueDate)}</div>
    </div>
    ${buildReferenceBlock(invoice.reference)}
  </div>

  <table style="margin-bottom:24px;">
    <thead>
      <tr style="background:${primaryColor};color:white;">
        <th style="padding:10px 12px;text-align:left;font-weight:500;">${labels.description}</th>
        <th style="padding:10px 12px;text-align:center;font-weight:500;width:80px;">${labels.quantity}</th>
        <th style="padding:10px 12px;text-align:right;font-weight:500;width:120px;">${labels.unitPrice}</th>
        <th style="padding:10px 12px;text-align:right;font-weight:500;width:80px;">${labels.tax}</th>
        <th style="padding:10px 12px;text-align:right;font-weight:500;width:120px;">${labels.amount}</th>
      </tr>
    </thead>
    <tbody>
      ${itemRows}
    </tbody>
  </table>

  <div style="display:flex;justify-content:flex-end;">
    <div style="width:300px;">
      <table>
        <tr>
          <td style="padding:6px 0;color:#666;">${labels.subtotal}</td>
          <td style="padding:6px 0;text-align:right;">${fmtCurrency(invoice.subtotal)}</td>
        </tr>
        ${buildDiscountRow(invoice.discountTotal, labels, fmtCurrency)}
        ${taxRows}
        <tr>
          <td style="padding:6px 0;color:#666;">${labels.taxTotal}</td>
          <td style="padding:6px 0;text-align:right;">${fmtCurrency(invoice.taxTotal)}</td>
        </tr>
        <tr style="border-top:2px solid ${primaryColor};">
          <td style="padding:12px 0;font-size:18px;font-weight:bold;">${labels.total}</td>
          <td style="padding:12px 0;text-align:right;font-size:18px;font-weight:bold;">${fmtCurrency(invoice.total)}</td>
        </tr>
        ${buildPaidRows(amountPaid, balanceDue, labels, fmtCurrency)}
      </table>${exemptNotices}
    </div>
  </div>

  ${buildComplianceBlock(invoice.complianceNotices ?? [])}

  <div style="margin-top:40px;padding:20px;background:#f8f9fa;border-radius:6px;border-left:4px solid ${accentColor};">
    <div style="font-weight:600;margin-bottom:8px;">${labels.paymentInstructions}</div>
    <div style="font-size:14px;color:#555;">
      ${buildBankDetailsHtml(bankDetails)}
      <div>${escapeHtml(entity.name)}</div>
      <div>Ref: ${escapeHtml(invoice.invoiceNumber)}</div>
    </div>
    ${buildPaymentInstructionsNote(branding.paymentInstructions)}
  </div>

  ${buildNotesBlock(invoice.notes)}

  ${buildTermsBlock(branding.termsAndConditions)}

  ${buildRequiredFooterBlock(requirements.requiredFooter)}

  ${buildFooterTextBlock(branding.footerText)}
</div>
</body>
</html>`;
}
