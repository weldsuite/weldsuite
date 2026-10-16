/**
 * Invoice PDF renderer. Fixed layout, Stripe-style. Consumes `entities.branding`
 * for logo/colors/footer and the invoice detail payload for the content.
 *
 * No user-facing designer — the layout is code and changes ship as code.
 * Runs in-browser (Vite SPA) today; the pure-function signature means it can
 * move to a Worker unchanged if/when we need server-side generation.
 *
 * Paper is US Letter for US (and Canadian) entities and A4 everywhere else.
 * Every label comes from the caller (translated, with the jurisdiction's
 * terminology), so nothing here is hard-coded English.
 */
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFImage, type PDFPage, type RGB } from 'pdf-lib';
import type { InvoiceWithTax } from '@/lib/api/domains/weldbooks-sales-tax-preview';
import { formatPostalAddressLines, type PostalAddress } from '@/components/address/postal-address';
import { normalizeAccountingAddress, type StoredAccountingAddress } from './address';
import { formatWeldbooksNumber } from './format-money';
import { exemptNoticeText, exemptReasonsOf, groupTaxBreakdown, hasExemptRows, type ExemptNoticeLabels } from './document-tax';
import { placeOfSupplyName } from './gst';
import { groupBrTaxRows } from './br-fiscal';
import { pixQrMatrix } from './pix';

export interface InvoicePdfEntity {
  name: string;
  legalName?: string | null;
  jurisdictionCode?: string | null;
  taxIdentifiers?: { vatNumber?: string; registrationNumber?: string; einOrSsn?: string } | null;
  address?: StoredAccountingAddress | null;
  contact?: { email?: string; phone?: string; website?: string } | null;
  bankDetails?: {
    iban?: string;
    bic?: string;
    bankName?: string;
    accountNumber?: string;
    routingNumber?: string;
  } | null;
  branding?: {
    logoUrl?: string;
    primaryColor?: string;
    accentColor?: string;
    footerText?: string;
    paymentInstructions?: string;
    termsAndConditions?: string;
  } | null;
  baseCurrency?: string | null;
  locale?: string | null;
}

/** Translated labels. `continued` and `page` use `{number}` / `{page}` + `{total}` placeholders. */
export interface InvoicePdfLabels {
  invoice: string;
  from: string;
  billTo: string;
  shipTo: string;
  issueDate: string;
  dueDate: string;
  reference: string;
  description: string;
  quantity: string;
  unitPrice: string;
  /** Column header and totals label for tax: "VAT", "GST", "Sales tax". */
  tax: string;
  amount: string;
  subtotal: string;
  total: string;
  paid: string;
  balanceDue: string;
  continued: string;
  page: string;
  bank: string;
  iban: string;
  bic: string;
  accountNumber: string;
  routingNumber: string;
  /** Label of the entity's tax ID: "VAT number", "GSTIN", "EIN". */
  taxId: string;
  /** Label of the entity's registration number: "KvK number", "PAN", … */
  registrationId: string;
  /** Title of a credit note / credit memo ("CREDIT MEMO"); the invoice title when absent. */
  creditNote?: string;
  /**
   * US sales tax rows of the totals, one per jurisdiction: "{tax} – {jurisdiction} {rate}%".
   * `{tax}` is the tax label, `{rate}` the percentage without its percent sign.
   */
  jurisdictionTax?: string;
  /** The notice printed under the totals of a sale a certificate exempts from tax. */
  exempt?: ExemptNoticeLabels;
  /** India GST tax invoice: "Place of supply", "HSN/SAC" (printed under a line) and "Outside India" (place of supply 96). */
  placeOfSupply?: string;
  hsnSac?: string;
  outsideIndia?: string;
  /** Brazil: NCM / CFOP under a line, the grouped taxes of the totals, the Pix block and the fiscal document. */
  br?: {
    ncm: string;
    cfop: string;
    includedTaxes: string;
    withholdings: string;
    informationalTaxes: string;
    netAmount: string;
    pixPayment: string;
    fiscalDocument: string;
    accessKey: string;
    /** `{number}` is replaced by the document number. */
    fiscalDocumentNumber: string;
  };
}

/** Brazil: what an invoice prints besides its lines and totals. */
export interface BrInvoicePdfExtras {
  /** The Pix key and BR Code for the amount due (see `brPixFor`). */
  pix?: { key: string; payload: string } | null;
  /** The authorised NF-e / NFS-e of the invoice. */
  fiscalDocument?: { label: string; number?: string | null; accessKey?: string | null } | null;
  /** Statements the regime requires (see `brComplianceNotices`). */
  notices?: string[];
}

export interface InvoicePdfOptions {
  labels: InvoicePdfLabels;
  /** Formats `YYYY-MM-DD` / ISO values; defaults to the entity locale's long date. */
  formatDate?: (value: string | null | undefined) => string;
  /** Country name for an ISO-2 code; defaults to the code. */
  countryName?: (code: string) => string;
  /** Overrides the paper size picked from the entity's jurisdiction. */
  paperSize?: 'a4' | 'letter';
  /** Numbers of the exemption certificates the invoice's exempt rows rest on, for the exempt notice. */
  certificateNumbers?: string[];
  /** Brazil: Pix QR, fiscal document and compliance notices; its presence makes the invoice a Brazilian one. */
  br?: BrInvoicePdfExtras;
}

