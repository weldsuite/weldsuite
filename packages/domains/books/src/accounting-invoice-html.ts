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
import { gstStateName } from './jurisdictions/in/states';
import { pixQrMatrix, pixQrSvg } from './jurisdictions/br/pix';
import type { InvoiceDocumentData, TotalsRowData } from './invoice-template/data';
import { layoutInvoice } from './invoice-template/layout';
import type { InvoiceTemplateDocument } from './invoice-template/schema';
import { renderInvoiceHtmlDocument } from './invoice-template/svg';

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
  /** India GST: HSN (goods) or SAC (services) code. */
  hsnSac?: string | null;
}

interface TaxBreakdownItem {
  taxRateName?: string;
  taxRate: number;
  taxableAmount: number;
  taxAmount: number;
  /** India GST: cgst | sgst | utgst | igst | export when the slab was split. */
  component?: string;
  // US sales tax: one row per jurisdiction and line.
  lineId?: string;
  jurisdictionCode?: string;
  jurisdictionName?: string;
  jurisdictionLevel?: string;
  stateCode?: string;
  exemptAmount?: number;
  exemptReason?: string;
  certificateId?: string;
  /** Brazil: added | embedded | withheld | informational. */
  treatment?: string;
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
  /** India GST: two-digit state code of the place of supply (96 = outside India). */
  placeOfSupply?: string | null;
  /** US: certificate number by certificate id, for the exempt-sale notice. */
  certificateNumbers?: Record<string, string | null | undefined>;
  /** A draft prints a "not a valid invoice" banner and a watermark: it isn't booked and can still change. */
  draft?: boolean;
  /** Brazil: Pix BR Code for the amount due (see jurisdictions/br/pix). */
  pix?: { key: string; payload: string } | null;
  /** Brazil: the authorised fiscal document of the invoice. */
  fiscalDocument?: { label: string; number?: string | null; accessKey?: string | null } | null;
}

function makeCurrencyFmt(locale: string, currency: string) {
  return (value: string | number) =>
    new Intl.NumberFormat(locale, { style: 'currency', currency }).format(Number(value) || 0);
}

/** Quantities and rates without trailing zeros ("10", "21", "7.5"), in the document's locale. */
function makeNumberFmt(locale: string) {
  const fmt = new Intl.NumberFormat(locale, { maximumFractionDigits: 4 });
  return (value: string | number) => {
    const n = Number(value);
    return Number.isFinite(n) ? fmt.format(n) : String(value);
  };
}

