/**
 * Report PDF renderer: turns the print document of
 * `GET /api/accounting-reports/*?format=print` into a PDF with pdf-lib.
 *
 * Paper follows the document (US Letter for US entities, A4 elsewhere); a
 * report with many value columns (a month per column) prints in landscape.
 * The table is laid out by the server (`kind`, `depth`, `label`, `code`,
 * `values` per column), so every report prints the same way. Labels of the
 * page furniture come from the caller, translated; the row labels are the
 * server's.
 */
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage, type RGB } from 'pdf-lib';
import { formatPostalAddressLines } from '@/components/address/postal-address';
import { normalizeAccountingAddress } from './address';
import type { PrintTable, PrintTableColumn, PrintTableRow, ReportPrintDocument } from './report-types';

/** Translated labels. `page` uses `{page}` and `{total}`, `amountsIn` uses `{currency}`, `generated` uses `{date}`. */
export interface ReportPdfLabels {
  /** "Cash basis" / "Accrual basis" */
  basis: { cash: string; accrual: string };
  amountsIn: string;
  generated: string;
  page: string;
  /** Label of the entity's tax ID: "EIN", "VAT number". */
  taxId: string;
  dba: string;
  /** Heading of the first column. */
  account: string;
}

export interface ReportPdfOptions {
  labels: ReportPdfLabels;
  /** Locale of the amounts; defaults to the document entity's. */
  locale?: string;
  /** `YYYY-MM-DD` to display; defaults to the locale's medium date. */
  formatDate?: (value: string) => string;
  /** Replaces the server's period line (which is English). */
  periodLabel?: string;
  /** Replaces the heading of a value column, by column key (the server's are English or raw dates). */
  columnLabels?: Record<string, string>;
  /** Country name for an ISO-2 code; defaults to the code. */
  countryName?: (code: string) => string;
}

interface PageSize {
  width: number;
  height: number;
}

const A4: PageSize = { width: 595.28, height: 841.89 };
const LETTER: PageSize = { width: 612, height: 792 };

const MARGIN_X = 40;
const MARGIN_TOP = 44;
const MARGIN_BOTTOM = 48;
const ROW_HEIGHT = 15;
const HEADER_HEIGHT = 20;
/** More value columns than this and the page turns landscape. */
const PORTRAIT_COLUMN_LIMIT = 4;

const TEXT = rgb(0.1, 0.1, 0.12);
const MUTED = rgb(0.45, 0.47, 0.52);
const RULE = rgb(0.8, 0.82, 0.86);
const SECTION_FILL = rgb(0.95, 0.96, 0.98);

/** Narrow / thin spaces some locales put in amounts; the standard PDF fonts can't draw them. */
const NARROW_SPACES = new RegExp('[' + String.fromCharCode(0x202f, 0x2009, 0x00a0) + ']', 'g');

const PLAIN_NUMBER = /^-?\d+(\.\d+)?$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function reportPaperSize(doc: Pick<ReportPrintDocument, 'paper'>): PageSize {
  return doc.paper === 'letter' ? LETTER : A4;
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

/** Shorten `value` with an ellipsis until it fits `maxWidth`. */
function fit(font: PDFFont, value: string, size: number, maxWidth: number): string {
  const safe = encodable(font, value);
  if (font.widthOfTextAtSize(safe, size) <= maxWidth) return safe;
  let text = safe;
  while (text.length > 1 && font.widthOfTextAtSize(`${text}...`, size) > maxWidth) text = text.slice(0, -1);
  return `${text.trimEnd()}...`;
}

function fill(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => (values[key] !== undefined ? String(values[key]) : match));
}

/** An amount as the reports print it: grouped, two decimals, no currency symbol (the header names the currency). */
export function formatReportAmount(value: string | number | null | undefined, locale?: string): string {
  if (value === null || value === undefined || value === '') return '';
  if (typeof value === 'string' && !PLAIN_NUMBER.test(value)) return value;
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value);
  let formatted: string;
  try {
    formatted = new Intl.NumberFormat(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);
  } catch {
    formatted = n.toFixed(2);
  }
  return formatted.replace(NARROW_SPACES, ' ');
}

function defaultDate(locale: string | undefined) {
  return (value: string) => {
    const [y, m, d] = value.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString(locale, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      timeZone: 'UTC',
    });
  };
}

interface Layout {
  size: PageSize;
  labelWidth: number;
  numericWidth: number;
  valueColumns: PrintTableColumn[];
  textColumns: PrintTableColumn[];
  fontSize: number;
}

function layoutFor(doc: ReportPrintDocument): Layout {
  const base = reportPaperSize(doc);
  const numeric = doc.table.columns.filter((c) => c.numeric);
  const text = doc.table.columns.filter((c) => !c.numeric);
  const landscape = numeric.length > PORTRAIT_COLUMN_LIMIT;
  const size = landscape ? { width: base.height, height: base.width } : base;
  const contentWidth = size.width - 2 * MARGIN_X;
  const textWidth = text.length * 70;
  const numericWidth = Math.max(54, Math.min(92, Math.floor((contentWidth - textWidth - 160) / Math.max(numeric.length, 1))));
  const labelWidth = contentWidth - textWidth - numericWidth * numeric.length;
  return {
    size,
    labelWidth,
    numericWidth,
    valueColumns: numeric,
    textColumns: text,
    fontSize: numeric.length > 8 ? 7 : 8.5,
  };
}