type InvoiceCustomer = {
  name?: string | null;
  email?: string | null;
  address?: StoredAccountingAddress | null;
} | null;

interface PageSize {
  width: number;
  height: number;
}

const A4: PageSize = { width: 595.28, height: 841.89 };
const LETTER: PageSize = { width: 612, height: 792 };

const MARGIN_X = 48;
const MARGIN_TOP = 56;
const MARGIN_BOTTOM = 64;
const ROW_HEIGHT = 18;
const TABLE_HEADER_HEIGHT = 22;

/** Paper size for an entity: Letter in the US and Canada, A4 elsewhere. */
export function invoicePaperSize(entity: Pick<InvoicePdfEntity, 'jurisdictionCode' | 'address'>): 'a4' | 'letter' {
  const code = entity.jurisdictionCode?.toUpperCase();
  if (code === 'US' || code === 'CA') return 'letter';
  if (code) return 'a4';
  const country = normalizeAccountingAddress(entity.address)?.country;
  return country === 'US' || country === 'CA' ? 'letter' : 'a4';
}

/** Line-item columns, right-aligned against the table's right edge. */
function columns(tableWidth: number) {
  return {
    description: { x: 0, width: tableWidth - 249 },
    qty: { x: tableWidth - 239, width: 40 },
    unitPrice: { x: tableWidth - 189, width: 80 },
    tax: { x: tableWidth - 104, width: 40 },
    total: { x: tableWidth - 54, width: 54 },
  };
}

function hexToRgb(hex: string | null | undefined, fallback: RGB = rgb(0.1, 0.1, 0.12)): RGB {
  if (!hex) return fallback;
  const cleaned = hex.replace('#', '').trim();
  if (cleaned.length !== 6) return fallback;
  const r = Number.parseInt(cleaned.slice(0, 2), 16) / 255;
  const g = Number.parseInt(cleaned.slice(2, 4), 16) / 255;
  const b = Number.parseInt(cleaned.slice(4, 6), 16) / 255;
  if ([r, g, b].some(Number.isNaN)) return fallback;
  return rgb(r, g, b);
}

/** Narrow / thin spaces some locales put in amounts; the PDF fonts can't draw them. */
const NARROW_SPACES = new RegExp('[' + String.fromCharCode(0x202f, 0x2009) + ']', 'g');

/** Characters the standard (WinAnsi) PDF fonts can draw. */
const WIN_ANSI = /^[\x20-\x7E\xA0-\xFF€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ]*$/;

export function formatCurrency(value: string | number | null | undefined, currency: string | null, locale: string | undefined): string {
  const n = Number(value ?? 0);
  const amount = Number.isFinite(n) ? n : 0;
  if (!currency) {
    return new Intl.NumberFormat(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(amount);
  }
  try {
    const withSymbol = new Intl.NumberFormat(locale, { style: 'currency', currency })
      .format(amount)
      .replace(NARROW_SPACES, ' ');
    if (WIN_ANSI.test(withSymbol)) return withSymbol;
    // ₹ and other symbols the PDF font can't draw: use the ISO code instead.
    return new Intl.NumberFormat(locale, { style: 'currency', currency, currencyDisplay: 'code' })
      .format(amount)
      .replace(NARROW_SPACES, ' ');
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}

export function defaultFormatDate(locale: string | undefined) {
  return (value: string | null | undefined) => {
    if (!value) return '-';
    const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
    const date = match
      ? new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])))
      : new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return date.toLocaleDateString(locale, { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
  };
}

async function fetchLogo(url: string | undefined, pdf: PDFDocument) {
  if (!url) return null;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const bytes = new Uint8Array(await res.arrayBuffer());
    const contentType = res.headers.get('content-type') ?? '';
    if (contentType.includes('png') || url.toLowerCase().endsWith('.png')) {
      return await pdf.embedPng(bytes);
    }
    return await pdf.embedJpg(bytes);
  } catch {
    return null;
  }
}

interface DrawContext {
  page: PDFPage;
  size: PageSize;
  font: PDFFont;
  fontBold: PDFFont;
  accent: RGB;
  muted: RGB;
  text: RGB;
}

/** Drop characters the font can't encode instead of failing the whole PDF. */
function encodable(font: PDFFont, value: string): string {
  try {
    font.widthOfTextAtSize(value, 9);
    return value;
  } catch {
    return Array.from(value)
      .map((ch) => {
        try {
          font.widthOfTextAtSize(ch, 9);
          return ch;
        } catch {
          return '?';
        }
      })
      .join('');
  }
}

