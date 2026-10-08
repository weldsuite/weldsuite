/**
 * Check PDF renderer: turns the print data of `GET /api/payment-runs/:id/checks`
 * into a PDF on US Letter with pdf-lib, and draws the alignment test page.
 *
 * Positions come from the layout the server sends (points, origin top-left),
 * so the printer calibration in the bank account's settings is already in
 * them. The work is split in two so it can be tested without a PDF library:
 * `planChecksPdf` decides what goes where as a list of drawing operations, and
 * `renderChecksPdf` draws that list with embedded standard fonts.
 *
 * A vendor that backup withholding was taken from gets a check for the net
 * amount (the server sends the net in `amount`, the amount box and the words).
 * Its stub lists the bills at what they settled for and ends with the gross,
 * the withholding as a deduction and the net, which is the check.
 *
 * Two kinds of stock:
 * - Preprinted stock (the default): the bank, payer, labels, signature line,
 *   check number and MICR line are on the paper already, so only the variable
 *   fields are drawn: date, payee and address, amount, amount in words, memo.
 *   The voucher stubs are drawn in full.
 * - Blank stock (`settings.printMicr`): the whole check face is drawn as well.
 *   The MICR line needs an E-13B font, which is not bundled, so the MICR band
 *   stays empty (`micrSkipped`) and the screen says so. The account number
 *   that comes with the MICR data is never written to the PDF.
 */
import { PDFDocument, StandardFonts, rgb, type PDFFont } from 'pdf-lib';
import type {
  CheckFace,
  CheckLayout,
  CheckPrintData,
  CheckPrintItem,
  CheckVoucher,
  TextBox,
} from '@/lib/api/domains/weldbooks-payment-runs';

export type PdfFontKey = 'helvetica' | 'helvetica-bold' | 'courier' | 'courier-bold';

export interface TextOp {
  kind: 'text';
  page: number;
  text: string;
  /** Left edge of the text, already aligned. */
  x: number;
  /** Baseline, from the top of the page. */
  y: number;
  size: number;
  font: PdfFontKey;
  /** 0 is black, 1 is white. */
  gray: number;
}

export interface LineOp {
  kind: 'line';
  page: number;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  thickness: number;
  gray: number;
}

export interface RectOp {
  kind: 'rect';
  page: number;
  x: number;
  /** Top edge, from the top of the page. */
  y: number;
  width: number;
  height: number;
  thickness: number;
  gray: number;
  dashed: boolean;
}

export type PdfOp = TextOp | LineOp | RectOp;

/** What the planner needs to know about the fonts. */
export interface TextMetrics {
  width: (font: PdfFontKey, size: number, text: string) => number;
  /** The text with the characters the font can't draw taken out. */
  clean: (font: PdfFontKey, text: string) => string;
}

export interface CheckPdfPlan {
  pageCount: number;
  pageSize: { width: number; height: number };
  ops: PdfOp[];
  /** Blank stock asked for a MICR line; the MICR band was left empty. */
  micrSkipped: boolean;
  /** Checks drawn, in print order. */
  checkNumbers: string[];
}

/** Translated text printed on the checks and the test page. `{count}` and the offsets are filled in. */
export interface CheckPdfLabels {
  /** "PAY TO THE ORDER OF"; a line break makes two lines. */
  payTo: string;
  date: string;
  dollars: string;
  memo: string;
  voidAfter: string;
  /** Title of a voucher stub. */
  paymentDetails: string;
  /** Before the check number on a stub: "No.". */
  checkNumberPrefix: string;
  columnDate: string;
  columnReference: string;
  columnDescription: string;
  columnAmount: string;
  /** The last line of a stub: the amount of the check. */
  total: string;
  /** Stub with backup withholding: the bills added up, before the withholding. */
  grossTotal: string;
  /** Stub with backup withholding: the deduction. */
  backupWithholding: string;
  /** Stub with backup withholding: the last line, the amount the check is written for. */
  netTotal: string;
  /** "+{count} more" when a stub has more bills than rows. */
  moreRows: string;
  alignmentTitle: string;
  /** Uses `{dx}`, `{dy}`, `{micrDx}` and `{micrDy}`. */
  alignmentOffsets: string;
  alignmentHint: string;
}