function makeDateFmt(locale: string) {
  return (dateStr: string) => {
    try {
      return new Intl.DateTimeFormat(locale, {
        day: 'numeric',
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
type NumberFmt = (value: string | number) => string;
type Branding = NonNullable<Entity['branding']>;
type TaxIdentifiers = NonNullable<Entity['taxIdentifiers']>;
type BankDetails = NonNullable<Entity['bankDetails']>;

function buildItemRows(items: InvoiceLineItem[], fmtCurrency: CurrencyFmt, fmtNumber: NumberFmt): string {
  return items
    .map(
      (item) => `
    <tr>
      <td style="padding:8px 12px;border-bottom:1px solid #eee;">${escapeHtml(item.description)}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:center;">${escapeHtml(fmtNumber(item.quantity))}${item.unit ? ` ${escapeHtml(item.unit)}` : ''}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:right;">${fmtCurrency(item.unitPrice)}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:right;">${item.taxRate ? `${escapeHtml(fmtNumber(item.taxRate))}%` : '—'}</td>
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
  fmtNumber: NumberFmt,
): string {
  return taxBreakdown
    .map(
      (tb) => `
    <tr>
      <td style="padding:4px 0;">${labels.tax} ${escapeHtml(fmtNumber(tb.taxRate))}% ${fmtCurrency(tb.taxableAmount)}</td>
      <td style="padding:4px 0;text-align:right;">${fmtCurrency(tb.taxAmount)}</td>
    </tr>
  `,
    )
    .join('');
}

const LEVEL_ORDER: Record<string, number> = { state: 0, county: 1, city: 2, district: 3 };

interface UsTaxGroup {
  name: string;
  level: string;
  rate: number;
  taxable: number;
  tax: number;
}

/** US sales tax groups: one per jurisdiction and rate, state first. */
function usTaxGroups(taxBreakdown: TaxBreakdownItem[]): UsTaxGroup[] {
  const groups = new Map<string, UsTaxGroup>();
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
  return [...groups.values()].sort((a, b) => (LEVEL_ORDER[a.level] ?? 9) - (LEVEL_ORDER[b.level] ?? 9) || a.name.localeCompare(b.name));
}

/** US sales tax rows: one per jurisdiction with the rate and the taxable amount, state first. */
function buildUsTaxRows(
  taxBreakdown: TaxBreakdownItem[],
  labels: InvoiceLabels,
  fmtCurrency: CurrencyFmt,
  fmtNumber: NumberFmt,
): string {
  return usTaxGroups(taxBreakdown)
    .map(
      (g) => `
    <tr>
      <td style="padding:4px 0;">${escapeHtml(labels.tax)} - ${escapeHtml(g.name)} ${escapeHtml(fmtNumber(g.rate))}% on ${fmtCurrency(g.taxable)}</td>
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
function usExemptNotices(
  taxBreakdown: TaxBreakdownItem[],
  certificateNumbers: InvoiceRenderData['certificateNumbers'],
  fmtCurrency: CurrencyFmt,
): string[] {
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
  return [...notices.values()].map((n) => {
    const number = n.certificateId ? certificateNumbers?.[n.certificateId] : null;
    return `${formatExemptSaleNotice(n.reason, number)} (${fmtCurrency(n.amount)} not taxed)`;
  });
}

function buildUsExemptNotices(
  taxBreakdown: TaxBreakdownItem[],
  certificateNumbers: InvoiceRenderData['certificateNumbers'],
  fmtCurrency: CurrencyFmt,
): string {
  const notices = usExemptNotices(taxBreakdown, certificateNumbers, fmtCurrency);
  if (notices.length === 0) return '';
  const lines = notices.map((n) => `<div>${escapeHtml(n)}</div>`).join('');
  return `
      <div style="margin-top:12px;font-size:12px;color:#666;">${lines}</div>`;
}

// ---------------------------------------------------------------------------
// India GST tax invoice (CBIC Rule 46)
// ---------------------------------------------------------------------------

type GstSupply = 'intra' | 'inter' | 'export' | 'unknown';

const GST_COMPONENT_LABEL: Record<string, string> = { cgst: 'CGST', sgst: 'SGST', utgst: 'UTGST', igst: 'IGST' };

function gstSupplyOf(taxBreakdown: TaxBreakdownItem[]): { supply: GstSupply; stateTax: 'sgst' | 'utgst' } {
  const components = new Set(taxBreakdown.map((row) => row.component).filter((c): c is string => Boolean(c)));
  const stateTax = components.has('utgst') ? 'utgst' : 'sgst';
  if (components.has('igst')) return { supply: 'inter', stateTax };
  if (components.has('cgst')) return { supply: 'intra', stateTax };
  if (components.has('export')) return { supply: 'export', stateTax };
  return { supply: 'unknown', stateTax };
}

function roundCents(n: number): number {
  return Math.round(n * 100) / 100;
}

/** "Maharashtra (27)" for a place-of-supply code. */
function gstPlaceOfSupplyText(code: string | null | undefined): string {
  if (!code) return '';
  const name = gstStateName(code);
  return name ? `${name} (${code})` : code;
}

function buildGstPlaceOfSupplyBlock(code: string | null | undefined, labels: InvoiceLabels): string {
  const text = gstPlaceOfSupplyText(code);
  if (!text) return '';
  return `<div>
      <div style="font-size:11px;text-transform:uppercase;color:#999;">${escapeHtml(labels.placeOfSupply ?? 'Place of supply')}</div>
      <div style="font-weight:500;">${escapeHtml(text)}</div>
    </div>`;
}

/**
 * The line table of an Indian tax invoice: HSN/SAC, taxable value and, per
 * line, the CGST and SGST (or UTGST) rate and amount, or the IGST rate and
 * amount. A line's CGST is its own half of the slab rounded to the paisa and
 * SGST takes the remainder, the same split the tax calculation stores.
 */
function buildGstItemsTable(
  items: InvoiceLineItem[],
  taxBreakdown: TaxBreakdownItem[],
  labels: InvoiceLabels,
  fmtCurrency: CurrencyFmt,
  fmtNumber: NumberFmt,
  primaryColor: string,
): string {
  const { supply, stateTax } = gstSupplyOf(taxBreakdown);
  const split = supply === 'intra';
  const stateLabel = GST_COMPONENT_LABEL[stateTax];
  const th = (text: string, align = 'right') =>
    `<th style="padding:8px 6px;text-align:${align};font-weight:500;font-size:11px;">${escapeHtml(text)}</th>`;
  const td = (html: string, align = 'right', extra = '') =>
    `<td style="padding:6px;border-bottom:1px solid #eee;text-align:${align};font-size:12px;${extra}">${html}</td>`;

  const taxHeads = split
    ? [th('CGST %'), th('CGST'), th(`${stateLabel} %`), th(stateLabel)].join('')
    : [th(supply === 'inter' ? 'IGST %' : `${labels.tax} %`), th(supply === 'inter' ? 'IGST' : labels.tax)].join('');

  const rows = items
    .map((item) => {
      const rate = Number.parseFloat(item.taxRate ?? '0') || 0;
      const lineTax = Number.parseFloat(item.taxAmount ?? '0') || 0;
      const taxable = Number.parseFloat(item.lineTotal) || 0;
      let taxCells: string;
      if (split) {
        const cgst = roundCents((taxable * (rate / 2)) / 100);
        const state = roundCents(lineTax - cgst);
        taxCells = [
          td(`${escapeHtml(fmtNumber(rate / 2))}%`),
          td(fmtCurrency(cgst)),
          td(`${escapeHtml(fmtNumber(rate / 2))}%`),
          td(fmtCurrency(state)),
        ].join('');
      } else {
        taxCells = [td(rate ? `${escapeHtml(fmtNumber(rate))}%` : '—'), td(fmtCurrency(lineTax))].join('');
      }
      const unit = item.unit ? ' ' + escapeHtml(item.unit) : '';
      const quantity = escapeHtml(fmtNumber(item.quantity)) + unit;
      return `
    <tr>
      ${td(escapeHtml(item.description), 'left')}
      ${td(item.hsnSac ? escapeHtml(item.hsnSac) : '—', 'center')}
      ${td(quantity, 'center')}
      ${td(fmtCurrency(item.unitPrice))}
      ${td(fmtCurrency(item.lineTotal), 'right', 'font-weight:500;')}
      ${taxCells}
    </tr>`;
    })
    .join('');

  return `<table style="margin-bottom:24px;">
    <thead>
      <tr style="background:${primaryColor};color:white;">
        ${th(labels.description, 'left')}
        ${th(labels.hsnSac ?? 'HSN/SAC', 'center')}
        ${th(labels.quantity, 'center')}
        ${th(labels.unitPrice)}
        ${th(labels.taxableValue ?? 'Taxable value')}
        ${taxHeads}
      </tr>
    </thead>
    <tbody>${rows}
    </tbody>
  </table>`;
}

interface GstTaxGroup {
  component?: string;
  rate: number;
  taxable: number;
  tax: number;
}

/** India GST groups: one per component and rate, in CGST / SGST / UTGST / IGST order. */
function gstTaxGroups(taxBreakdown: TaxBreakdownItem[]): GstTaxGroup[] {
  const order = ['cgst', 'sgst', 'utgst', 'igst'];
  const groups = new Map<string, GstTaxGroup>();
  for (const row of taxBreakdown) {
    if (row.component === 'export') continue;
    const key = `${row.component ?? ''}|${row.taxRate}`;
    const group = groups.get(key);
    if (group) {
      group.taxable += row.taxableAmount;
      group.tax += row.taxAmount;
    } else {
      groups.set(key, { component: row.component, rate: row.taxRate, taxable: row.taxableAmount, tax: row.taxAmount });
    }
  }
  return [...groups.values()].sort((a, b) => order.indexOf(a.component ?? '') - order.indexOf(b.component ?? '') || a.rate - b.rate);
}

/** Tax totals of an Indian invoice: one row per component and rate (CGST 9%, SGST 9%, IGST 18%), taxable value included. */
function buildGstTaxRows(
  taxBreakdown: TaxBreakdownItem[],
  labels: InvoiceLabels,
  fmtCurrency: CurrencyFmt,
  fmtNumber: NumberFmt,
): string {
  return gstTaxGroups(taxBreakdown)
    .map((g) => {
      const label = g.component ? (GST_COMPONENT_LABEL[g.component] ?? labels.tax) : labels.tax;
      return `
    <tr>
      <td style="padding:4px 0;">${escapeHtml(label)} ${escapeHtml(fmtNumber(g.rate))}% ${fmtCurrency(g.taxable)}</td>
      <td style="padding:4px 0;text-align:right;">${fmtCurrency(g.tax)}</td>
    </tr>`;
    })
    .join('');
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

/** A titled group of Brazilian tax rows (name, base, amount); `sign` -1 prints them as deductions. */
function brTaxGroup(title: string, rows: TaxBreakdownItem[], fmtCurrency: CurrencyFmt, sign: 1 | -1 = 1): string {
  if (rows.length === 0) return '';
  const lines = rows
    .map(
      (row) => `
        <tr>
          <td style="padding:2px 0 2px 8px;color:#666;font-size:13px;">${escapeHtml(row.taxRateName ?? '')} <span style="color:#999;">(${fmtCurrency(row.taxableAmount)})</span></td>
          <td style="padding:2px 0;text-align:right;font-size:13px;">${sign < 0 ? '-' : ''}${fmtCurrency(row.taxAmount)}</td>
        </tr>`,
    )
    .join('');
  return `
        <tr><td colspan="2" style="padding:8px 0 2px;font-size:11px;text-transform:uppercase;color:#999;">${escapeHtml(title)}</td></tr>${lines}`;
}

/**
 * Brazil: taxes on top of the price (IPI) add to the total; taxes inside the
 * price (ISS, ICMS, PIS, COFINS) are shown for information; withholdings come
 * off what the customer pays; the 2026 CBS/IBS test amounts are informational.
 */
function buildBrTaxRows(taxBreakdown: TaxBreakdownItem[], labels: InvoiceLabels, fmtCurrency: CurrencyFmt): string {
  const of = (treatment: string) => taxBreakdown.filter((row) => (row.treatment ?? 'added') === treatment && row.taxAmount !== 0);
  return [
    brTaxGroup(labels.tax, of('added'), fmtCurrency),
    brTaxGroup(labels.withholdings ?? 'Retenções', of('withheld'), fmtCurrency, -1),
    brTaxGroup(labels.includedTaxes ?? 'Tributos incluídos no preço', of('embedded'), fmtCurrency),
    brTaxGroup(labels.informationalTaxes ?? 'CBS/IBS', of('informational'), fmtCurrency),
  ].join('');
}

/** Brazil: the Pix QR code (BR Code) for the amount due and its "copia e cola" text. */
function buildPixBlock(pix: InvoiceRenderData['pix'], labels: InvoiceLabels): string {
  if (!pix) return '';
  return `
  <div style="margin-top:24px;display:flex;gap:20px;align-items:center;padding:16px;border:1px solid #e5e7eb;border-radius:6px;">
    <div style="flex:none;">${pixQrSvg(pix.payload, 140)}</div>
    <div style="font-size:12px;color:#555;min-width:0;">
      <div style="font-weight:600;font-size:14px;margin-bottom:6px;">${escapeHtml(labels.pixPayment ?? 'Pix')}</div>
      <div>${escapeHtml(pix.key)}</div>
      <div style="margin-top:6px;font-family:monospace;font-size:10px;word-break:break-all;color:#777;">${escapeHtml(pix.payload)}</div>
    </div>
  </div>`;
}

/** Brazil: the authorised NF-e / NFS-e this invoice belongs to. */
function buildFiscalDocumentBlock(doc: InvoiceRenderData['fiscalDocument'], labels: InvoiceLabels): string {
  if (!doc) return '';
  const key = doc.accessKey ? `<div>${escapeHtml(labels.accessKey ?? 'Chave')}: <span style="font-family:monospace;">${escapeHtml(doc.accessKey.replace(/(\d{4})(?=\d)/g, '$1 '))}</span></div>` : '';
  return `
    <div>
      <div style="font-size:11px;text-transform:uppercase;color:#999;">${escapeHtml(labels.fiscalDocument ?? 'NF')}</div>
      <div style="font-weight:500;">${escapeHtml(doc.label)}${doc.number ? ` nº ${escapeHtml(doc.number)}` : ''}</div>
      <div style="font-size:11px;color:#777;">${key}</div>
    </div>`;
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

/** Banner plus a diagonal watermark, both printed, so a draft can't pass for the finalized document. */
function buildDraftMarking(labels: InvoiceLabels): string {
  const notice = escapeHtml(labels.draftNotice);
  return `<div data-draft-notice style="border:2px solid #c0392b;color:#c0392b;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;text-align:center;padding:10px;margin-bottom:24px;border-radius:6px;">${notice}</div>
  <div aria-hidden="true" style="position:absolute;top:40%;left:0;right:0;text-align:center;font-size:96px;font-weight:800;color:rgba(192,57,43,0.08);transform:rotate(-30deg);pointer-events:none;user-select:none;">${escapeHtml(labels.draftNotice.split(':')[0])}</div>`;
}

export function generateInvoiceHtml(invoice: InvoiceRenderData, entity: Entity): string {
  const locale = entity.locale || 'en-US';
  const currency = invoice.currency || entity.baseCurrency || 'EUR';
  const adapter = getAdapter(entity.jurisdictionCode);
  const requirements = adapter.getInvoiceRequirements(locale);
  const labels: InvoiceLabels = requirements.labels;

  const fmtCurrency = makeCurrencyFmt(locale, currency);
  const fmtNumber = makeNumberFmt(locale);
  const fmtDate = makeDateFmt(locale);

  const branding = entity.branding ?? {};
  const primaryColor = safeColor(branding.primaryColor, '#1a1a2e');
  const accentColor = safeColor(branding.accentColor, '#16213e');

  const typeLabel = invoice.type === 'credit_note' ? labels.creditNote : labels.invoice;

  const taxIds = entity.taxIdentifiers ?? {};
  const bankDetails = entity.bankDetails ?? {};

  const itemRows = buildItemRows(invoice.items, fmtCurrency, fmtNumber);
  // US sales tax prints per jurisdiction, and an exempt sale prints its reason and certificate.
  const taxBreakdown = invoice.taxBreakdown || [];
  const usSalesTax = adapter.features.salesTax && taxBreakdown.some((row) => row.jurisdictionName);
  const gstInvoice = entity.jurisdictionCode === 'IN';
  const brInvoice = entity.jurisdictionCode === 'BR';
  let buildRows = buildTaxRows;
  if (usSalesTax) buildRows = buildUsTaxRows;
  else if (gstInvoice) buildRows = buildGstTaxRows;
  else if (brInvoice) buildRows = (rows, l, currencyFmt) => buildBrTaxRows(rows, l, currencyFmt);
  const taxRows = buildRows(taxBreakdown, labels, fmtCurrency, fmtNumber);
  // Brazil prints its groups of taxes instead of one tax total (it can be negative: withholdings).
  const taxTotalRow = brInvoice
    ? ''
    : `<tr>
          <td style="padding:6px 0;color:#666;">${labels.taxTotal}</td>
          <td style="padding:6px 0;text-align:right;">${fmtCurrency(invoice.taxTotal)}</td>
        </tr>`;
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
<title>${invoice.draft ? `${escapeHtml(labels.draftNotice)} · ` : ''}${typeLabel} ${escapeHtml(invoice.invoiceNumber)}</title>
<style>
  @media print {
    body { margin: 0; }
    .no-print { display: none !important; }
  }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; color: #333; line-height: 1.5; margin: 0; padding: 0; }
  .container { max-width: 800px; margin: 0 auto; padding: 40px; position: relative; }
  table { border-collapse: collapse; width: 100%; }
</style>
</head>
<body>
<div class="container">
  ${invoice.draft ? buildDraftMarking(labels) : ''}
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
    ${gstInvoice ? buildGstPlaceOfSupplyBlock(invoice.placeOfSupply, labels) : ''}
    ${buildFiscalDocumentBlock(invoice.fiscalDocument, labels)}
  </div>

  ${
    gstInvoice
      ? buildGstItemsTable(invoice.items, taxBreakdown, labels, fmtCurrency, fmtNumber, primaryColor)
      : `<table style="margin-bottom:24px;">
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
  </table>`
  }

  <div style="display:flex;justify-content:flex-end;">
    <div style="width:300px;">
      <table>
        <tr>
          <td style="padding:6px 0;color:#666;">${labels.subtotal}</td>
          <td style="padding:6px 0;text-align:right;">${fmtCurrency(invoice.subtotal)}</td>
        </tr>
        ${buildDiscountRow(invoice.discountTotal, labels, fmtCurrency)}
        ${taxRows}
        ${taxTotalRow}
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
    ${buildPixBlock(invoice.pix, labels)}
  </div>

  ${buildNotesBlock(invoice.notes)}

  ${buildTermsBlock(branding.termsAndConditions)}

  ${buildRequiredFooterBlock(requirements.requiredFooter)}

  ${buildFooterTextBlock(branding.footerText)}
</div>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Designed invoices (invoice templates)
// ---------------------------------------------------------------------------

/** What every part of a designed invoice needs: formatters, labels and the jurisdiction's rules. */
interface TemplateRenderCtx {
  invoice: InvoiceRenderData;
  entity: Entity;
  requirements: ReturnType<ReturnType<typeof getAdapter>['getInvoiceRequirements']>;
  labels: InvoiceLabels;
  currency: string;
  money: CurrencyFmt;
  num: NumberFmt;
  date: (dateStr: string) => string;
  taxBreakdown: TaxBreakdownItem[];
  usSalesTax: boolean;
  gst: boolean;
  br: boolean;
  amountPaid: number;
  balanceDue: number;
}

function templateRenderCtx(invoice: InvoiceRenderData, entity: Entity): TemplateRenderCtx {
  const locale = entity.locale || 'en-US';
  const currency = invoice.currency || entity.baseCurrency || 'EUR';
  const adapter = getAdapter(entity.jurisdictionCode);
  const requirements = adapter.getInvoiceRequirements(locale);
  const taxBreakdown = invoice.taxBreakdown ?? [];
  return {
    invoice,
    entity,
    requirements,
    labels: requirements.labels,
    currency,
    money: makeCurrencyFmt(locale, currency),
    num: makeNumberFmt(locale),
    date: makeDateFmt(locale),
    taxBreakdown,
    usSalesTax: adapter.features.salesTax && taxBreakdown.some((row) => row.jurisdictionName),
    gst: entity.jurisdictionCode === 'IN',
    br: entity.jurisdictionCode === 'BR',
    amountPaid: Number.parseFloat(invoice.amountPaid || '0'),
    balanceDue: Number.parseFloat(invoice.balanceDue || invoice.total),
  };
}

const hasDiscount = (item: InvoiceLineItem) => Number.parseFloat(item.discountPercent ?? '0') > 0;

/** Line items. An Indian tax invoice names each line's HSN/SAC and its tax split. */
function templateTable(c: TemplateRenderCtx): InvoiceDocumentData['table'] {
  const { invoice, labels, money, num, gst } = c;
  const { supply, stateTax } = gstSupplyOf(c.taxBreakdown);
  const igst = gst && supply === 'inter';
  const columns: InvoiceDocumentData['table']['columns'] = {
    index: { label: '#', align: 'right' },
    description: { label: labels.description },
    quantity: { label: labels.quantity, align: 'right' },
    unitPrice: { label: labels.unitPrice, align: 'right' },
    taxRate: { label: igst ? 'IGST %' : `${labels.tax} %`, align: 'right', required: gst },
    taxAmount: { label: igst ? 'IGST' : labels.tax, align: 'right', required: gst },
    amount: { label: labels.amount, align: 'right' },
    amountWithTax: { label: labels.total, align: 'right' },
  };
  if (invoice.items.some((item) => item.unit)) columns.unit = { label: 'Unit' };
  if (invoice.items.some(hasDiscount)) columns.discount = { label: labels.discount, align: 'right' };
  if (gst) columns.hsnSac = { label: labels.hsnSac ?? 'HSN/SAC', required: true };

  const split = gst && supply === 'intra';
  const rows = invoice.items.map((item, i) => ({
    cells: {
      index: String(i + 1),
      description: item.description,
      hsnSac: item.hsnSac ?? '',
      quantity: num(item.quantity),
      unit: item.unit ?? '',
      unitPrice: money(item.unitPrice),
      discount: hasDiscount(item) ? `${num(item.discountPercent ?? '0')}%` : '',
      ...lineTaxCells(item, split ? GST_COMPONENT_LABEL[stateTax] : null, c),
      amount: money(item.lineTotal),
      amountWithTax: money(item.lineTotalWithTax ?? item.lineTotal),
    },
  }));
  return { columns, rows };
}

/** A line's tax rate and amount; split into CGST and the state tax (`stateLabel`) on an Indian intra-state invoice. */
function lineTaxCells(item: InvoiceLineItem, stateLabel: string | null, c: TemplateRenderCtx): { taxRate: string; taxAmount: string } {
  const rate = Number.parseFloat(item.taxRate ?? '0') || 0;
  const lineTax = Number.parseFloat(item.taxAmount ?? '0') || 0;
  if (!stateLabel) return { taxRate: rate ? `${c.num(rate)}%` : '-', taxAmount: c.money(lineTax) };
  // Same split as the GST table: CGST is half the slab rounded to the paisa, the state tax the rest.
  const cgst = roundCents(((Number.parseFloat(item.lineTotal) || 0) * (rate / 2)) / 100);
  const half = c.num(rate / 2);
  return {
    taxRate: `CGST ${half}%\n${stateLabel} ${half}%`,
    taxAmount: `${c.money(cgst)}\n${c.money(roundCents(lineTax - cgst))}`,
  };
}

const brRowsOf = (taxBreakdown: TaxBreakdownItem[], treatment: string) =>
  taxBreakdown.filter((row) => (row.treatment ?? 'added') === treatment && row.taxAmount !== 0);

/** The tax rows of the totals in the jurisdiction's form. */
function templateTaxRows(c: TemplateRenderCtx): TotalsRowData[] {
  const { labels, money, num, taxBreakdown } = c;
  if (c.usSalesTax) {
    return usTaxGroups(taxBreakdown).map((g) => ({ label: `${labels.tax} - ${g.name} ${num(g.rate)}%`, value: money(g.tax) }));
  }
  if (c.gst) {
    return gstTaxGroups(taxBreakdown).map((g) => {
      const name = g.component ? (GST_COMPONENT_LABEL[g.component] ?? labels.tax) : labels.tax;
      return { label: `${name} ${num(g.rate)}%`, value: money(g.tax) };
    });
  }
  if (c.br) {
    return [
      ...brRowsOf(taxBreakdown, 'added').map((row) => ({ label: row.taxRateName ?? labels.tax, value: money(row.taxAmount) })),
      ...brRowsOf(taxBreakdown, 'withheld').map((row) => ({ label: row.taxRateName ?? labels.tax, value: '-' + money(row.taxAmount) })),
    ];
  }
  return taxBreakdown.map((row) => ({ label: `${labels.tax} ${num(row.taxRate)}%`, value: money(row.taxAmount) }));
}

/** Brazil: taxes inside the price and the CBS/IBS test amounts, for information under the total. */
function brInformationRows(c: TemplateRenderCtx): TotalsRowData[] {
  const groups: Array<[string, TaxBreakdownItem[]]> = [
    [c.labels.includedTaxes ?? 'Tributos incluídos no preço', brRowsOf(c.taxBreakdown, 'embedded')],
    [c.labels.informationalTaxes ?? 'CBS/IBS', brRowsOf(c.taxBreakdown, 'informational')],
  ];
  return groups
    .filter(([, rows]) => rows.length > 0)
    .flatMap(([title, rows]) => [
      { label: title, value: '', kind: 'heading' as const },
      ...rows.map((row) => ({ label: row.taxRateName ?? '', value: c.money(row.taxAmount), kind: 'muted' as const })),
    ]);
}

function templateTotals(c: TemplateRenderCtx): TotalsRowData[] {
  const { invoice, labels, money } = c;
  const totals: TotalsRowData[] = [{ label: labels.subtotal, value: money(invoice.subtotal) }];
  if (Number.parseFloat(invoice.discountTotal) > 0) totals.push({ label: labels.discount, value: '-' + money(invoice.discountTotal) });
  const taxRows = templateTaxRows(c);
  totals.push(...taxRows);
  if (!c.br && taxRows.length !== 1) totals.push({ label: labels.taxTotal, value: money(invoice.taxTotal) });
  totals.push({ label: c.br ? (labels.netAmount ?? labels.total) : labels.total, value: money(invoice.total), kind: 'total' });
  if (!isNotPositive(c.amountPaid)) {
    totals.push({ label: labels.amountPaid, value: '-' + money(c.amountPaid), kind: 'muted' });
    totals.push({ label: labels.balanceDue, value: money(c.balanceDue), kind: 'balance' });
  }
  if (c.br) totals.push(...brInformationRows(c));
  return totals;
}

function templateLegal(c: TemplateRenderCtx): InvoiceDocumentData['legal'] {
  const { invoice, labels } = c;
  const doc = invoice.fiscalDocument;
  const docNumber = doc?.number ? ` nº ${doc.number}` : '';
  const accessKey = doc?.accessKey ? doc.accessKey.replace(/(\d{4})(?=\d)/g, '$1 ') : '';
  return {
    notices: [
      ...(invoice.complianceNotices ?? []),
      ...(c.usSalesTax ? usExemptNotices(c.taxBreakdown, invoice.certificateNumbers, c.money) : []),
    ],
    fiscalDocument: doc
      ? [`${labels.fiscalDocument ?? 'NF'}: ${doc.label}${docNumber}`, accessKey ? `${labels.accessKey ?? 'Chave'}: ${accessKey}` : ''].filter(Boolean)
      : null,
    pix: invoice.pix
      ? { title: labels.pixPayment ?? 'Pix', key: invoice.pix.key, payload: invoice.pix.payload, matrix: pixQrMatrix(invoice.pix.payload) }
      : null,
    requiredFooter: c.requirements.requiredFooter ?? null,
  };
}

function templateFields(c: TemplateRenderCtx): InvoiceDocumentData['fields'] {
  const { invoice, entity, money } = c;
  const taxIds = entity.taxIdentifiers ?? {};
  const bank = entity.bankDetails ?? {};
  return {
    title: invoice.type === 'credit_note' ? c.labels.creditNote : c.labels.invoice,
    invoiceNumber: invoice.invoiceNumber,
    issueDate: c.date(invoice.issueDate),
    dueDate: c.date(invoice.dueDate),
    reference: invoice.reference ?? '',
    placeOfSupply: c.gst ? gstPlaceOfSupplyText(invoice.placeOfSupply) : '',
    currency: c.currency,
    total: money(invoice.total),
    balanceDue: money(c.balanceDue),
    amountPaid: isNotPositive(c.amountPaid) ? '' : money(c.amountPaid),
    customerName: invoice.contactName,
    customerEmail: invoice.contactEmail ?? '',
    customerTaxId: invoice.contactVatNumber ?? '',
    sellerName: entity.name,
    sellerLegalName: entity.legalName ?? entity.name,
    sellerEmail: entity.contact?.email ?? '',
    sellerPhone: entity.contact?.phone ?? '',
    sellerWebsite: entity.contact?.website ?? '',
    sellerTaxId: taxIds.vatNumber ?? '',
    sellerRegistrationId: taxIds.registrationNumber ?? '',
    sellerIban: bank.iban ?? '',
    sellerBic: bank.bic ?? '',
    footerText: entity.branding?.footerText ?? '',
  };
}

/** Seller, buyer and ship-to blocks; countries print only when the invoice crosses a border (see generateInvoiceHtml). */
function templateParties(c: TemplateRenderCtx): Pick<InvoiceDocumentData, 'seller' | 'billTo' | 'shipTo'> {
  const { invoice, entity, labels } = c;
  const taxIds = entity.taxIdentifiers ?? {};
  const sellerCountry = (normalizePostalAddress(entity.address)?.country ?? entity.jurisdictionCode).toUpperCase();
  const buyerCountry = normalizePostalAddress(invoice.billingAddress)?.country;
  const crossBorder = !!buyerCountry && buyerCountry !== sellerCountry;
  const shipping = distinctShippingAddress(invoice);
  return {
    seller: {
      name: entity.legalName ?? entity.name,
      lines: formatPostalAddressLines(entity.address, { omitCountry: crossBorder ? undefined : sellerCountry }),
      contactLines: [entity.contact?.email, entity.contact?.phone, entity.contact?.website].filter((v): v is string => !!v),
      taxIdLines: [
        taxIds.registrationNumber ? `${labels.registrationLabel}: ${taxIds.registrationNumber}` : '',
        taxIds.vatNumber ? `${labels.vatNumberLabel}: ${taxIds.vatNumber}` : '',
      ].filter(Boolean),
    },
    billTo: {
      name: invoice.contactName,
      lines: formatPostalAddressLines(invoice.billingAddress, { omitCountry: sellerCountry }),
      contactLines: invoice.contactEmail ? [invoice.contactEmail] : [],
      taxIdLines: invoice.contactVatNumber ? [`${labels.vatNumberLabel}: ${invoice.contactVatNumber}`] : [],
    },
    shipTo: shipping ? { name: invoice.contactName, lines: formatPostalAddressLines(shipping, { omitCountry: sellerCountry }) } : null,
  };
}

function templateBankLines(bank: BankDetails): string[] {
  return [
    bank.iban ? `IBAN: ${bank.iban}` : '',
    bank.bic ? `BIC: ${bank.bic}` : '',
    bank.accountNumber && !bank.iban ? `Account: ${bank.accountNumber}` : '',
    bank.routingNumber ? `Routing: ${bank.routingNumber}` : '',
  ].filter(Boolean);
}

/**
 * What a designed invoice prints, built from the same inputs and with the same
 * jurisdiction rules as `generateInvoiceHtml`: US per-jurisdiction tax rows and
 * exempt notices, India's HSN/SAC and CGST/SGST split per line, Brazil's tax
 * groups and Pix, compliance notices and the required footer.
 */
export function invoiceTemplateData(invoice: InvoiceRenderData, entity: Entity): InvoiceDocumentData {
  const c = templateRenderCtx(invoice, entity);
  const { labels } = c;
  const branding = entity.branding ?? {};
  const typeLabel = invoice.type === 'credit_note' ? labels.creditNote : labels.invoice;
  return {
    fields: templateFields(c),
    fieldLabels: {
      title: typeLabel,
      invoiceNumber: labels.invoiceNumber,
      issueDate: labels.date,
      dueDate: labels.dueDate,
      reference: 'Reference',
      placeOfSupply: labels.placeOfSupply ?? 'Place of supply',
      total: labels.total,
      balanceDue: labels.balanceDue,
      amountPaid: labels.amountPaid,
      customerTaxId: labels.vatNumberLabel,
      sellerTaxId: labels.vatNumberLabel,
      sellerRegistrationId: labels.registrationLabel,
    },
    labels: {
      from: labels.from,
      billTo: labels.billTo,
      shipTo: labels.shipTo,
      payment: labels.paymentInstructions,
      notes: 'Notes',
      terms: 'Terms',
      page: '{page} / {total}',
    },
    logoUrl: safeImageUrl(branding.logoUrl),
    ...templateParties(c),
    table: templateTable(c),
    totals: templateTotals(c),
    payment: { bankLines: templateBankLines(entity.bankDetails ?? {}), instructions: branding.paymentInstructions ?? null },
    notes: invoice.notes ?? null,
    terms: branding.termsAndConditions ?? null,
    legal: templateLegal(c),
    draft: invoice.draft ? { banner: labels.draftNotice, watermark: labels.draftNotice.split(':')[0] } : null,
  };
}

/** The printable HTML of an invoice laid out with a designed template. */
export function generateTemplatedInvoiceHtml(template: InvoiceTemplateDocument, invoice: InvoiceRenderData, entity: Entity): string {
  const labels = getAdapter(entity.jurisdictionCode).getInvoiceRequirements(entity.locale || 'en-US').labels;
  const layout = layoutInvoice(template, invoiceTemplateData(invoice, entity));
  const typeLabel = invoice.type === 'credit_note' ? labels.creditNote : labels.invoice;
  const draftPrefix = invoice.draft ? `${labels.draftNotice} · ` : '';
  return renderInvoiceHtmlDocument(layout, { title: `${draftPrefix}${typeLabel} ${invoice.invoiceNumber}`, lang: entity.locale || 'en-US' });
}