function drawText(
  ctx: DrawContext,
  raw: string,
  x: number,
  y: number,
  opts: { size?: number; bold?: boolean; color?: RGB; align?: 'left' | 'right'; width?: number } = {},
) {
  const font = opts.bold ? ctx.fontBold : ctx.font;
  const value = encodable(font, raw);
  let size = opts.size ?? 9;
  // Shrink a header that doesn't fit its column (e.g. "SALES TAX").
  if (opts.width !== undefined) {
    while (size > 6 && font.widthOfTextAtSize(value, size) > opts.width) size -= 0.5;
  }
  const color = opts.color ?? ctx.text;
  let drawX = x;
  if (opts.align === 'right' && opts.width !== undefined) {
    const w = font.widthOfTextAtSize(value, size);
    drawX = x + opts.width - w;
  }
  ctx.page.drawText(value, { x: drawX, y, size, font, color });
}

/**
 * Wrap a long string onto multiple lines based on max width. Very naive — splits
 * on spaces only. Good enough for line-item descriptions; not a full shaper.
 */
function wrapText(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  if (!text) return [''];
  const safe = encodable(font, text);
  const words = safe.split(/\s+/);
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    const candidate = current ? current + ' ' + word : word;
    if (font.widthOfTextAtSize(candidate, size) > maxWidth && current) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  return lines.length > 0 ? lines : [''];
}

function fill(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) =>
    values[key] !== undefined ? String(values[key]) : match,
  );
}

/**
 * `einOrSsn` printed only when it is written as an EIN (NN-NNNNNNN). Nine
 * bare digits could be an SSN, which must never appear on an invoice.
 */
export function printableEin(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? '';
  return /^\d{2}-\d{7}$/.test(trimmed) ? trimmed : null;
}

/** Logo (or entity name) on the left, "INVOICE" + number on the right. */
function drawHeader(
  ctx: DrawContext,
  invoice: InvoiceWithTax,
  entity: InvoicePdfEntity,
  logo: PDFImage | null,
  labels: InvoicePdfLabels,
  y: number,
) {
  const contentWidth = ctx.size.width - 2 * MARGIN_X;
  if (logo) {
    const maxLogoH = 48;
    const scale = Math.min(maxLogoH / logo.height, 160 / logo.width);
    const logoW = logo.width * scale;
    const logoH = logo.height * scale;
    ctx.page.drawImage(logo, { x: MARGIN_X, y: y - logoH, width: logoW, height: logoH });
  } else {
    drawText(ctx, entity.name, MARGIN_X, y - 14, { size: 16, bold: true });
  }

  drawText(ctx, invoice.type === 'credit_note' && labels.creditNote ? labels.creditNote : labels.invoice, MARGIN_X, y - 12, {
    size: 22,
    bold: true,
    color: ctx.accent,
    align: 'right',
    width: contentWidth,
  });
  if (invoice.invoiceNumber) {
    drawText(ctx, invoice.invoiceNumber, MARGIN_X, y - 34, {
      size: 10,
      color: ctx.muted,
      align: 'right',
      width: contentWidth,
    });
  }
}

interface RenderHelpers {
  /** A Brazilian invoice: NCM / CFOP are printed under each line. */
  br?: boolean;
  /** An India GST tax invoice: the buyer's GSTIN and the place of supply are printed. */
  gst?: boolean;
  labels: InvoicePdfLabels;
  formatDate: (value: string | null | undefined) => string;
  countryName?: (code: string) => string;
}

function addressLines(address: PostalAddress | null, helpers: RenderHelpers): string[] {
  return formatPostalAddressLines(address, { countryName: helpers.countryName });
}

/** Company address block (left) + issue/due/reference dates (right). Returns the next y. */
function drawFromAndMeta(
  ctx: DrawContext,
  invoice: InvoiceWithTax,
  entity: InvoicePdfEntity,
  helpers: RenderHelpers,
  y: number,
): number {
  const { labels } = helpers;
  const muted = ctx.muted;
  const ids = entity.taxIdentifiers;
  const taxId = ids?.vatNumber || printableEin(ids?.einOrSsn);
  const fromLines = [
    entity.legalName || entity.name,
    ...addressLines(normalizeAccountingAddress(entity.address), helpers),
    entity.contact?.email,
    entity.contact?.phone,
    taxId ? `${labels.taxId}: ${taxId}` : '',
    ids?.registrationNumber ? `${labels.registrationId}: ${ids.registrationNumber}` : '',
  ].filter(Boolean) as string[];

  drawText(ctx, labels.from, MARGIN_X, y, { size: 8, bold: true, color: muted });
  let fromY = y - 14;
  for (const line of fromLines) {
    drawText(ctx, line, MARGIN_X, fromY, { size: 9 });
    fromY -= 12;
  }

  // Right column: dates
  const metaW = 200;
  const metaX = ctx.size.width - MARGIN_X - metaW;
  drawText(ctx, labels.issueDate, metaX, y, { size: 8, bold: true, color: muted });
  drawText(ctx, helpers.formatDate(invoice.issueDate), metaX, y, { size: 9, align: 'right', width: metaW });
  drawText(ctx, labels.dueDate, metaX, y - 16, { size: 8, bold: true, color: muted });
  drawText(ctx, helpers.formatDate(invoice.dueDate), metaX, y - 16, { size: 9, align: 'right', width: metaW });
  let metaY = y - 32;
  if (invoice.reference) {
    drawText(ctx, labels.reference, metaX, metaY, { size: 8, bold: true, color: muted });
    drawText(ctx, invoice.reference, metaX, metaY, { size: 9, align: 'right', width: metaW });
    metaY -= 16;
  }
  if (helpers.gst && invoice.placeOfSupply) {
    drawText(ctx, labels.placeOfSupply ?? 'Place of supply', metaX, metaY, { size: 8, bold: true, color: muted });
    drawText(ctx, placeOfSupplyName(invoice.placeOfSupply, labels.outsideIndia ?? 'Outside India'), metaX, metaY, {
      size: 9,
      align: 'right',
      width: metaW,
    });
    metaY -= 16;
  }

  return Math.min(fromY, metaY, y - 48) - 12;
}