export interface CheckPdfResult {
  bytes: Uint8Array;
  pageCount: number;
  micrSkipped: boolean;
  checkNumbers: string[];
}

const INK = 0;
const FAINT = 0.55;
const MIN_FIT_SIZE = 5;

// ---------------------------------------------------------------------------
// Text helpers

function fontKeyOf(box: Pick<TextBox, 'font' | 'bold'>, bold = box.bold): PdfFontKey {
  if (box.font === 'courier') return bold ? 'courier-bold' : 'courier';
  return bold ? 'helvetica-bold' : 'helvetica';
}

/** `2026-10-08` as `10/08/2026`; anything else as it is. */
export function usDate(value: string | null | undefined): string {
  const match = value ? /^(\d{4})-(\d{2})-(\d{2})/.exec(value) : null;
  return match ? `${match[2]}/${match[3]}/${match[1]}` : (value ?? '');
}

/** `1234.5` as `1,234.50`. */
export function usAmount(value: string | number | null | undefined): string {
  const n = typeof value === 'number' ? value : Number.parseFloat(value ?? '');
  if (!Number.isFinite(n)) return '';
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

class Planner {
  readonly ops: PdfOp[] = [];

  constructor(private readonly metrics: TextMetrics) {}

  private fit(font: PdfFontKey, text: string, size: number, maxWidth: number, shrink: boolean): { text: string; size: number } {
    let current = size;
    if (shrink) {
      while (current > MIN_FIT_SIZE && this.metrics.width(font, current, text) > maxWidth) current = Math.max(MIN_FIT_SIZE, current - 0.25);
    }
    if (this.metrics.width(font, current, text) <= maxWidth) return { text, size: current };
    let cut = text;
    while (cut.length > 1 && this.metrics.width(font, current, `${cut}...`) > maxWidth) cut = cut.slice(0, -1);
    return { text: `${cut.trimEnd()}...`, size: current };
  }

  /** One line of text in a box (or at an explicit baseline), aligned and fitted to the box. */
  text(
    page: number,
    box: Pick<TextBox, 'x' | 'width' | 'align' | 'fontSize' | 'font' | 'bold'>,
    baseline: number,
    value: string,
    options: { size?: number; bold?: boolean; shrink?: boolean; gray?: number } = {},
  ): void {
    const font = fontKeyOf(box, options.bold ?? box.bold);
    const cleaned = this.metrics.clean(font, value).replace(/\s+/g, ' ').trim();
    if (!cleaned) return;
    const fitted = this.fit(font, cleaned, options.size ?? box.fontSize, box.width, options.shrink ?? false);
    const width = this.metrics.width(font, fitted.size, fitted.text);
    let x = box.x;
    if (box.align === 'right') x = box.x + box.width - width;
    else if (box.align === 'center') x = box.x + (box.width - width) / 2;
    this.ops.push({ kind: 'text', page, text: fitted.text, x, y: baseline, size: fitted.size, font, gray: options.gray ?? INK });
  }

  /** Lines under each other from the box's first baseline. */
  lines(
    page: number,
    box: TextBox,
    values: readonly string[],
    options: { limit?: number; size?: number; boldFirst?: boolean; restSize?: number } = {},
  ): void {
    const gap = box.lineHeight ?? box.fontSize + 2;
    values.slice(0, options.limit ?? 4).forEach((value, i) => {
      this.text(page, box, box.y + i * gap, value, {
        size: i === 0 ? options.size : (options.restSize ?? options.size),
        bold: options.boldFirst ? i === 0 : box.bold,
        shrink: true,
      });
    });
  }

  /** A printed label; a line break stacks it upwards from the baseline. */
  label(page: number, box: TextBox, value: string): void {
    const parts = value.split('\n');
    const gap = box.fontSize + 0.5;
    parts.forEach((part, i) => {
      this.text(page, box, box.y - (parts.length - 1 - i) * gap, part, { shrink: true });
    });
  }

  line(page: number, x1: number, y1: number, x2: number, y2: number, thickness = 0.5, gray = INK): void {
    this.ops.push({ kind: 'line', page, x1, y1, x2, y2, thickness, gray });
  }

  rect(page: number, x: number, y: number, width: number, height: number, options: { thickness?: number; gray?: number; dashed?: boolean } = {}): void {
    this.ops.push({
      kind: 'rect',
      page,
      x,
      y,
      width,
      height,
      thickness: options.thickness ?? 0.5,
      gray: options.gray ?? INK,
      dashed: options.dashed ?? false,
    });
  }
}

// ---------------------------------------------------------------------------
// Checks

function drawFace(p: Planner, page: number, face: CheckFace, check: CheckPrintItem, data: CheckPrintData, labels: CheckPdfLabels): void {
  const f = face.fields;
  const blank = data.settings.printMicr;

  // What changes from check to check, on any stock.
  p.text(page, f.date, f.date.y, check.dateDisplay);
  p.text(page, f.payee, f.payee.y, check.payee.name, { shrink: true });
  p.lines(page, f.payeeAddress, check.payee.addressLines, { limit: 3 });
  p.text(page, f.amount, f.amount.y, check.courtesyAmount, { shrink: true });
  p.text(page, f.amountWords, f.amountWords.y, check.amountInWords, { shrink: true });
  if (check.memo) p.text(page, f.memo, f.memo.y, check.memo, { shrink: true });

  if (!blank) return;

  // Blank stock: everything the bank would have printed, except the MICR line.
  p.lines(page, f.payer, [data.payer.name, ...(data.payer.dba ? [`dba ${data.payer.dba}`] : []), ...data.payer.addressLines], {
    limit: 4,
    boldFirst: true,
    restSize: 8,
  });
  p.lines(page, f.bank, [...(data.bank.name ? [data.bank.name] : []), ...data.bank.addressLines], { limit: 4 });
  p.text(page, f.checkNumber, f.checkNumber.y, check.checkNumber);
  if (check.fractionalRouting) p.text(page, f.fractional, f.fractional.y, check.fractionalRouting);
  p.label(page, f.dateLabel, labels.date);
  p.label(page, f.payeeLabel, labels.payTo);
  p.label(page, f.dollarsLabel, labels.dollars);
  p.label(page, f.memoLabel, labels.memo);
  p.rect(page, f.amountBox.x, f.amountBox.y, f.amountBox.width, f.amountBox.height, { thickness: 0.75 });
  p.line(page, f.signatureLine.x1, f.signatureLine.y1, f.signatureLine.x2, f.signatureLine.y2, 0.75);
  if (data.settings.signatureLineText) {
    p.text(
      page,
      { x: f.signatureLine.x1, width: f.signatureLine.x2 - f.signatureLine.x1, align: 'center', fontSize: 6.5, font: 'helvetica' },
      f.signatureLine.y1 + 8,
      data.settings.signatureLineText,
      { shrink: true },
    );
  }
  p.label(page, f.voidAfter, labels.voidAfter);
}

function drawVoucher(p: Planner, page: number, voucher: CheckVoucher, check: CheckPrintItem, data: CheckPrintData, labels: CheckPdfLabels): void {
  const v = voucher.fields;
  p.text(page, v.payer, v.payer.y, data.payer.name, { shrink: true });
  p.text(page, v.title, v.title.y, labels.paymentDetails);
  p.text(page, v.payee, v.payee.y, check.payee.name, { shrink: true });
  p.text(page, v.date, v.date.y, check.dateDisplay);
  p.text(page, v.checkNumber, v.checkNumber.y, `${labels.checkNumberPrefix} ${check.checkNumber}`.trim());

  const table = v.table;
  const headers: Record<'date' | 'reference' | 'description' | 'amount', string> = {
    date: labels.columnDate,
    reference: labels.columnReference,
    description: labels.columnDescription,
    amount: labels.columnAmount,
  };
  for (const column of table.columns) {
    p.text(page, { x: column.x, width: column.width, align: column.align, fontSize: table.fontSize - 1, font: 'helvetica' }, table.y - 4, headers[column.key], {
      bold: true,
      shrink: true,
    });
  }

  const withheld = check.voucher.backupWithholding;
  // Two more lines (gross and withholding) stand above the total, so the table gives up two rows.
  const maxRows = withheld ? Math.max(1, table.maxRows - 2) : table.maxRows;
  const rows = check.voucher.rows;
  const overflow = rows.length > maxRows;
  const shown = overflow ? rows.slice(0, Math.max(0, maxRows - 1)) : rows;
  shown.forEach((row, i) => {
    const baseline = table.y + (i + 1) * table.rowHeight - 3;
    const cells: Record<'date' | 'reference' | 'description' | 'amount', string> = {
      date: usDate(row.date),
      reference: row.reference ?? '',
      description: row.description ?? '',
      amount: usAmount(row.amount),
    };
    for (const column of table.columns) {
      p.text(page, { x: column.x, width: column.width, align: column.align, fontSize: table.fontSize, font: 'helvetica' }, baseline, cells[column.key]);
    }
  });
  if (overflow) {
    const baseline = table.y + (shown.length + 1) * table.rowHeight - 3;
    const reference = table.columns.find((c) => c.key === 'reference');
    if (reference) {
      p.text(
        page,
        { x: reference.x, width: reference.width, align: 'left', fontSize: table.fontSize, font: 'helvetica' },
        baseline,
        labels.moreRows.replace('{count}', String(rows.length - shown.length)),
      );
    }
  }

  if (withheld) {
    // Gross, the deduction and the net (the check), a line apart, the net where the total always is.
    const wide = (box: TextBox): TextBox => ({ ...box, x: box.x - 70, width: box.width + 70 });
    const gap = 12;
    const lines: Array<[string, string, number, boolean]> = [
      [labels.grossTotal, usAmount(check.voucher.grossTotal), -2 * gap, false],
      [labels.backupWithholding, `-${usAmount(withheld)}`, -gap, false],
      [labels.netTotal, usAmount(check.voucher.total), 0, true],
    ];
    for (const [label, amount, shift, bold] of lines) {
      p.text(page, wide(v.totalLabel), v.totalLabel.y + shift, label, { shrink: true, bold });
      p.text(page, v.total, v.total.y + shift, amount, { bold });
    }
    return;
  }
  p.text(page, v.totalLabel, v.totalLabel.y, labels.total);
  p.text(page, v.total, v.total.y, usAmount(check.voucher.total));
}

/** Everything the checks of a run print: one page per check, or three checks per page. */
export function planChecksPdf(data: CheckPrintData, labels: CheckPdfLabels, metrics: TextMetrics): CheckPdfPlan {
  const layout = data.layout;
  const perPage = Math.max(1, layout.faces.length);
  const p = new Planner(metrics);

  data.checks.forEach((check, index) => {
    const page = Math.floor(index / perPage);
    const face = layout.faces[index % perPage];
    if (!face) return;
    drawFace(p, page, face, check, data, labels);
    // Stubs belong to the check on a page of their own; a three-up page has none.
    if (perPage === 1) for (const voucher of layout.vouchers) drawVoucher(p, page, voucher, check, data, labels);
  });

  return {
    pageCount: Math.ceil(data.checks.length / perPage),
    pageSize: layout.page,
    ops: p.ops,
    micrSkipped: data.settings.printMicr && data.checks.length > 0,
    checkNumbers: data.checks.map((c) => c.checkNumber),
  };
}

// ---------------------------------------------------------------------------
// Alignment test page

const FACE_FIELD_KEYS = [
  'payer',
  'bank',
  'checkNumber',
  'fractional',
  'dateLabel',
  'date',
  'payeeLabel',
  'payee',
  'payeeAddress',
  'amount',
  'amountWords',
  'dollarsLabel',
  'memoLabel',
  'memo',
  'voidAfter',
] as const;

const MICR_FIELD_KEYS = ['micrAuxOnUs', 'micrTransit', 'micrOnUs'] as const;

const VOUCHER_FIELD_KEYS = ['payer', 'title', 'payee', 'date', 'checkNumber', 'totalLabel', 'total'] as const;

/** The rectangle a one-line text box occupies: its baseline and a little above and below. */
function textRect(box: TextBox): { x: number; y: number; width: number; height: number } {
  const ascent = box.fontSize * 0.85;
  return { x: box.x, y: box.y - ascent, width: box.width, height: box.fontSize * 1.1 };
}

/**
 * A page with a box at every field of the layout, a ruler along the top and
 * left edges and the current offsets. Print it on plain paper at 100%, hold it
 * against the check stock in front of a light and read off how far each box
 * is from where its field belongs.
 */
export function planAlignmentTestPdf(
  layout: CheckLayout,
  labels: CheckPdfLabels,
  metrics: TextMetrics,
  options: { alignment?: { dx?: number; dy?: number; micrDx?: number; micrDy?: number } } = {},
): CheckPdfPlan {
  const p = new Planner(metrics);
  const small = { x: 0, width: 0, align: 'left' as const, fontSize: 5, font: 'helvetica' as const };

  const tag = (box: TextBox, name: string) => {
    const r = textRect(box);
    p.rect(0, r.x, r.y, r.width, r.height, { thickness: 0.4, gray: FAINT });
    p.text(0, { ...small, x: r.x + 1, width: Math.max(r.width - 2, 1) }, r.y + r.height - 2, name, { gray: FAINT, shrink: true });
  };

  for (const face of layout.faces) {
    p.rect(0, 0.5, face.top + 0.5, layout.page.width - 1, face.height - 1, { thickness: 0.5, gray: 0.75, dashed: true });
    for (const key of FACE_FIELD_KEYS) tag(face.fields[key], key);
    for (const key of MICR_FIELD_KEYS) {
      const r = textRect(face.fields[key]);
      p.rect(0, r.x, r.y, r.width, r.height, { thickness: 0.8, gray: 0.2, dashed: true });
      p.text(0, { ...small, x: r.x + 1, width: Math.max(r.width - 2, 1) }, r.y - 2, key, { gray: FAINT, shrink: true });
    }
    const box = face.fields.amountBox;
    p.rect(0, box.x, box.y, box.width, box.height, { thickness: 0.75 });
    const sig = face.fields.signatureLine;
    p.line(0, sig.x1, sig.y1, sig.x2, sig.y2, 0.75);
  }

  for (const voucher of layout.vouchers) {
    p.rect(0, 0.5, voucher.top + 0.5, layout.page.width - 1, voucher.height - 1, { thickness: 0.5, gray: 0.75, dashed: true });
    for (const key of VOUCHER_FIELD_KEYS) tag(voucher.fields[key], key);
    const table = voucher.fields.table;
    p.rect(0, table.x, table.y, table.width, table.height, { thickness: 0.4, gray: FAINT });
    for (const column of table.columns) p.line(0, column.x, table.y, column.x, table.y + table.height, 0.3, 0.8);
  }

  // Ruler: a tick every quarter inch, a longer one with its number every inch.
  for (let pos = 0; pos <= layout.page.width; pos += 18) {
    const inch = pos % 72 === 0;
    p.line(0, pos, 0, pos, inch ? 10 : 5, 0.4, INK);
    if (inch && pos > 0) p.text(0, { ...small, x: pos + 1, width: 20 }, 16, String(pos / 72), { gray: FAINT });
  }
  for (let pos = 0; pos <= layout.page.height; pos += 18) {
    const inch = pos % 72 === 0;
    p.line(0, 0, pos, inch ? 10 : 5, pos, 0.4, INK);
    if (inch && pos > 0) p.text(0, { ...small, x: 12, width: 20 }, pos + 2, String(pos / 72), { gray: FAINT });
  }

  const first = layout.faces[0];
  if (first) {
    const align = options.alignment ?? {};
    const note: TextBox = { x: 36, y: first.top + 62, width: 240, align: 'left', fontSize: 7, font: 'helvetica', lineHeight: 8.5 };
    const offsets = labels.alignmentOffsets
      .replace('{dx}', String(align.dx ?? 0))
      .replace('{dy}', String(align.dy ?? 0))
      .replace('{micrDx}', String(align.micrDx ?? 0))
      .replace('{micrDy}', String(align.micrDy ?? 0));
    p.lines(0, note, [labels.alignmentTitle, labels.alignmentHint, offsets], { limit: 3, boldFirst: true, restSize: 6 });
  }

  return { pageCount: 1, pageSize: layout.page, ops: p.ops, micrSkipped: false, checkNumbers: [] };
}

// ---------------------------------------------------------------------------
// Drawing

const FONT_NAMES: Record<PdfFontKey, StandardFonts> = {
  helvetica: StandardFonts.Helvetica,
  'helvetica-bold': StandardFonts.HelveticaBold,
  courier: StandardFonts.Courier,
  'courier-bold': StandardFonts.CourierBold,
};

/** Narrow and thin spaces some strings carry; the standard fonts can't draw them. */
const ODD_SPACES = new RegExp('[' + String.fromCharCode(0x202f, 0x2009, 0x00a0) + ']', 'g');

async function embedMetrics(doc: PDFDocument): Promise<{ metrics: TextMetrics; fonts: Record<PdfFontKey, PDFFont> }> {
  const entries = await Promise.all(
    (Object.keys(FONT_NAMES) as PdfFontKey[]).map(async (key) => [key, await doc.embedFont(FONT_NAMES[key])] as const),
  );
  const fonts = Object.fromEntries(entries) as Record<PdfFontKey, PDFFont>;
  const encodable = new Map<string, boolean>();
  const canDraw = (font: PdfFontKey, ch: string): boolean => {
    const id = `${font}:${ch}`;
    let ok = encodable.get(id);
    if (ok === undefined) {
      try {
        fonts[font].widthOfTextAtSize(ch, 10);
        ok = true;
      } catch {
        ok = false;
      }
      encodable.set(id, ok);
    }
    return ok;
  };
  const metrics: TextMetrics = {
    clean: (font, text) => Array.from(text.replace(ODD_SPACES, ' ')).filter((ch) => canDraw(font, ch)).join(''),
    width: (font, size, text) => fonts[font].widthOfTextAtSize(text, size),
  };
  return { metrics, fonts };
}

async function drawPlan(doc: PDFDocument, fonts: Record<PdfFontKey, PDFFont>, plan: CheckPdfPlan): Promise<Uint8Array> {
  const { width, height } = plan.pageSize;
  const pages = Array.from({ length: Math.max(plan.pageCount, 1) }, () => doc.addPage([width, height]));
  for (const op of plan.ops) {
    const page = pages[op.page];
    if (!page) continue;
    const color = rgb(op.gray, op.gray, op.gray);
    if (op.kind === 'text') {
      page.drawText(op.text, { x: op.x, y: height - op.y, size: op.size, font: fonts[op.font], color });
    } else if (op.kind === 'line') {
      page.drawLine({ start: { x: op.x1, y: height - op.y1 }, end: { x: op.x2, y: height - op.y2 }, thickness: op.thickness, color });
    } else {
      page.drawRectangle({
        x: op.x,
        y: height - op.y - op.height,
        width: op.width,
        height: op.height,
        borderWidth: op.thickness,
        borderColor: color,
        ...(op.dashed ? { borderDashArray: [3, 2] } : {}),
      });
    }
  }
  return doc.save();
}

function toResult(plan: CheckPdfPlan, bytes: Uint8Array): CheckPdfResult {
  return { bytes, pageCount: plan.pageCount, micrSkipped: plan.micrSkipped, checkNumbers: plan.checkNumbers };
}

/** The checks of a run as a PDF, ready to print on Letter. */
export async function renderChecksPdf(data: CheckPrintData, labels: CheckPdfLabels): Promise<CheckPdfResult> {
  const doc = await PDFDocument.create();
  const { metrics, fonts } = await embedMetrics(doc);
  const plan = planChecksPdf(data, labels, metrics);
  return toResult(plan, await drawPlan(doc, fonts, plan));
}

/** The alignment test page for a layout (with the printer offsets already applied). */
export async function renderAlignmentTestPdf(
  layout: CheckLayout,
  labels: CheckPdfLabels,
  options: { alignment?: { dx?: number; dy?: number; micrDx?: number; micrDy?: number } } = {},
): Promise<CheckPdfResult> {
  const doc = await PDFDocument.create();
  const { metrics, fonts } = await embedMetrics(doc);
  const plan = planAlignmentTestPdf(layout, labels, metrics, options);
  return toResult(plan, await drawPlan(doc, fonts, plan));
}
