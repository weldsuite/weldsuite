/**
 * Invoice HTML Generator
 *
 * Entity/locale driven. The calling route passes the entity (providing locale, currency,
 * tax identifiers, branding) and the jurisdiction adapter supplies translated labels.
 *
 * Cloudflare Workers do not support native PDF libraries — this generates printable HTML
 * that can be converted to PDF via the browser's print dialog or a headless renderer.
 */

import type { Entity } from '@weldsuite/db/schema';
import { getAdapter } from './jurisdictions/registry';
import type { InvoiceLabels } from './jurisdictions/types';

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
  billingAddress?: {
    street?: string;
    houseNumber?: string;
    postalCode?: string;
    city?: string;
    country?: string;
  } | null;
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

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
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
  const primaryColor = branding.primaryColor || '#1a1a2e';
  const accentColor = branding.accentColor || '#16213e';

  const typeLabel = invoice.type === 'credit_note' ? labels.creditNote : labels.invoice;

  const taxIds = entity.taxIdentifiers ?? {};
  const bankDetails = entity.bankDetails ?? {};

  const itemRows = invoice.items
    .map(
      (item) => `
    <tr>
      <td style="padding:8px 12px;border-bottom:1px solid #eee;">${escapeHtml(item.description)}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:center;">${item.quantity}${item.unit ? ` ${item.unit}` : ''}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:right;">${fmtCurrency(item.unitPrice)}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:right;">${item.taxRate ? `${item.taxRate}%` : '\u2014'}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:right;font-weight:500;">${fmtCurrency(item.lineTotal)}</td>
    </tr>
  `,
    )
    .join('');

  const taxRows = (invoice.taxBreakdown || [])
    .map(
      (tb) => `
    <tr>
      <td style="padding:4px 0;">${labels.tax} ${tb.taxRate}% ${fmtCurrency(tb.taxableAmount)}</td>
      <td style="padding:4px 0;text-align:right;">${fmtCurrency(tb.taxAmount)}</td>
    </tr>
  `,
    )
    .join('');

  const addressBlock = invoice.billingAddress
    ? [
        invoice.billingAddress.street,
        invoice.billingAddress.houseNumber,
        [invoice.billingAddress.postalCode, invoice.billingAddress.city].filter(Boolean).join(' '),
        invoice.billingAddress.country,
      ]
        .filter(Boolean)
        .join('<br>')
    : '';

  const entityAddress = entity.address ?? {};
  const entityAddressBlock = [
    entityAddress.street,
    [entityAddress.postalCode, entityAddress.city].filter(Boolean).join(' '),
    entityAddress.country,
  ]
    .filter(Boolean)
    .join('<br>');

  const logoHtml = branding.logoUrl
    ? `<img src="${escapeHtml(branding.logoUrl)}" alt="${escapeHtml(entity.name)}" style="max-height:60px;max-width:200px;" />`
    : `<div style="font-size:24px;font-weight:bold;color:${primaryColor};">${escapeHtml(entity.name)}</div>`;

  const balanceDue = parseFloat(invoice.balanceDue || invoice.total);
  const amountPaid = parseFloat(invoice.amountPaid || '0');

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
      <div style="font-size:11px;text-transform:uppercase;color:#999;margin-bottom:8px;">${labels.billTo === 'Bill to' ? 'From' : 'Van'}</div>
      <div style="font-weight:600;">${escapeHtml(entity.legalName ?? entity.name)}</div>
      <div style="font-size:14px;color:#555;">${entityAddressBlock}</div>
      ${taxIds.registrationNumber ? `<div style="font-size:13px;color:#666;margin-top:8px;">${labels.registrationLabel}: ${escapeHtml(taxIds.registrationNumber)}</div>` : ''}
      ${taxIds.vatNumber ? `<div style="font-size:13px;color:#666;">${labels.vatNumberLabel}: ${escapeHtml(taxIds.vatNumber)}</div>` : ''}
    </div>
    <div style="flex:1;text-align:right;">
      <div style="font-size:11px;text-transform:uppercase;color:#999;margin-bottom:8px;">${labels.billTo}</div>
      <div style="font-weight:600;">${escapeHtml(invoice.contactName)}</div>
      ${addressBlock ? `<div style="font-size:14px;color:#555;">${addressBlock}</div>` : ''}
      ${invoice.contactEmail ? `<div style="font-size:13px;color:#666;margin-top:4px;">${escapeHtml(invoice.contactEmail)}</div>` : ''}
      ${invoice.contactVatNumber ? `<div style="font-size:13px;color:#666;">${labels.vatNumberLabel}: ${escapeHtml(invoice.contactVatNumber)}</div>` : ''}
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
    ${invoice.reference ? `<div>
      <div style="font-size:11px;text-transform:uppercase;color:#999;">Ref.</div>
      <div style="font-weight:500;">${escapeHtml(invoice.reference)}</div>
    </div>` : ''}
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
        ${parseFloat(invoice.discountTotal) > 0 ? `
        <tr>
          <td style="padding:6px 0;color:#666;">${labels.discount}</td>
          <td style="padding:6px 0;text-align:right;color:#e74c3c;">-${fmtCurrency(invoice.discountTotal)}</td>
        </tr>` : ''}
        ${taxRows}
        <tr>
          <td style="padding:6px 0;color:#666;">${labels.taxTotal}</td>
          <td style="padding:6px 0;text-align:right;">${fmtCurrency(invoice.taxTotal)}</td>
        </tr>
        <tr style="border-top:2px solid ${primaryColor};">
          <td style="padding:12px 0;font-size:18px;font-weight:bold;">${labels.total}</td>
          <td style="padding:12px 0;text-align:right;font-size:18px;font-weight:bold;">${fmtCurrency(invoice.total)}</td>
        </tr>
        ${amountPaid > 0 ? `
        <tr>
          <td style="padding:4px 0;color:#666;">${labels.amountPaid}</td>
          <td style="padding:4px 0;text-align:right;color:#27ae60;">-${fmtCurrency(amountPaid)}</td>
        </tr>
        <tr>
          <td style="padding:4px 0;font-weight:600;">${labels.balanceDue}</td>
          <td style="padding:4px 0;text-align:right;font-weight:600;">${fmtCurrency(balanceDue)}</td>
        </tr>` : ''}
      </table>
    </div>
  </div>

  ${(invoice.complianceNotices ?? []).length > 0 ? `
  <div style="margin-top:24px;padding:12px 16px;background:#fffbe6;border:1px solid #f0e6b8;border-radius:6px;">
    ${(invoice.complianceNotices ?? []).map((n) => `<div style="font-size:13px;font-weight:600;color:#5c4d00;">${escapeHtml(n)}</div>`).join('')}
  </div>` : ''}

  <div style="margin-top:40px;padding:20px;background:#f8f9fa;border-radius:6px;border-left:4px solid ${accentColor};">
    <div style="font-weight:600;margin-bottom:8px;">${labels.paymentInstructions}</div>
    <div style="font-size:14px;color:#555;">
      ${bankDetails.iban ? `<div>IBAN: <strong>${escapeHtml(bankDetails.iban)}</strong></div>` : ''}
      ${bankDetails.bic ? `<div>BIC: ${escapeHtml(bankDetails.bic)}</div>` : ''}
      ${bankDetails.accountNumber && !bankDetails.iban ? `<div>Account: <strong>${escapeHtml(bankDetails.accountNumber)}</strong></div>` : ''}
      ${bankDetails.routingNumber ? `<div>Routing: ${escapeHtml(bankDetails.routingNumber)}</div>` : ''}
      <div>${escapeHtml(entity.name)}</div>
      <div>Ref: ${escapeHtml(invoice.invoiceNumber)}</div>
    </div>
    ${branding.paymentInstructions ? `<div style="margin-top:8px;font-size:13px;color:#666;">${escapeHtml(branding.paymentInstructions)}</div>` : ''}
  </div>

  ${invoice.notes ? `
  <div style="margin-top:20px;">
    <div style="font-weight:600;margin-bottom:4px;">Notes</div>
    <div style="font-size:14px;color:#555;white-space:pre-wrap;">${escapeHtml(invoice.notes)}</div>
  </div>` : ''}

  ${branding.termsAndConditions ? `
  <div style="margin-top:30px;padding-top:20px;border-top:1px solid #eee;">
    <div style="font-size:12px;color:#666;">${escapeHtml(branding.termsAndConditions)}</div>
  </div>` : ''}

  ${requirements.requiredFooter ? `
  <div style="margin-top:20px;font-size:11px;color:#999;">${escapeHtml(requirements.requiredFooter)}</div>` : ''}

  ${branding.footerText ? `
  <div style="margin-top:30px;text-align:center;font-size:12px;color:#999;">
    ${escapeHtml(branding.footerText)}
  </div>` : ''}
</div>
</body>
</html>`;
}