/** "BILL TO" (and "SHIP TO" when the invoice ships elsewhere) blocks. Returns the next y. */
function drawBillTo(
  ctx: DrawContext,
  invoice: InvoiceWithTax,
  customer: InvoiceCustomer | undefined,
  helpers: RenderHelpers,
  startY: number,
): number {
  const { labels } = helpers;
  const billing = normalizeAccountingAddress(invoice.billingAddress) ?? normalizeAccountingAddress(customer?.address);
  const shipping = normalizeAccountingAddress(invoice.shippingAddress);
  const name = customer?.name ?? invoice.contactName ?? '';
  const email = customer?.email ?? invoice.contactEmail ?? '';

  const drawBlock = (title: string, lines: string[], x: number) => {
    let y = startY;
    drawText(ctx, title, x, y, { size: 8, bold: true, color: ctx.muted });
    y -= 14;
    for (const line of lines) {
      drawText(ctx, line, x, y, { size: 9 });
      y -= 12;
    }
    return y;
  };

  // An Indian tax invoice names the buyer's GSTIN (as it was when the invoice was finalized).
  const buyerTaxId = helpers.gst && invoice.contactTaxNumber ? `${labels.taxId}: ${invoice.contactTaxNumber}` : '';
  const billY = drawBlock(
    labels.billTo,
    [name, email, ...addressLines(billing, helpers), buyerTaxId].filter(Boolean),
    MARGIN_X,
  );
  if (!shipping) return billY;
  const shipX = MARGIN_X + (ctx.size.width - 2 * MARGIN_X) / 2;
  const shipY = drawBlock(labels.shipTo, [name, ...addressLines(shipping, helpers)].filter(Boolean), shipX);
  return Math.min(billY, shipY);
}

/** Accent bar + column headings of the line-items table. */
function drawTableHeader(ctx: DrawContext, labels: InvoicePdfLabels, tableX: number, tableWidth: number, y: number) {
  const col = columns(tableWidth);
  const headerOpts = { size: 8, bold: true, color: ctx.muted };
  ctx.page.drawRectangle({
    x: tableX,
    y: y - 4,
    width: tableWidth,
    height: 1,
    color: ctx.accent,
  });
  drawText(ctx, labels.description.toUpperCase(), tableX + col.description.x, y, headerOpts);
  const rightAligned: Array<[string, { x: number; width: number }]> = [
    [labels.quantity, col.qty],
    [labels.unitPrice, col.unitPrice],
    [labels.tax.toUpperCase(), col.tax],
    [labels.amount, col.total],
  ];
  for (const [label, c] of rightAligned) {
    drawText(ctx, label.toUpperCase(), tableX + c.x, y, { ...headerOpts, align: 'right', width: c.width });
  }
}

type InvoicePdfItem = NonNullable<InvoiceWithTax['items']>[number];

/** The code lines printed under an item's description (null when not printed). */
function itemCodeLines(
  item: InvoicePdfItem,
  labels: InvoicePdfLabels,
  gst: boolean | undefined,
  br: boolean | undefined,
): { hsnLine: string | null; brLine: string | null } {
  // India GST: the HSN/SAC code goes on a line of its own under the description.
  const hsnLine = gst && item.hsnSac ? `${labels.hsnSac ?? 'HSN/SAC'}: ${item.hsnSac}` : null;
  const brLine = br ? brLineCodes(item, labels) : null;
  return { hsnLine, brLine };
}

/** A new page for the rest of the line items, headed "continued"; returns the y below the heading. */
function startContinuationPage(pdf: PDFDocument, ctx: DrawContext, invoice: InvoiceWithTax, labels: InvoicePdfLabels): number {
  ctx.page = pdf.addPage([ctx.size.width, ctx.size.height]);
  const y = ctx.size.height - MARGIN_TOP;
  drawText(ctx, fill(labels.continued, { number: invoice.invoiceNumber ?? labels.invoice }), MARGIN_X, y, {
    size: 10,
    bold: true,
  });
  return y - 20;
}