interface Cursor {
  page: PDFPage;
  y: number;
}

/** Entity block on the first page: name, DBA, address, tax ID. Returns the y below it. */
function drawEntityHeader(
  page: PDFPage,
  fonts: { regular: PDFFont; bold: PDFFont },
  doc: ReportPrintDocument,
  options: ReportPdfOptions,
  size: PageSize,
  startY: number,
): number {
  const { entity } = doc;
  let y = startY;
  const draw = (text: string, opts: { size: number; bold?: boolean; color?: RGB }) => {
    const font = opts.bold ? fonts.bold : fonts.regular;
    page.drawText(fit(font, text, opts.size, size.width - 2 * MARGIN_X), {
      x: MARGIN_X,
      y,
      size: opts.size,
      font,
      color: opts.color ?? TEXT,
    });
    y -= opts.size + 4;
  };

  draw(entity.name, { size: 14, bold: true });
  if (entity.dba) draw(`${options.labels.dba}: ${entity.dba}`, { size: 9, color: MUTED });
  if (entity.legalName && entity.legalName !== entity.name) draw(entity.legalName, { size: 9, color: MUTED });
  const address = normalizeAccountingAddress(entity.address);
  const lines = formatPostalAddressLines(address, { countryName: options.countryName, omitCountry: entity.jurisdictionCode });
  for (const line of lines) draw(line, { size: 9, color: MUTED });
  if (entity.taxId) draw(`${options.labels.taxId}: ${entity.taxId}`, { size: 9, color: MUTED });
  return y;
}

function drawTableHeader(
  cursor: Cursor,
  fonts: { regular: PDFFont; bold: PDFFont },
  doc: ReportPrintDocument,
  layout: Layout,
  options: ReportPdfOptions,
) {
  const { page } = cursor;
  const { size, fontSize } = layout;
  const top = cursor.y;
  page.drawRectangle({ x: MARGIN_X, y: top - HEADER_HEIGHT + 4, width: size.width - 2 * MARGIN_X, height: HEADER_HEIGHT, color: SECTION_FILL });
  const baseline = top - HEADER_HEIGHT + 10;
  let x = MARGIN_X + 4;
  page.drawText(fit(fonts.bold, options.labels.account, fontSize, layout.labelWidth - 8), {
    x,
    y: baseline,
    size: fontSize,
    font: fonts.bold,
    color: MUTED,
  });
  x = MARGIN_X + layout.labelWidth;
  for (const column of layout.textColumns) {
    page.drawText(fit(fonts.bold, options.columnLabels?.[column.key] ?? column.label, fontSize, 62), {
      x,
      y: baseline,
      size: fontSize,
      font: fonts.bold,
      color: MUTED,
    });
    x += 70;
  }
  for (const column of layout.valueColumns) {
    const label = fit(fonts.bold, options.columnLabels?.[column.key] ?? column.label, fontSize, layout.numericWidth - 6);
    const width = fonts.bold.widthOfTextAtSize(label, fontSize);
    page.drawText(label, { x: x + layout.numericWidth - 4 - width, y: baseline, size: fontSize, font: fonts.bold, color: MUTED });
    x += layout.numericWidth;
  }
  cursor.y = top - HEADER_HEIGHT;
}

function cellText(
  column: PrintTableColumn,
  row: PrintTableRow,
  locale: string | undefined,
  formatDate: (value: string) => string,
): string {
  const raw = row.values[column.key];
  if (raw === null || raw === undefined) return '';
  if (column.numeric) return formatReportAmount(raw, locale);
  const text = String(raw);
  return ISO_DATE.test(text) ? formatDate(text) : text;
}

