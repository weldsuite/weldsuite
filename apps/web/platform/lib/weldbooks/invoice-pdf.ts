/**
 * Invoice PDF renderer. Fixed layout, Stripe-style. Consumes `entities.branding`
 * for logo/colors/footer and the invoice detail payload for the content.
 *
 * No user-facing designer — the layout is code and changes ship as code.
 * Runs in-browser (Vite SPA) today; the pure-function signature means it can
 * move to a Worker unchanged if/when we need server-side generation.
 */
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage, type RGB } from 'pdf-lib';
import type { InvoiceDetail } from '@/lib/api/domains/weldbooks';

export interface InvoicePdfEntity {
  name: string;
  legalName?: string | null;
  taxIdentifiers?: { vatNumber?: string; registrationNumber?: string } | null;
  address?: {
    street?: string;
    houseNumber?: string;
    postalCode?: string;
    city?: string;
    country?: string;
  } | null;
  contact?: { email?: string; phone?: string; website?: string } | null;
  bankDetails?: { iban?: string; bic?: string; bankName?: string } | null;
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

// A4 in points (1 mm ≈ 2.8346 pt).
const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;
const MARGIN_X = 48;
const MARGIN_TOP = 56;
const MARGIN_BOTTOM = 64;

// Fixed column layout for the line-items table — relative to margins. Total
// width fills PAGE_WIDTH - 2*MARGIN_X (~499pt).
const COL = {
  description: { x: 0, width: 250 },
  qty: { x: 260, width: 40, align: 'right' as const },
  unitPrice: { x: 310, width: 80, align: 'right' as const },
  tax: { x: 395, width: 40, align: 'right' as const },
  total: { x: 445, width: 54, align: 'right' as const },
};
const ROW_HEIGHT = 18;
const TABLE_HEADER_HEIGHT = 22;

function hexToRgb(hex: string | null | undefined, fallback: RGB = rgb(0.1, 0.1, 0.12)): RGB {
  if (!hex) return fallback;
  const cleaned = hex.replace('#', '').trim();
  if (cleaned.length !== 6) return fallback;
  const r = parseInt(cleaned.slice(0, 2), 16) / 255;
  const g = parseInt(cleaned.slice(2, 4), 16) / 255;
  const b = parseInt(cleaned.slice(4, 6), 16) / 255;
  if ([r, g, b].some(Number.isNaN)) return fallback;
  return rgb(r, g, b);
}

function formatCurrency(value: string | null | undefined, currency: string, locale: string): string {
  const n = Number(value ?? 0);
  try {
    return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(n);
  } catch {
    return n.toFixed(2) + ' ' + currency;
  }
}

function formatDate(value: string | null | undefined, locale: string): string {
  if (!value) return '-';
  try {
    return new Date(value).toLocaleDateString(locale, {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
  } catch {
    return value;
  }
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
  font: PDFFont;
  fontBold: PDFFont;
  accent: RGB;
  muted: RGB;
  text: RGB;
}

function drawText(
  ctx: DrawContext,
  value: string,
  x: number,
  y: number,
  opts: { size?: number; bold?: boolean; color?: RGB; align?: 'left' | 'right'; width?: number } = {},
) {
  const size = opts.size ?? 9;
  const font = opts.bold ? ctx.fontBold : ctx.font;
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
  const words = text.split(/\s+/);
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

export async function generateInvoicePdf(
  invoice: InvoiceDetail,
  entity: InvoicePdfEntity,
  customer?: { name?: string | null; email?: string | null; address?: InvoicePdfEntity['address'] } | null,
): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdf.embedFont(StandardFonts.HelveticaBold);

  const accent = hexToRgb(entity.branding?.accentColor ?? entity.branding?.primaryColor, rgb(0.23, 0.38, 0.87));
  const muted = rgb(0.45, 0.47, 0.52);
  const text = rgb(0.1, 0.1, 0.12);
  const currency = invoice.currency ?? entity.baseCurrency ?? 'EUR';
  const locale = entity.locale ?? 'en-US';
  const logo = await fetchLogo(entity.branding?.logoUrl, pdf);

  let page = pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  const ctx: DrawContext = { page, font, fontBold, accent, muted, text };

  // --- Header ---
  let y = PAGE_HEIGHT - MARGIN_TOP;

  if (logo) {
    const maxLogoH = 48;
    const scale = Math.min(maxLogoH / logo.height, 160 / logo.width);
    const logoW = logo.width * scale;
    const logoH = logo.height * scale;
    page.drawImage(logo, { x: MARGIN_X, y: y - logoH, width: logoW, height: logoH });
  } else {
    drawText(ctx, entity.name, MARGIN_X, y - 14, { size: 16, bold: true });
  }

  // "INVOICE" + number on the right
  drawText(ctx, 'INVOICE', MARGIN_X, y - 12, {
    size: 22,
    bold: true,
    color: accent,
    align: 'right',
    width: PAGE_WIDTH - 2 * MARGIN_X,
  });
  if (invoice.invoiceNumber) {
    drawText(ctx, invoice.invoiceNumber, MARGIN_X, y - 34, {
      size: 10,
      color: muted,
      align: 'right',
      width: PAGE_WIDTH - 2 * MARGIN_X,
    });
  }

  y -= 72;

  // --- Company + meta row ---
  const fromLines = [
    entity.legalName || entity.name,
    [entity.address?.street, entity.address?.houseNumber].filter(Boolean).join(' '),
    [entity.address?.postalCode, entity.address?.city].filter(Boolean).join(' '),
    entity.address?.country,
    entity.contact?.email,
    entity.taxIdentifiers?.vatNumber ? 'VAT: ' + entity.taxIdentifiers.vatNumber : '',
  ].filter(Boolean) as string[];

  drawText(ctx, 'FROM', MARGIN_X, y, { size: 8, bold: true, color: muted });
  let fromY = y - 14;
  for (const line of fromLines) {
    drawText(ctx, line, MARGIN_X, fromY, { size: 9 });
    fromY -= 12;
  }

  // Right column: dates
  const metaX = PAGE_WIDTH - MARGIN_X - 180;
  const metaW = 180;
  drawText(ctx, 'ISSUE DATE', metaX, y, { size: 8, bold: true, color: muted });
  drawText(ctx, formatDate(invoice.issueDate, locale), metaX, y, {
    size: 9,
    align: 'right',
    width: metaW,
  });
  drawText(ctx, 'DUE DATE', metaX, y - 16, { size: 8, bold: true, color: muted });
  drawText(ctx, formatDate(invoice.dueDate, locale), metaX, y - 16, {
    size: 9,
    align: 'right',
    width: metaW,
  });
  if (invoice.reference) {
    drawText(ctx, 'REFERENCE', metaX, y - 32, { size: 8, bold: true, color: muted });
    drawText(ctx, invoice.reference, metaX, y - 32, {
      size: 9,
      align: 'right',
      width: metaW,
    });
  }

  y = Math.min(fromY, y - 48) - 12;

  // --- Bill To ---
  drawText(ctx, 'BILL TO', MARGIN_X, y, { size: 8, bold: true, color: muted });
  y -= 14;
  const billLines = [
    customer?.name ?? invoice.contactName ?? '',
    customer?.email ?? invoice.contactEmail ?? '',
    [customer?.address?.street, customer?.address?.houseNumber].filter(Boolean).join(' '),
    [customer?.address?.postalCode, customer?.address?.city].filter(Boolean).join(' '),
    customer?.address?.country,
  ].filter(Boolean) as string[];
  for (const line of billLines) {
    drawText(ctx, line, MARGIN_X, y, { size: 9 });
    y -= 12;
  }

  y -= 16;

  // --- Line items header ---
  const tableX = MARGIN_X;
  const tableWidth = PAGE_WIDTH - 2 * MARGIN_X;
  // Accent bar under header row
  page.drawRectangle({
    x: tableX,
    y: y - 4,
    width: tableWidth,
    height: 1,
    color: accent,
  });
  drawText(ctx, 'DESCRIPTION', tableX + COL.description.x, y, { size: 8, bold: true, color: muted });
  drawText(ctx, 'QTY', tableX + COL.qty.x, y, {
    size: 8,
    bold: true,
    color: muted,
    align: 'right',
    width: COL.qty.width,
  });
  drawText(ctx, 'UNIT PRICE', tableX + COL.unitPrice.x, y, {
    size: 8,
    bold: true,
    color: muted,
    align: 'right',
    width: COL.unitPrice.width,
  });
  drawText(ctx, 'TAX', tableX + COL.tax.x, y, {
    size: 8,
    bold: true,
    color: muted,
    align: 'right',
    width: COL.tax.width,
  });
  drawText(ctx, 'AMOUNT', tableX + COL.total.x, y, {
    size: 8,
    bold: true,
    color: muted,
    align: 'right',
    width: COL.total.width,
  });

  y -= TABLE_HEADER_HEIGHT;

  // --- Line items rows ---
  const totalsReservedHeight = 120; // approx space for totals + footer
  for (const item of invoice.items ?? []) {
    const descLines = wrapText(item.description, font, 9, COL.description.width);
    const rowLines = Math.max(1, descLines.length);
    const rowH = rowLines * ROW_HEIGHT;

    // Page break if we'd overlap totals band.
    if (y - rowH < MARGIN_BOTTOM + totalsReservedHeight) {
      page = pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
      ctx.page = page;
      y = PAGE_HEIGHT - MARGIN_TOP;
      // Re-draw compact header on continuation pages
      drawText(ctx, (invoice.invoiceNumber ?? 'Invoice') + ' (continued)', MARGIN_X, y, {
        size: 10,
        bold: true,
      });
      y -= 20;
    }

    let lineY = y;
    for (const line of descLines) {
      drawText(ctx, line, tableX + COL.description.x, lineY, { size: 9 });
      lineY -= ROW_HEIGHT;
    }
    drawText(ctx, item.quantity ?? '1', tableX + COL.qty.x, y, {
      size: 9,
      align: 'right',
      width: COL.qty.width,
    });
    drawText(ctx, formatCurrency(item.unitPrice, currency, locale), tableX + COL.unitPrice.x, y, {
      size: 9,
      align: 'right',
      width: COL.unitPrice.width,
    });
    drawText(ctx, item.taxRate ? Number(item.taxRate) + '%' : '-', tableX + COL.tax.x, y, {
      size: 9,
      align: 'right',
      width: COL.tax.width,
    });
    drawText(ctx, formatCurrency(item.lineTotal, currency, locale), tableX + COL.total.x, y, {
      size: 9,
      align: 'right',
      width: COL.total.width,
    });

    y -= rowH;
    // Row separator
    page.drawRectangle({
      x: tableX,
      y: y + 4,
      width: tableWidth,
      height: 0.5,
      color: rgb(0.85, 0.86, 0.88),
    });
  }

  // --- Totals (right-aligned) ---
  y -= 20;
  const totalsX = PAGE_WIDTH - MARGIN_X - 200;
  const totalsW = 200;

  const totalsRow = (label: string, value: string, bold = false, color?: RGB) => {
    drawText(ctx, label, totalsX, y, { size: 9, bold, color: color ?? muted });
    drawText(ctx, value, totalsX, y, { size: 9, bold, color, align: 'right', width: totalsW });
    y -= 16;
  };

  totalsRow('Subtotal', formatCurrency(invoice.subtotal, currency, locale));
  totalsRow('Tax', formatCurrency(invoice.taxTotal, currency, locale));
  y -= 4;
  // Accent line above grand total
  page.drawRectangle({ x: totalsX, y: y + 4, width: totalsW, height: 1, color: accent });
  y -= 4;
  totalsRow('Total', formatCurrency(invoice.total, currency, locale), true, text);
  if (invoice.amountPaid && Number(invoice.amountPaid) > 0) {
    totalsRow('Paid', '-' + formatCurrency(invoice.amountPaid, currency, locale));
    totalsRow('Balance Due', formatCurrency(invoice.balanceDue, currency, locale), true, accent);
  }

  // --- Footer (payment instructions + terms + footer text) ---
  const footerBlocks = [
    entity.branding?.paymentInstructions,
    entity.bankDetails?.iban ? 'Bank: ' + (entity.bankDetails.bankName ?? '') + ' · IBAN: ' + entity.bankDetails.iban + (entity.bankDetails.bic ? ' · BIC: ' + entity.bankDetails.bic : '') : null,
    entity.branding?.termsAndConditions,
    entity.branding?.footerText,
  ].filter((b): b is string => !!b && b.trim().length > 0);

  let footerY = MARGIN_BOTTOM + footerBlocks.length * 24;
  for (const block of footerBlocks) {
    const lines = wrapText(block, font, 8, PAGE_WIDTH - 2 * MARGIN_X);
    for (const line of lines) {
      drawText(ctx, line, MARGIN_X, footerY, { size: 8, color: muted });
      footerY -= 11;
    }
    footerY -= 6;
  }

  // --- Page numbers (on every page, bottom-right) ---
  const pages = pdf.getPages();
  const totalPages = pages.length;
  for (let i = 0; i < totalPages; i++) {
    const p = pages[i];
    const label = 'Page ' + (i + 1) + ' of ' + totalPages;
    const w = font.widthOfTextAtSize(label, 8);
    p.drawText(label, {
      x: PAGE_WIDTH - MARGIN_X - w,
      y: MARGIN_BOTTOM - 20,
      size: 8,
      font,
      color: muted,
    });
  }

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
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