/** The wrapped description of a row, with its HSN/SAC and NCM / CFOP lines under it. */
function drawItemDescription(
  ctx: DrawContext,
  { descLines, hsnLine, brLine }: { descLines: string[]; hsnLine: string | null; brLine: string | null },
  x: number,
  y: number,
) {
  let lineY = y;
  for (const line of descLines) {
    drawText(ctx, line, x, lineY, { size: 9 });
    lineY -= ROW_HEIGHT;
  }
  if (hsnLine) drawText(ctx, hsnLine, x, lineY, { size: 8, color: ctx.muted });
  if (brLine) drawText(ctx, brLine, x, lineY - (hsnLine ? ROW_HEIGHT : 0), { size: 8, color: ctx.muted });
}

/** Quantity, unit price, tax rate and line total of a row, right-aligned. */
function drawItemAmounts(
  ctx: DrawContext,
  item: InvoicePdfItem,
  {
    col,
    tableX,
    y,
    currency,
    locale,
  }: { col: ReturnType<typeof columns>; tableX: number; y: number; currency: string | null; locale: string | undefined },
) {
  drawText(ctx, formatWeldbooksNumber(item.quantity ?? '1', locale), tableX + col.qty.x, y, { size: 9, align: 'right', width: col.qty.width });
  drawText(ctx, formatCurrency(item.unitPrice, currency, locale), tableX + col.unitPrice.x, y, {
    size: 9,
    align: 'right',
    width: col.unitPrice.width,
  });
  drawText(ctx, item.taxRate ? formatWeldbooksNumber(item.taxRate, locale) + '%' : '-', tableX + col.tax.x, y, {
    size: 9,
    align: 'right',
    width: col.tax.width,
  });
  drawText(ctx, formatCurrency(item.lineTotal, currency, locale), tableX + col.total.x, y, {
    size: 9,
    align: 'right',
    width: col.total.width,
  });
}

/** Line-item rows with page breaks. Mutates `ctx.page` on a break; returns the next y. */
function drawLineItems(
  pdf: PDFDocument,
  ctx: DrawContext,
  invoice: InvoiceWithTax,
  {
    labels,
    currency,
    locale,
    tableX,
    tableWidth,
    startY,
    gst,
    br,
    reservedHeight = 120,
  }: {
    /** An India GST tax invoice: a line's HSN/SAC code is printed under it. */
    gst?: boolean;
    /** A Brazilian invoice: a line's NCM and CFOP are printed under it. */
    br?: boolean;
    /** Space kept free under the table for the totals. */
    reservedHeight?: number;
    labels: InvoicePdfLabels;
    currency: string | null;
    locale: string | undefined;
    tableX: number;
    tableWidth: number;
    startY: number;
  },
): number {
  const col = columns(tableWidth);
  let y = startY;
  const totalsReservedHeight = reservedHeight; // approx space for totals + footer
  for (const item of invoice.items ?? []) {
    const descLines = wrapText(item.description, ctx.font, 9, col.description.width);
    const { hsnLine, brLine } = itemCodeLines(item, labels, gst, br);
    const rowLines = Math.max(1, descLines.length + (hsnLine ? 1 : 0) + (brLine ? 1 : 0));
    const rowH = rowLines * ROW_HEIGHT;

    // Page break if we'd overlap totals band.
    if (y - rowH < MARGIN_BOTTOM + totalsReservedHeight) {
      y = startContinuationPage(pdf, ctx, invoice, labels);
    }

    drawItemDescription(ctx, { descLines, hsnLine, brLine }, tableX + col.description.x, y);
    drawItemAmounts(ctx, item, { col, tableX, y, currency, locale });

    y -= rowH;
    ctx.page.drawRectangle({
      x: tableX,
      y: y + 4,
      width: tableWidth,
      height: 0.5,
      color: rgb(0.85, 0.86, 0.88),
    });
  }
  return y;
}