function drawRow(
  cursor: Cursor,
  fonts: { regular: PDFFont; bold: PDFFont },
  row: PrintTableRow,
  table: PrintTable,
  layout: Layout,
  locale: string | undefined,
  formatDate: (value: string) => string,
) {
  const { page } = cursor;
  const { size, fontSize } = layout;
  const strong = row.kind === 'section' || row.kind === 'subtotal' || row.kind === 'total';
  const font = strong ? fonts.bold : fonts.regular;
  const rowWidth = size.width - 2 * MARGIN_X;
  const top = cursor.y;
  const baseline = top - ROW_HEIGHT + 5;

  if (row.kind === 'section') {
    page.drawRectangle({ x: MARGIN_X, y: top - ROW_HEIGHT + 2, width: rowWidth, height: ROW_HEIGHT, color: SECTION_FILL });
  }
  if (row.kind === 'subtotal' || row.kind === 'total') {
    page.drawLine({
      start: { x: MARGIN_X + layout.labelWidth, y: top },
      end: { x: MARGIN_X + rowWidth, y: top },
      thickness: row.kind === 'total' ? 0.9 : 0.5,
      color: row.kind === 'total' ? TEXT : RULE,
    });
  }

  const indent = row.depth * 10;
  const labelText = table.hasCode && row.code ? `${row.code}  ${row.label}` : row.label;
  page.drawText(fit(font, labelText, fontSize, layout.labelWidth - 8 - indent), {
    x: MARGIN_X + 4 + indent,
    y: baseline,
    size: fontSize,
    font,
    color: row.kind === 'note' ? MUTED : TEXT,
  });

  let x = MARGIN_X + layout.labelWidth;
  for (const column of layout.textColumns) {
    page.drawText(fit(font, cellText(column, row, locale, formatDate), fontSize, 64), {
      x,
      y: baseline,
      size: fontSize,
      font,
      color: TEXT,
    });
    x += 70;
  }
  for (const column of layout.valueColumns) {
    const text = fit(font, cellText(column, row, locale, formatDate), fontSize, layout.numericWidth - 6);
    const width = font.widthOfTextAtSize(text, fontSize);
    page.drawText(text, { x: x + layout.numericWidth - 4 - width, y: baseline, size: fontSize, font, color: TEXT });
    x += layout.numericWidth;
  }
  cursor.y = top - ROW_HEIGHT;
}

/** Render a report print document to PDF bytes. */
export async function buildReportPdf(doc: ReportPrintDocument, options: ReportPdfOptions): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const fonts = {
    regular: await pdf.embedFont(StandardFonts.Helvetica),
    bold: await pdf.embedFont(StandardFonts.HelveticaBold),
  };
  const layout = layoutFor(doc);
  const locale = options.locale ?? doc.entity.locale ?? undefined;
  const formatDate = options.formatDate ?? defaultDate(locale);
  const generated = (() => {
    const at = new Date(doc.generatedAt);
    return Number.isNaN(at.getTime()) ? doc.generatedAt : formatDate(at.toISOString().slice(0, 10));
  })();

  const newPage = (): Cursor => {
    const page = pdf.addPage([layout.size.width, layout.size.height]);
    return { page, y: layout.size.height - MARGIN_TOP };
  };

  let cursor = newPage();

  // First page: entity, title, period, basis, currency.
  cursor.y = drawEntityHeader(cursor.page, fonts, doc, options, layout.size, cursor.y);
  cursor.y -= 10;
  cursor.page.drawText(fit(fonts.bold, doc.title, 16, layout.size.width - 2 * MARGIN_X), {
    x: MARGIN_X,
    y: cursor.y,
    size: 16,
    font: fonts.bold,
    color: TEXT,
  });
  cursor.y -= 18;
  const meta = [
    options.periodLabel ?? doc.periodLabel,
    doc.basis ? options.labels.basis[doc.basis] : null,
    fill(options.labels.amountsIn, { currency: doc.currency }),
  ].filter((part): part is string => Boolean(part));
  cursor.page.drawText(fit(fonts.regular, meta.join('  |  '), 9, layout.size.width - 2 * MARGIN_X), {
    x: MARGIN_X,
    y: cursor.y,
    size: 9,
    font: fonts.regular,
    color: MUTED,
  });
  cursor.y -= 20;

  drawTableHeader(cursor, fonts, doc, layout, options);
  for (const row of doc.table.rows) {
    if (cursor.y - ROW_HEIGHT < MARGIN_BOTTOM) {
      cursor = newPage();
      drawTableHeader(cursor, fonts, doc, layout, options);
    }
    drawRow(cursor, fonts, row, doc.table, layout, locale, formatDate);
  }

  if (doc.table.notes.length > 0) {
    cursor.y -= 10;
    for (const note of doc.table.notes) {
      if (cursor.y - ROW_HEIGHT < MARGIN_BOTTOM) cursor = newPage();
      cursor.page.drawText(fit(fonts.regular, note, 8, layout.size.width - 2 * MARGIN_X), {
        x: MARGIN_X,
        y: cursor.y,
        size: 8,
        font: fonts.regular,
        color: MUTED,
      });
      cursor.y -= 12;
    }
  }

  // Footer on every page: generation date and page numbers.
  const pages = pdf.getPages();
  pages.forEach((page, index) => {
    const left = fill(options.labels.generated, { date: generated });
    page.drawText(fit(fonts.regular, left, 8, layout.size.width / 2), {
      x: MARGIN_X,
      y: MARGIN_BOTTOM - 24,
      size: 8,
      font: fonts.regular,
      color: MUTED,
    });
    const right = fill(options.labels.page, { page: index + 1, total: pages.length });
    const width = fonts.regular.widthOfTextAtSize(encodable(fonts.regular, right), 8);
    page.drawText(encodable(fonts.regular, right), {
      x: layout.size.width - MARGIN_X - width,
      y: MARGIN_BOTTOM - 24,
      size: 8,
      font: fonts.regular,
      color: MUTED,
    });
  });

  return pdf.save();
}