/** "NCM: 84713012 · CFOP: 5102" under a Brazilian line; null when it has neither. */
export function brLineCodes(
  item: { ncm?: string | null; cfop?: string | null },
  labels: Pick<InvoicePdfLabels, 'br'>,
): string | null {
  const parts = [
    item.ncm ? `${labels.br?.ncm ?? 'NCM'}: ${item.ncm}` : '',
    item.cfop ? `${labels.br?.cfop ?? 'CFOP'}: ${item.cfop}` : '',
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(' · ') : null;
}

/**
 * The totals rows of a Brazilian invoice: taxes added on top, then the
 * withholdings (negative), which are what the customer pays less. Taxes
 * already inside the price and the CBS / IBS test amounts are listed apart.
 */
export function brTotalsOf(invoice: InvoiceWithTax) {
  const groups = groupBrTaxRows(invoice.taxBreakdown);
  const rows = (treatment: string) => groups.find((g) => g.treatment === treatment)?.rows ?? [];
  return {
    added: rows('added').map((row) => ({ label: row.taxRateName, amount: row.taxAmount })),
    withheld: rows('withheld').map((row) => ({ label: row.taxRateName, amount: -row.taxAmount })),
    embedded: rows('embedded').map((row) => ({ label: row.taxRateName, amount: row.taxAmount })),
    informational: rows('informational').map((row) => ({ label: row.taxRateName, amount: row.taxAmount })),
  };
}

/**
 * The tax rows of the totals. A US invoice prints one row per jurisdiction
 * ("Sales tax – Travis County 0.5%"), as the states that allow inclusive
 * pricing want the tax amount shown; a VAT / GST invoice keeps one row per
 * rate. A US invoice with no tax in any jurisdiction still prints the tax
 * line, so the amount is always there.
 */
export function taxRowsOf(
  invoice: InvoiceWithTax,
  labels: Pick<InvoicePdfLabels, 'tax' | 'jurisdictionTax'>,
): Array<{ label: string; amount: string | number }> {
  const groups = groupTaxBreakdown(invoice.taxBreakdown).filter((group) => group.kind === 'tax');

  if (groups.some((group) => group.isJurisdiction)) {
    const template = labels.jurisdictionTax ?? '{tax} – {jurisdiction} {rate}%';
    const rows = groups
      .filter((group) => group.taxAmount !== 0 || group.rate > 0)
      .map((group) => ({
        label: fill(template, { tax: labels.tax, jurisdiction: group.name, rate: String(Number(group.rate.toFixed(4))) }),
        amount: group.taxAmount,
      }));
    return rows.length > 0 ? rows : [{ label: labels.tax, amount: invoice.taxTotal ?? 0 }];
  }

  if (invoice.taxBreakdown && invoice.taxBreakdown.length > 0) {
    return invoice.taxBreakdown.map((row) => ({ label: row.taxRateName || labels.tax, amount: row.taxAmount }));
  }
  return [{ label: labels.tax, amount: invoice.taxTotal ?? 0 }];
}

/** Right-aligned subtotal / tax / total (+ paid / balance) block. Returns the y below it. */
function drawTotals(
  ctx: DrawContext,
  invoice: InvoiceWithTax,
  labels: InvoicePdfLabels,
  currency: string | null,
  locale: string | undefined,
  startY: number,
  br = false,
): number {
  let y = startY - 20;
  const totalsW = 200;
  const totalsX = ctx.size.width - MARGIN_X - totalsW;

  const totalsRow = (label: string, value: string, bold = false, color?: RGB) => {
    drawText(ctx, label, totalsX, y, { size: 9, bold, color: color ?? ctx.muted });
    drawText(ctx, value, totalsX, y, { size: 9, bold, color, align: 'right', width: totalsW });
    y -= 16;
  };

  totalsRow(labels.subtotal, formatCurrency(invoice.subtotal, currency, locale));
  const brTotals = br ? brTotalsOf(invoice) : null;
  const taxRows = brTotals ? [...brTotals.added, ...brTotals.withheld] : taxRowsOf(invoice, labels);
  for (const row of taxRows) {
    totalsRow(row.label, formatCurrency(row.amount, currency, locale));
  }
  y -= 4;
  ctx.page.drawRectangle({ x: totalsX, y: y + 4, width: totalsW, height: 1, color: ctx.accent });
  y -= 4;
  totalsRow(brTotals ? (labels.br?.netAmount ?? labels.total) : labels.total, formatCurrency(invoice.total, currency, locale), true, ctx.text);
  if (invoice.amountPaid && Number(invoice.amountPaid) > 0) {
    totalsRow(labels.paid, '-' + formatCurrency(invoice.amountPaid, currency, locale));
    totalsRow(labels.balanceDue, formatCurrency(invoice.balanceDue, currency, locale), true, ctx.accent);
  }
  if (brTotals) {
    y = drawBrInfoTotals(ctx, labels, brTotals, { currency, locale, x: totalsX, width: totalsW, y });
  }
  return y;
}

/** Taxes inside the price and the CBS / IBS test amounts of a Brazilian invoice, under the total. Returns the y below them. */
function drawBrInfoTotals(
  ctx: DrawContext,
  labels: InvoicePdfLabels,
  brTotals: ReturnType<typeof brTotalsOf>,
  { currency, locale, x, width, y: startY }: { currency: string | null; locale: string | undefined; x: number; width: number; y: number },
): number {
  let y = startY;
  // Taxes inside the price and the CBS / IBS test amounts: for information, under the total.
  const info: Array<[string, Array<{ label: string; amount: number }>]> = [
    [labels.br?.includedTaxes ?? '', brTotals.embedded],
    [labels.br?.informationalTaxes ?? '', brTotals.informational],
  ];
  for (const [title, rows] of info) {
    if (rows.length === 0) continue;
    y -= 6;
    drawText(ctx, title, x, y, { size: 7, bold: true, color: ctx.muted, width });
    y -= 12;
    for (const row of rows) {
      drawText(ctx, row.label, x, y, { size: 8, color: ctx.muted });
      drawText(ctx, formatCurrency(row.amount, currency, locale), x, y, { size: 8, color: ctx.muted, align: 'right', width });
      y -= 12;
    }
  }
  return y;
}

/** A new page when less than `needed` points are left above the footer; returns the y to continue at. */
function ensureSpace(pdf: PDFDocument, ctx: DrawContext, y: number, needed: number): number {
  if (y - needed >= MARGIN_BOTTOM + 90) return y;
  ctx.page = pdf.addPage([ctx.size.width, ctx.size.height]);
  return ctx.size.height - MARGIN_TOP;
}

/** Splits an unbroken string (a Pix BR Code) every `n` characters. */
function chunk(value: string, n: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < value.length; i += n) out.push(value.slice(i, i + n));
  return out;
}

/**
 * Brazil: the authorised fiscal document, the Pix QR code (drawn from its
 * modules) with its "copia e cola" text, and the compliance notices. Returns the y below them.
 */
function drawBrExtras(
  pdf: PDFDocument,
  ctx: DrawContext,
  labels: InvoicePdfLabels,
  extras: BrInvoicePdfExtras,
  startY: number,
): number {
  let y = startY - 12;
  const contentWidth = ctx.size.width - 2 * MARGIN_X;

  if (extras.fiscalDocument) {
    const doc = extras.fiscalDocument;
    y = ensureSpace(pdf, ctx, y, 40);
    drawText(ctx, (labels.br?.fiscalDocument ?? '').toUpperCase(), MARGIN_X, y, { size: 8, bold: true, color: ctx.muted });
    y -= 13;
    const number = doc.number ? (labels.br?.fiscalDocumentNumber ?? '{number}').replace('{number}', doc.number) : '';
    drawText(ctx, [doc.label, number].filter(Boolean).join(' '), MARGIN_X, y, { size: 9, bold: true });
    y -= 12;
    if (doc.accessKey) {
      drawText(ctx, `${labels.br?.accessKey ?? ''}: ${doc.accessKey.replace(/(\d{4})(?=\d)/g, '$1 ')}`, MARGIN_X, y, { size: 8, color: ctx.muted });
      y -= 12;
    }
    y -= 6;
  }

  if (extras.pix) {
    const qrSize = 92;
    y = ensureSpace(pdf, ctx, y, qrSize + 16);
    const matrix = pixQrMatrix(extras.pix.payload);
    const cell = qrSize / matrix.length;
    const top = y;
    ctx.page.drawRectangle({ x: MARGIN_X, y: top - qrSize, width: qrSize, height: qrSize, color: rgb(1, 1, 1) });
    matrix.forEach((row, r) => {
      row.forEach((dark, c) => {
        if (!dark) return;
        ctx.page.drawRectangle({
          x: MARGIN_X + c * cell,
          y: top - (r + 1) * cell,
          width: cell + 0.15,
          height: cell + 0.15,
          color: rgb(0, 0, 0),
        });
      });
    });
    const textX = MARGIN_X + qrSize + 14;
    let textY = top - 12;
    drawText(ctx, labels.br?.pixPayment ?? 'Pix', textX, textY, { size: 11, bold: true });
    textY -= 14;
    drawText(ctx, extras.pix.key, textX, textY, { size: 9 });
    textY -= 14;
    for (const line of chunk(extras.pix.payload, 62)) {
      drawText(ctx, line, textX, textY, { size: 6.5, color: ctx.muted });
      textY -= 8;
    }
    y = top - qrSize - 14;
  }

  for (const notice of extras.notices ?? []) {
    for (const line of wrapText(notice, ctx.font, 8, contentWidth)) {
      y = ensureSpace(pdf, ctx, y, 12);
      drawText(ctx, line, MARGIN_X, y, { size: 8, bold: true });
      y -= 11;
    }
  }
  return y;
}

/**
 * "Exempt sale: resale. Certificate no. A-123." under the totals of a sale a
 * customer's certificate exempts from sales tax. Returns the y below it.
 */
function drawExemptNotice(
  ctx: DrawContext,
  invoice: InvoiceWithTax,
  labels: InvoicePdfLabels,
  certificateNumbers: string[],
  startY: number,
): number {
  if (!labels.exempt || !hasExemptRows(invoice.taxBreakdown)) return startY;
  const text = exemptNoticeText(labels.exempt, exemptReasonsOf(invoice.taxBreakdown), certificateNumbers);
  let y = startY - 8;
  for (const line of wrapText(text, ctx.font, 9, ctx.size.width - 2 * MARGIN_X)) {
    drawText(ctx, line, MARGIN_X, y, { size: 9, bold: true });
    y -= 12;
  }
  return y;
}

function bankLine(entity: InvoicePdfEntity, labels: InvoicePdfLabels): string | null {
  const bank = entity.bankDetails;
  if (!bank) return null;
  const parts: string[] = [];
  if (bank.bankName) parts.push(`${labels.bank}: ${bank.bankName}`);
  if (bank.iban) {
    parts.push(`${labels.iban}: ${bank.iban}`);
    if (bank.bic) parts.push(`${labels.bic}: ${bank.bic}`);
  } else {
    if (bank.routingNumber) parts.push(`${labels.routingNumber}: ${bank.routingNumber}`);
    if (bank.accountNumber) parts.push(`${labels.accountNumber}: ${bank.accountNumber}`);
  }
  const hasAccount = !!bank.iban || !!bank.accountNumber;
  return hasAccount ? parts.join(' · ') : null;
}

/** Footer (payment instructions + bank details + terms + footer text). */
function drawFooter(ctx: DrawContext, entity: InvoicePdfEntity, labels: InvoicePdfLabels) {
  const footerBlocks = [
    entity.branding?.paymentInstructions,
    bankLine(entity, labels),
    entity.branding?.termsAndConditions,
    entity.branding?.footerText,
  ].filter((b): b is string => !!b && b.trim().length > 0);

  let footerY = MARGIN_BOTTOM + footerBlocks.length * 24;
  for (const block of footerBlocks) {
    const lines = wrapText(block, ctx.font, 8, ctx.size.width - 2 * MARGIN_X);
    for (const line of lines) {
      drawText(ctx, line, MARGIN_X, footerY, { size: 8, color: ctx.muted });
      footerY -= 11;
    }
    footerY -= 6;
  }
}

/** Page numbers on every page, bottom-right. */
function drawPageNumbers(pdf: PDFDocument, ctx: DrawContext, labels: InvoicePdfLabels) {
  const pages = pdf.getPages();
  const totalPages = pages.length;
  for (let i = 0; i < totalPages; i++) {
    const label = encodable(ctx.font, fill(labels.page, { page: i + 1, total: totalPages }));
    const w = ctx.font.widthOfTextAtSize(label, 8);
    pages[i].drawText(label, {
      x: ctx.size.width - MARGIN_X - w,
      y: MARGIN_BOTTOM - 20,
      size: 8,
      font: ctx.font,
      color: ctx.muted,
    });
  }
}

export async function generateInvoicePdf(
  invoice: InvoiceWithTax,
  entity: InvoicePdfEntity,
  options: InvoicePdfOptions,
  customer?: InvoiceCustomer,
): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdf.embedFont(StandardFonts.HelveticaBold);

  const accent = hexToRgb(entity.branding?.accentColor ?? entity.branding?.primaryColor, rgb(0.23, 0.38, 0.87));
  const muted = rgb(0.45, 0.47, 0.52);
  const text = rgb(0.1, 0.1, 0.12);
  const currency = invoice.currency || entity.baseCurrency || null;
  const locale = entity.locale || undefined;
  const size = (options.paperSize ?? invoicePaperSize(entity)) === 'letter' ? LETTER : A4;
  const helpers: RenderHelpers = {
    gst: entity.jurisdictionCode?.toUpperCase() === 'IN',
    br: entity.jurisdictionCode?.toUpperCase() === 'BR' || Boolean(options.br),
    labels: options.labels,
    formatDate: options.formatDate ?? defaultFormatDate(locale),
    countryName: options.countryName,
  };
  const logo = await fetchLogo(entity.branding?.logoUrl, pdf);

  const page = pdf.addPage([size.width, size.height]);
  const ctx: DrawContext = { page, size, font, fontBold, accent, muted, text };

  let y = size.height - MARGIN_TOP;
  drawHeader(ctx, invoice, entity, logo, options.labels, y);
  y -= 72;

  y = drawFromAndMeta(ctx, invoice, entity, helpers, y);

  y = drawBillTo(ctx, invoice, customer, helpers, y);
  y -= 16;

  const tableX = MARGIN_X;
  const tableWidth = size.width - 2 * MARGIN_X;
  drawTableHeader(ctx, options.labels, tableX, tableWidth, y);
  y -= TABLE_HEADER_HEIGHT;

  // A Brazilian invoice lists withholdings and the taxes inside the price under its total: keep more room.
  const brRows = helpers.br ? Object.values(brTotalsOf(invoice)).reduce((n, rows) => n + rows.length, 0) : 0;
  y = drawLineItems(pdf, ctx, invoice, {
    labels: options.labels,
    currency,
    locale,
    tableX,
    tableWidth,
    startY: y,
    gst: helpers.gst,
    br: helpers.br,
    reservedHeight: 120 + brRows * 14 + (helpers.br ? 28 : 0),
  });

  y = drawTotals(ctx, invoice, options.labels, currency, locale, y, helpers.br);
  y = drawExemptNotice(ctx, invoice, options.labels, options.certificateNumbers ?? [], y);
  if (options.br) drawBrExtras(pdf, ctx, options.labels, options.br, y);

  drawFooter(ctx, entity, options.labels);

  drawPageNumbers(pdf, ctx, options.labels);

  return await pdf.save();
}

export function downloadPdf(bytes: Uint8Array, filename: string) {
  const blob = new Blob([bytes as BlobPart], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
