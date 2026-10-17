/**
 * Invoice template layout engine.
 *
 * Turns a template and an invoice into pages of positioned primitives (text
 * runs, rectangles, lines, images, a QR code). The PDF and SVG painters only
 * draw what this returns, so both outputs agree to the point.
 *
 * Rules a designer can rely on:
 * - Every block is a minimum-size box: content that needs more room makes the
 *   box taller, and blocks underneath it (horizontally overlapping) move down
 *   by as much. Nothing ever moves up.
 * - The line-items table is the one block that splits across pages; its
 *   header repeats on every page it continues on.
 * - Blocks below the table follow it onto its last page, and a row of blocks
 *   that no longer fits there moves to a new page together.
 * - `everyPage` blocks repeat at their own position on every page. Those in the
 *   top half end the header band of continuation pages, those in the bottom
 *   half start the footer band the table stops above.
 * - Totals and the legal notices are never lost: when a template has no such
 *   block they are added under the last block, and columns a jurisdiction
 *   requires are added to the table.
 */
import type { Align, InvoiceDocumentData, PartyData, TotalsRowData } from './data';
import { legible } from './colors';
import { ascentRatio, normalizeText, textWidth, wrapText, type FontFace } from './fonts';
import {
  PAPER_SIZES,
  TEMPLATE_FIELDS,
  type BlockOf,
  type BoxStyle,
  type InvoiceTemplateDocument,
  type LabelStyle,
  type LineItemColumnKey,
  type TemplateBlock,
  type TemplateColor,
  type TemplateField,
  type TemplateTheme,
  type TextStyle,
} from './schema';

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

export type Primitive =
  | {
      kind: 'text';
      x: number;
      /** Baseline, from the top of the page. */
      y: number;
      text: string;
      size: number;
      face: FontFace;
      color: string;
    }
  | {
      kind: 'rect';
      x: number;
      y: number;
      w: number;
      h: number;
      fill?: string;
      stroke?: string;
      strokeWidth?: number;
      radius?: number;
    }
  | { kind: 'line'; x1: number; y1: number; x2: number; y2: number; color: string; width: number }
  /** Drawn to fit inside the box, aspect ratio kept. */
  | { kind: 'image'; x: number; y: number; w: number; h: number; src: string; align: Align }
  | { kind: 'qr'; x: number; y: number; size: number; matrix: boolean[][] }
  | { kind: 'watermark'; text: string; size: number; color: string; face: FontFace };

export interface LayoutPage {
  primitives: Primitive[];
}

/** Where a block ended up, for the designer (overflow outlines, selection). */
export interface BlockPlacement {
  id: string;
  page: number;
  x: number;
  y: number;
  w: number;
  h: number;
  /** The block needed more room than its box. */
  grew: boolean;
  /** The block printed somewhere else than designed (pushed down, or onto a later page). */
  moved: boolean;
}

export interface InvoiceLayout {
  width: number;
  height: number;
  pages: LayoutPage[];
  placements: BlockPlacement[];
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

interface Ctx {
  theme: TemplateTheme;
  data: InvoiceDocumentData;
}

function color(value: TemplateColor | undefined, ctx: Ctx, fallback: TemplateColor): string {
  const v = value ?? fallback;
  if (v === 'accent') return ctx.theme.accent;
  if (v === 'text') return ctx.theme.text;
  if (v === 'muted') return ctx.theme.muted;
  return v;
}

interface ResolvedText {
  size: number;
  face: FontFace;
  color: string;
  align: Align;
  lineHeight: number;
  uppercase: boolean;
}

function textStyle(style: TextStyle | undefined, ctx: Ctx, defaults: Partial<ResolvedText> & { colorToken?: TemplateColor } = {}): ResolvedText {
  return {
    size: style?.fontSize ?? defaults.size ?? ctx.theme.fontSize,
    face: { font: ctx.theme.font, bold: style?.bold ?? defaults.face?.bold, italic: style?.italic ?? defaults.face?.italic },
    color: color(style?.color, ctx, defaults.colorToken ?? 'text'),
    align: style?.align ?? defaults.align ?? 'left',
    lineHeight: style?.lineHeight ?? defaults.lineHeight ?? 1.3,
    uppercase: style?.uppercase ?? defaults.uppercase ?? false,
  };
}

function labelStyle(label: LabelStyle | undefined, ctx: Ctx, align: Align): ResolvedText {
  return {
    size: label?.fontSize ?? Math.max(6, ctx.theme.fontSize - 1.5),
    face: { font: ctx.theme.font, bold: label?.bold ?? true },
    color: color(label?.color, ctx, 'muted'),
    align,
    lineHeight: 1.3,
    uppercase: label?.uppercase ?? true,
  };
}

// ---------------------------------------------------------------------------
// Text runs
// ---------------------------------------------------------------------------

function baselineOffset(style: ResolvedText): number {
  const ascent = ascentRatio(style.face);
  // Center the font's ascent + a typical 0.21 descent in the line box.
  const glyph = (ascent + 0.21) * style.size;
  return (style.lineHeight * style.size - glyph) / 2 + ascent * style.size;
}

/** Lines of text set in a column; returns the primitives and the height used. */
function setLines(
  lines: string[],
  style: ResolvedText,
  x: number,
  y: number,
  width: number,
): { primitives: Primitive[]; height: number } {
  const primitives: Primitive[] = [];
  const lineBox = style.size * style.lineHeight;
  const base = baselineOffset(style);
  lines.forEach((line, i) => {
    if (!line) return;
    const w = textWidth(line, style.size, style.face);
    let lx = x;
    if (style.align === 'right') lx = x + width - w;
    else if (style.align === 'center') lx = x + (width - w) / 2;
    primitives.push({ kind: 'text', x: lx, y: y + i * lineBox + base, text: line, size: style.size, face: style.face, color: style.color });
  });
  return { primitives, height: lines.length * lineBox };
}

/** Wraps and sets a paragraph. */
function setText(text: string, style: ResolvedText, x: number, y: number, width: number) {
  const value = style.uppercase ? text.toUpperCase() : text;
  return setLines(wrapText(value, style.size, style.face, Math.max(1, width)), style, x, y, width);
}

// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------

/** A block measured at its width: how tall its content is and how to paint it at a spot. */
interface Measured {
  /** Content height, padding included. */
  height: number;
  /** Nothing to print (empty notes, no ship-to address): the box style is skipped too. */
  empty?: boolean;
  /** Fixed-size blocks (shapes, images) keep their box height. */
  fixed?: boolean;
  paint: (x: number, y: number, h: number) => Primitive[];
}

const NOTHING: Measured = { height: 0, empty: true, paint: () => [] };

export function fieldValue(data: InvoiceDocumentData, field: TemplateField): string {
  return (data.fields[field] ?? '').toString().trim();
}

const FIELD_NAMES = new Set<string>(TEMPLATE_FIELDS);

/** `{{invoiceNumber}}` placeholders; a field without a value prints nothing, unknown names stay as written. */
export function fillPlaceholders(text: string, data: InvoiceDocumentData): string {
  return text
    .split('\n')
    .map((line) => fillLine(line, data))
    .filter((line): line is string => line !== null)
    .join('\n');
}

/** A static piece that only separates two values (" · ", " | ", ", "). */
const SEPARATOR = /^\s*[·•|,–—/]\s*$/;

/**
 * One line with its placeholders filled. A line whose placeholders all print nothing ("Tel. {{sellerPhone}}"
 * without a phone number) is left out (null); a separator next to an empty value goes with it.
 */
function fillLine(line: string, data: InvoiceDocumentData): string | null {
  // Odd entries are placeholder names, even entries the static text around them.
  const parts = line.split(/\{\{\s*(\w+)\s*\}\}/);
  if (parts.length === 1) return line;
  const values = parts.map((part, i) => {
    if (i % 2 === 0) return part;
    return FIELD_NAMES.has(part) ? fieldValue(data, part as TemplateField) : `{{${part}}}`;
  });
  const empty = (i: number) => i % 2 === 1 && values[i] === '';
  if (values.every((value, i) => i % 2 === 0 || empty(i))) return null;
  values.forEach((_, i) => {
    if (!empty(i)) return;
    // Drop the separator before the empty value, or after it when it leads the line.
    if (i - 1 > 0 && SEPARATOR.test(values[i - 1])) values[i - 1] = '';
    else if (i + 1 < values.length - 1 && SEPARATOR.test(values[i + 1])) values[i + 1] = '';
  });
  return values.join('');
}

/** Stacks text pieces top to bottom with small gaps; empty pieces are skipped. */
function stack(pieces: Array<{ text: string[]; style: ResolvedText; gapBefore?: number } | null>, width: number): Measured {
  const present = pieces.filter((p): p is NonNullable<typeof p> => !!p && p.text.some(Boolean));
  if (present.length === 0) return NOTHING;
  const wrapped = present.map((p) => ({
    ...p,
    lines: p.text.flatMap((t) => wrapText(p.style.uppercase ? t.toUpperCase() : t, p.style.size, p.style.face, Math.max(1, width))),
  }));
  const height = wrapped.reduce((h, p, i) => h + (i > 0 ? (p.gapBefore ?? 0) : 0) + p.lines.length * p.style.size * p.style.lineHeight, 0);
  return {
    height,
    paint: (x, y) => {
      const out: Primitive[] = [];
      let cy = y;
      wrapped.forEach((p, i) => {
        if (i > 0) cy += p.gapBefore ?? 0;
        const set = setLines(p.lines, p.style, x, cy, width);
        out.push(...set.primitives);
        cy += set.height;
      });
      return out;
    },
  };
}

function labelPiece(label: LabelStyle | undefined, fallback: string, ctx: Ctx, align: Align) {
  if (label?.show === false) return null;
  return { text: [label?.text ?? fallback], style: labelStyle(label, ctx, align) };
}

/** Seller: email / phone / website; bill to: the email; ship to: none. */
function partyShowsContact(block: BlockOf<'seller'> | BlockOf<'billTo'> | BlockOf<'shipTo'>): boolean {
  if (block.type === 'seller') return block.showContact !== false;
  if (block.type === 'billTo') return block.showEmail !== false;
  return false;
}

function measureParty(
  block: BlockOf<'seller'> | BlockOf<'billTo'> | BlockOf<'shipTo'>,
  party: PartyData | null | undefined,
  defaultLabel: string,
  ctx: Ctx,
  width: number,
): Measured {
  if (!party || (!party.name && party.lines.length === 0)) return NOTHING;
  const body = textStyle(block.style, ctx);
  const nameStyle: ResolvedText = { ...body, face: { ...body.face, bold: block.boldName ?? true } };
  const showContact = partyShowsContact(block);
  const showTaxIds = block.type === 'seller' ? block.showTaxIds !== false : true;
  if (block.inline) {
    const parts = [party.name, ...party.lines, ...(showContact ? (party.contactLines ?? []) : []), ...(showTaxIds ? (party.taxIdLines ?? []) : [])];
    return stack([labelPiece(block.label, defaultLabel, ctx, body.align), { text: [parts.filter(Boolean).join(' · ')], style: body, gapBefore: 3 }], width);
  }
  return stack(
    [
      labelPiece(block.label, defaultLabel, ctx, body.align),
      { text: [party.name], style: nameStyle, gapBefore: 3 },
      { text: party.lines, style: body },
      showContact ? { text: party.contactLines ?? [], style: body } : null,
      showTaxIds ? { text: party.taxIdLines ?? [], style: body } : null,
    ],
    width,
  );
}

function measureField(block: BlockOf<'field'>, ctx: Ctx, width: number): Measured {
  const value = fieldValue(ctx.data, block.field);
  if (!value) return NOTHING;
  const style = textStyle(block.style, ctx);
  const layout = block.layout ?? 'stacked';
  const labelText = block.label?.text ?? ctx.data.fieldLabels[block.field] ?? '';
  if (layout === 'value' || block.label?.show === false || !labelText) {
    return stack([{ text: [value], style }], width);
  }
  if (layout === 'stacked') {
    return stack([labelPiece(block.label, labelText, ctx, style.align), { text: [value], style, gapBefore: 2 }], width);
  }
  // inline: label left, value right on one line (value wraps under itself when long).
  const lStyle = { ...labelStyle(block.label, ctx, 'left'), uppercase: block.label?.uppercase ?? false, size: block.label?.fontSize ?? style.size };
  const labelValue = lStyle.uppercase ? labelText.toUpperCase() : labelText;
  const labelW = Math.min(width * 0.6, textWidth(normalizeText(labelValue), lStyle.size, lStyle.face) + 8);
  const vStyle: ResolvedText = { ...style, align: 'right' };
  const valueLines = wrapText(value, vStyle.size, vStyle.face, Math.max(1, width - labelW));
  const height = Math.max(lStyle.size * lStyle.lineHeight, valueLines.length * vStyle.size * vStyle.lineHeight);
  return {
    height,
    paint: (x, y) => [
      ...setLines([normalizeText(labelValue)], { ...lStyle, lineHeight: vStyle.lineHeight * (vStyle.size / lStyle.size) }, x, y, labelW).primitives,
      ...setLines(valueLines, vStyle, x + labelW, y, width - labelW).primitives,
    ],
  };
}

function measureTotals(block: BlockOf<'totals'>, ctx: Ctx, width: number): Measured {
  const rows = block.showBalance === false ? ctx.data.totals.filter((r) => r.kind !== 'balance') : ctx.data.totals;
  if (rows.length === 0) return NOTHING;
  const base = textStyle(block.style, ctx);
  const totalSize = block.total?.fontSize ?? base.size + 2;
  const rowGap = 3;
  const totalPad = 5;
  const layoutRows = rows.map((row) => {
    const style = totalsRowStyle(row, base, block, ctx, totalSize);
    const labelLines = wrapText(style.label.uppercase ? row.label.toUpperCase() : row.label, style.label.size, style.label.face, width * 0.62);
    const rowH = Math.max(labelLines.length, 1) * style.label.size * style.label.lineHeight;
    const extra = row.kind === 'total' ? totalPad * 2 : 0;
    return { row, style, labelLines, height: rowH + extra };
  });
  const height = layoutRows.reduce((h, r) => h + r.height + rowGap, -rowGap);
  return {
    height,
    paint: (x, y) => {
      const out: Primitive[] = [];
      let cy = y;
      for (const r of layoutRows) {
        if (r.row.kind === 'total') {
          if (block.total?.background) {
            out.push({ kind: 'rect', x, y: cy, w: width, h: r.height, fill: color(block.total.background, ctx, 'accent') });
          }
          out.push({ kind: 'line', x1: x, y1: cy, x2: x + width, y2: cy, color: color(block.total?.rule, ctx, 'accent'), width: 1 });
        }
        const inset = r.row.kind === 'total' ? totalPad : 0;
        const pad = r.row.kind === 'total' && block.total?.background ? 6 : 0;
        out.push(...setLines(r.labelLines, { ...r.style.label, align: 'left' }, x + pad, cy + inset, width * 0.62).primitives);
        if (r.row.value) {
          out.push(...setLines([normalizeText(r.row.value)], { ...r.style.value, align: 'right' }, x, cy + inset, width - pad).primitives);
        }
        cy += r.height + rowGap;
      }
      return out;
    },
  };
}

function totalsRowStyle(row: TotalsRowData, base: ResolvedText, block: BlockOf<'totals'>, ctx: Ctx, totalSize: number) {
  switch (row.kind) {
    case 'heading': {
      const s: ResolvedText = { ...base, size: base.size - 1.5, face: { ...base.face, bold: true }, color: ctx.theme.muted, uppercase: true };
      return { label: s, value: s };
    }
    case 'muted': {
      const s: ResolvedText = { ...base, size: base.size - 1, color: ctx.theme.muted };
      return { label: s, value: s };
    }
    case 'total': {
      const s: ResolvedText = { ...base, size: totalSize, face: { ...base.face, bold: true }, color: color(block.total?.color, ctx, 'text') };
      return { label: s, value: s };
    }
    case 'balance': {
      // The accent, darkened as far as a pale one (yellow, mint) needs to stay readable on the block.
      const background = block.box?.background ? color(block.box.background, ctx, 'accent') : '#ffffff';
      const s: ResolvedText = { ...base, face: { ...base.face, bold: true }, color: legible(ctx.theme.accent, background) };
      return { label: s, value: s };
    }
    default:
      return { label: { ...base, color: ctx.theme.muted }, value: base };
  }
}

function measurePayment(block: BlockOf<'payment'>, ctx: Ctx, width: number): Measured {
  const { bankLines, instructions } = ctx.data.payment;
  const lines = block.showBank === false ? [] : bankLines;
  const notes = block.showInstructions === false ? '' : (instructions ?? '');
  if (lines.length === 0 && !notes) return NOTHING;
  const body = textStyle(block.style, ctx);
  return stack(
    [
      labelPiece(block.label, ctx.data.labels.payment, ctx, body.align),
      { text: lines, style: body, gapBefore: 3 },
      { text: [notes], style: body, gapBefore: 4 },
    ],
    width,
  );
}

function measureLabeledText(
  block: BlockOf<'notes'> | BlockOf<'terms'>,
  text: string | null | undefined,
  defaultLabel: string,
  ctx: Ctx,
  width: number,
): Measured {
  if (!text?.trim()) return NOTHING;
  const body = textStyle(block.style, ctx);
  return stack([labelPiece(block.label, defaultLabel, ctx, body.align), { text: [text], style: body, gapBefore: 3 }], width);
}

const QR_SIZE = 84;

function measureLegal(block: BlockOf<'legal'> | null, ctx: Ctx, width: number): Measured {
  const legal = ctx.data.legal;
  const body = textStyle(block?.style, ctx, { size: ctx.theme.fontSize - 0.5 });
  const strong: ResolvedText = { ...body, face: { ...body.face, bold: true } };
  const muted: ResolvedText = { ...body, size: body.size - 0.5, color: ctx.theme.muted };
  const text = stack(
    [
      legal.fiscalDocument?.length ? { text: legal.fiscalDocument, style: body } : null,
      { text: legal.notices, style: strong, gapBefore: 6 },
      legal.requiredFooter ? { text: [legal.requiredFooter], style: muted, gapBefore: 6 } : null,
    ],
    width,
  );
  const pix = legal.pix;
  if (!pix) return text;
  const pixTextX = QR_SIZE + 12;
  const pixText = stack(
    [
      { text: [pix.title], style: { ...strong, size: body.size + 2 } },
      { text: [pix.key], style: body, gapBefore: 3 },
      { text: [pix.payload], style: { ...muted, size: 6.5 }, gapBefore: 3 },
    ],
    width - pixTextX,
  );
  const pixHeight = Math.max(QR_SIZE, pixText.height);
  const gap = text.empty ? 0 : 10;
  return {
    height: text.height + gap + pixHeight,
    paint: (x, y) => [
      ...text.paint(x, y, text.height),
      { kind: 'qr', x, y: y + text.height + gap, size: QR_SIZE, matrix: pix.matrix },
      ...pixText.paint(x + pixTextX, y + text.height + gap, pixText.height),
    ],
  };
}

function hasLegalContent(data: InvoiceDocumentData): boolean {
  const legal = data.legal;
  return legal.notices.length > 0 || !!legal.fiscalDocument?.length || !!legal.pix || !!legal.requiredFooter;
}

function measureBlock(block: TemplateBlock, ctx: Ctx, width: number, page: () => { page: number; total: number }): Measured {
  const { data } = ctx;
  switch (block.type) {
    case 'text': {
      const text = fillPlaceholders(block.text, data);
      return stack([{ text: [text], style: textStyle(block.style, ctx) }], width);
    }
    case 'field':
      return measureField(block, ctx, width);
    case 'logo': {
      const src = safeImageSrc(data.logoUrl);
      if (src) return { height: 0, fixed: true, paint: (x, y, h) => [{ kind: 'image', x, y, w: width, h, src, align: block.align ?? 'left' }] };
      const style = textStyle(block.fallbackStyle, ctx, { size: 16, face: { font: ctx.theme.font, bold: true }, align: block.align });
      return stack([{ text: [data.seller.name], style }], width);
    }
    case 'image': {
      const src = safeImageSrc(block.src);
      if (!src) return NOTHING;
      return { height: 0, fixed: true, paint: (x, y, h) => [{ kind: 'image', x, y, w: width, h, src, align: block.align ?? 'left' }] };
    }
    case 'seller':
      return measureParty(block, data.seller, data.labels.from, ctx, width);
    case 'billTo':
      return measureParty(block, data.billTo, data.labels.billTo, ctx, width);
    case 'shipTo':
      return measureParty(block, data.shipTo, data.labels.shipTo, ctx, width);
    case 'totals':
      return measureTotals(block, ctx, width);
    case 'payment':
      return measurePayment(block, ctx, width);
    case 'notes':
      return measureLabeledText(block, data.notes, data.labels.notes, ctx, width);
    case 'terms':
      return measureLabeledText(block, block.text ?? data.terms, data.labels.terms, ctx, width);
    case 'legal':
      return measureLegal(block, ctx, width);
    case 'rect':
      return { height: 0, fixed: true, paint: () => [] };
    case 'line':
      return {
        height: 0,
        fixed: true,
        paint: (x, y, h) => {
          const c = color(block.color, ctx, 'muted');
          const t = block.thickness ?? 1;
          return block.orientation === 'vertical'
            ? [{ kind: 'line', x1: x + width / 2, y1: y, x2: x + width / 2, y2: y + h, color: c, width: t }]
            : [{ kind: 'line', x1: x, y1: y + h / 2, x2: x + width, y2: y + h / 2, color: c, width: t }];
        },
      };
    case 'pageNumber': {
      const style = textStyle(block.style, ctx, { size: ctx.theme.fontSize - 1, colorToken: 'muted' });
      return {
        height: style.size * style.lineHeight,
        paint: (x, y) => {
          const { page: p, total } = page();
          const text = data.labels.page.replace('{page}', String(p)).replace('{total}', String(total));
          return setText(text, style, x, y, width).primitives;
        },
      };
    }
    case 'lineItems':
      // Laid out by `layoutTable`.
      return NOTHING;
  }
}

/** http(s) and inline PNG/JPEG only. */
export function safeImageSrc(value: string | null | undefined): string | null {
  const url = value?.trim();
  return url && /^(https?:\/\/|data:image\/(png|jpe?g);base64,)/i.test(url) ? url : null;
}

function boxPrimitives(box: BoxStyle | undefined, x: number, y: number, w: number, h: number, ctx: Ctx): Primitive[] {
  if (!box || (!box.background && !(box.borderWidth && box.borderColor))) return [];
  return [
    {
      kind: 'rect',
      x,
      y,
      w,
      h,
      fill: box.background ? color(box.background, ctx, 'accent') : undefined,
      stroke: box.borderWidth && box.borderColor ? color(box.borderColor, ctx, 'muted') : undefined,
      strokeWidth: box.borderWidth,
      radius: box.radius,
    },
  ];
}

// ---------------------------------------------------------------------------
// Line-items table
// ---------------------------------------------------------------------------

const DEFAULT_COLUMN_WIDTH: Record<LineItemColumnKey, number> = {
  index: 4,
  description: 40,
  hsnSac: 10,
  quantity: 8,
  unit: 8,
  unitPrice: 13,
  discount: 9,
  taxRate: 9,
  taxAmount: 12,
  amount: 14,
  amountWithTax: 14,
};

const NUMERIC_COLUMNS = new Set<LineItemColumnKey>(['quantity', 'unitPrice', 'discount', 'taxRate', 'taxAmount', 'amount', 'amountWithTax']);

interface TableColumn {
  key: LineItemColumnKey;
  label: string;
  align: Align;
  x: number;
  width: number;
}

/** The template's columns that the invoice has, plus those its jurisdiction requires. */
export function tableColumns(block: BlockOf<'lineItems'>, data: InvoiceDocumentData): TableColumn[] {
  const available = data.table.columns;
  const chosen = block.columns.filter((c) => available[c.key]);
  for (const [key, col] of Object.entries(available) as Array<[LineItemColumnKey, NonNullable<(typeof available)[LineItemColumnKey]>]>) {
    if (col.required && !chosen.some((c) => c.key === key)) chosen.push({ key, width: DEFAULT_COLUMN_WIDTH[key] });
  }
  const weights = chosen.map((c) => (c.width > 0 ? c.width : DEFAULT_COLUMN_WIDTH[c.key]));
  const sum = weights.reduce((a, b) => a + b, 0) || 1;
  let x = 0;
  return chosen.map((c, i) => {
    const width = (block.w * weights[i]) / sum;
    const col: TableColumn = {
      key: c.key,
      label: c.label ?? available[c.key]?.label ?? c.key,
      align: c.align ?? available[c.key]?.align ?? (NUMERIC_COLUMNS.has(c.key) ? 'right' : 'left'),
      x,
      width,
    };
    x += width;
    return col;
  });
}

interface TableRowLayout {
  height: number;
  paint: (x: number, y: number, index: number) => Primitive[];
}

function tableParts(block: BlockOf<'lineItems'>, ctx: Ctx) {
  const columns = tableColumns(block, ctx.data);
  const size = block.fontSize ?? ctx.theme.fontSize;
  const pad = block.rowPadding ?? 5;
  const cellPad = 4;
  const body: ResolvedText = { size, face: { font: ctx.theme.font }, color: ctx.theme.text, align: 'left', lineHeight: 1.3, uppercase: false };
  const sub: ResolvedText = { ...body, size: size - 1, color: ctx.theme.muted };
  const header = block.header ?? {};
  const headerStyle: ResolvedText = {
    ...body,
    size: header.fontSize ?? size - 1,
    face: { font: ctx.theme.font, bold: header.bold ?? true },
    color: color(header.color, ctx, header.background ? 'text' : 'muted'),
    uppercase: header.uppercase ?? true,
  };

  const headerLines = columns.map((c) =>
    wrapText(headerStyle.uppercase ? c.label.toUpperCase() : c.label, headerStyle.size, headerStyle.face, Math.max(1, c.width - 2 * cellPad)),
  );
  const headerHeight = Math.max(1, ...headerLines.map((l) => l.length)) * headerStyle.size * headerStyle.lineHeight + 2 * pad;
  const headerRow: TableRowLayout = {
    height: headerHeight,
    paint: (x, y) => {
      const out: Primitive[] = [];
      if (header.background) out.push({ kind: 'rect', x, y, w: block.w, h: headerHeight, fill: color(header.background, ctx, 'accent') });
      columns.forEach((c, i) => {
        out.push(...setLines(headerLines[i], { ...headerStyle, align: c.align }, x + c.x + cellPad, y + pad, c.width - 2 * cellPad).primitives);
      });
      const rule = header.rule ?? (header.background ? undefined : 'accent');
      if (rule) out.push({ kind: 'line', x1: x, y1: y + headerHeight, x2: x + block.w, y2: y + headerHeight, color: color(rule, ctx, 'accent'), width: 1 });
      return out;
    },
  };

  const rows: TableRowLayout[] = ctx.data.table.rows.map((row) => {
    const cells = columns.map((c) => {
      const lines = (row.cells[c.key] ?? '').split('\n').flatMap((part) => wrapText(part, size, body.face, Math.max(1, c.width - 2 * cellPad)));
      const subLines =
        c.key === 'description' && row.subLines?.length
          ? row.subLines.flatMap((s) => wrapText(s, sub.size, sub.face, Math.max(1, c.width - 2 * cellPad)))
          : [];
      return { lines, subLines, height: lines.length * size * body.lineHeight + subLines.length * sub.size * sub.lineHeight };
    });
    const height = Math.max(size * body.lineHeight, ...cells.map((c) => c.height)) + 2 * pad;
    return {
      height,
      paint: (x, y, index) => {
        const out: Primitive[] = [];
        if (block.zebra && index % 2 === 1) out.push({ kind: 'rect', x, y, w: block.w, h: height, fill: color(block.zebra, ctx, 'muted') });
        columns.forEach((c, i) => {
          const cell = cells[i];
          const set = setLines(cell.lines, { ...body, align: c.align }, x + c.x + cellPad, y + pad, c.width - 2 * cellPad);
          out.push(...set.primitives);
          if (cell.subLines.length) {
            out.push(...setLines(cell.subLines, { ...sub, align: c.align }, x + c.x + cellPad, y + pad + set.height, c.width - 2 * cellPad).primitives);
          }
        });
        const rule = block.rowRule ?? '#e2e4e8';
        out.push({ kind: 'line', x1: x, y1: y + height, x2: x + block.w, y2: y + height, color: color(rule, ctx, 'muted'), width: 0.5 });
        return out;
      },
    };
  });
  return { headerRow, rows };
}

// ---------------------------------------------------------------------------
// Page assembly
// ---------------------------------------------------------------------------

interface Placed {
  block: TemplateBlock;
  measured: Measured;
  page: number;
  y: number;
  h: number;
}

function overlapsHorizontally(a: { x: number; w: number }, b: { x: number; w: number }): boolean {
  return a.x < b.x + b.w - 0.5 && b.x < a.x + a.w - 0.5;
}

/**
 * Moves blocks down by the growth of the blocks above them. `items` are in
 * the same page coordinates; returns each item's top and height.
 */
function pushDown(items: FlowItem[]): void {
  const sorted = [...items].sort((a, b) => a.top - b.top || a.x - b.x);
  const designed = sorted.map((item) => ({ top: item.top, bottom: item.top + item.minH }));
  sorted.forEach((item, k) => {
    let shift = 0;
    for (let j = 0; j < k; j++) {
      const above = sorted[j];
      if (designed[j].bottom <= designed[k].top + 0.5 && overlapsHorizontally(above, item)) {
        shift = Math.max(shift, above.top + above.h - designed[j].bottom);
      }
    }
    item.top += shift;
  });
}

interface FlowItem {
  block: TemplateBlock;
  measured: Measured;
  x: number;
  w: number;
  /** Designed top on the way in, final top after `pushDown`. */
  top: number;
  /** The designed (minimum) height. */
  minH: number;
  h: number;
}

interface Band {
  /** Where continuation pages start. */
  top: number;
  /** Where the body stops on every page (above the footer band). */
  bottom: number;
}

/**
 * The body of a page: margins, and the header and footer bands repeating blocks keep free. Only blocks
 * above or under the table count: a side panel beside it, or a frame across the middle of the page, does not.
 */
function bodyBand(template: InvoiceTemplateDocument, repeating: TemplateBlock[], table: TemplateBlock): Band {
  const { height } = PAPER_SIZES[template.paperSize];
  const bands = repeating.filter((b) => overlapsHorizontally(b, table) && (b.y >= height / 2 || b.y + b.h <= height / 2));
  const inTopHalf = (b: TemplateBlock) => b.y + b.h / 2 < height / 2;
  return {
    top: Math.max(template.margins.top, ...bands.filter(inTopHalf).map((b) => b.y + b.h + 8)),
    bottom: Math.min(height - template.margins.bottom, ...bands.filter((b) => !inTopHalf(b)).map((b) => b.y - 8)),
  };
}

/** Totals and legal content are never dropped: blocks for them under the last one when a template has none. */
function implicitBlocks(flowing: TemplateBlock[], table: BlockOf<'lineItems'>, data: InvoiceDocumentData): TemplateBlock[] {
  const extra: TemplateBlock[] = [];
  const tableBottom = table.y + table.h;
  const lastBottom = () => Math.max(tableBottom, ...[...flowing, ...extra].filter((b) => b.y >= tableBottom).map((b) => b.y + b.h));
  if (!flowing.some((b) => b.type === 'totals')) {
    const w = Math.min(220, table.w);
    extra.push({ id: '__totals', type: 'totals', x: table.x + table.w - w, y: lastBottom() + 14, w, h: 20 });
  }
  if (!flowing.some((b) => b.type === 'legal') && hasLegalContent(data)) {
    extra.push({ id: '__legal', type: 'legal', x: table.x, y: lastBottom() + 14, w: table.w, h: 10 });
  }
  return extra;
}

/** Pages that grow on demand. */
function pageList() {
  const pages: LayoutPage[] = [{ primitives: [] }];
  return {
    pages,
    on(n: number): Primitive[] {
      while (pages.length <= n) pages.push({ primitives: [] });
      return pages[n].primitives;
    },
  };
}

interface PagePoint {
  page: number;
  y: number;
}

/** Paints the table from `top`, breaking pages and repeating its header; returns where it started and ended. */
function paintTable(
  table: BlockOf<'lineItems'>,
  ctx: Ctx,
  top: number,
  band: Band,
  on: (page: number) => Primitive[],
): { start: PagePoint; end: PagePoint } {
  const { headerRow, rows } = tableParts(table, ctx);
  // When not even the header and one row fit, the table starts on the next page.
  const start = top + headerRow.height + (rows[0]?.height ?? 0) > band.bottom ? { page: 1, y: band.top } : { page: 0, y: top };
  let { page, y } = start;
  const header = () => {
    on(page).push(...headerRow.paint(table.x, y, 0));
    y += headerRow.height;
  };
  header();
  rows.forEach((row, i) => {
    if (y + row.height > band.bottom && y > band.top + headerRow.height + 0.5) {
      page += 1;
      y = band.top;
      header();
    }
    on(page).push(...row.paint(table.x, y, i));
    y += row.height;
  });
  return { start, end: { page, y } };
}

/** Rows of blocks under the table, moved to a new page together when they no longer fit. */
function placeFollowing(after: FlowItem[], firstPage: number, band: Band): { placed: Placed[]; lastPage: number } {
  const placed: Placed[] = [];
  let pageShift = 0;
  let page = firstPage;
  for (const row of groupRows(after)) {
    const top = Math.min(...row.map((r) => r.top)) + pageShift;
    const bottom = Math.max(...row.map((r) => r.top + r.h)) + pageShift;
    if (bottom > band.bottom && top > band.top + 0.5) {
      page += 1;
      pageShift += band.top - top;
    }
    for (const r of row) placed.push({ block: r.block, measured: r.measured, page, y: r.top + pageShift, h: r.h });
  }
  return { placed, lastPage: page };
}

function placementOf(p: Placed): BlockPlacement {
  return {
    id: p.block.id,
    page: p.page,
    x: p.block.x,
    y: p.y,
    w: p.block.w,
    h: p.h,
    grew: p.h > p.block.h + 0.5,
    moved: p.page !== 0 || Math.abs(p.y - p.block.y) > 0.5,
  };
}

/** A draft's watermark on every page and its banner on the first. */
function markDraft(pages: LayoutPage[], draft: NonNullable<InvoiceDocumentData['draft']>, ctx: Ctx, width: number) {
  const face = { font: ctx.theme.font, bold: true };
  pages.forEach((pg, i) => {
    pg.primitives.push({ kind: 'watermark', text: draft.watermark, size: 80, color: '#c0392b', face });
    if (i === 0) {
      const style: ResolvedText = { size: 8, face, color: '#c0392b', align: 'center', lineHeight: 1.3, uppercase: true };
      pg.primitives.push(...setText(draft.banner, style, 24, 10, width - 48).primitives);
    }
  });
}

export function layoutInvoice(template: InvoiceTemplateDocument, data: InvoiceDocumentData): InvoiceLayout {
  const size = PAPER_SIZES[template.paperSize];
  const ctx: Ctx = { theme: template.theme, data };
  // The line items always print, even from a template stored with the table hidden.
  const visible = template.blocks.filter((b) => !b.hidden || b.type === 'lineItems');
  const table = visible.find((b): b is BlockOf<'lineItems'> => b.type === 'lineItems');
  if (!table) throw new Error('Invoice template has no line-items table');

  let currentPage = { page: 1, total: 1 };
  const pageInfo = () => currentPage;
  const repeating = visible.filter((b) => b.everyPage && b.type !== 'lineItems');
  const band = bodyBand(template, repeating, table);
  const flowing = visible.filter((b) => !b.everyPage && b.type !== 'lineItems');
  const blocks = [...flowing, ...implicitBlocks(flowing, table, data)];
  const tableBottom = table.y + table.h;
  const { pages, on } = pageList();
  const placements: BlockPlacement[] = [];

  const measureAll = (list: TemplateBlock[]): FlowItem[] =>
    list.map((block) => {
      const pad = block.box?.padding ?? 0;
      const measured = measureBlock(block, ctx, Math.max(1, block.w - 2 * pad), pageInfo);
      // An empty block (no ship-to address, no notes) keeps its designed size: its padding has nothing to wrap.
      let contentH = measured.height + 2 * pad;
      if (measured.fixed) contentH = block.h;
      else if (measured.empty) contentH = 0;
      return { block, measured, x: block.x, w: block.w, top: block.y, minH: block.h, h: Math.max(block.h, contentH) };
    });

  // 1. Blocks above (or beside) the table, on the first page; they can push the table down.
  const before = measureAll(blocks.filter((b) => b.y < tableBottom));
  const after = measureAll(blocks.filter((b) => b.y >= tableBottom));
  const tableItem: FlowItem = { block: table, measured: NOTHING, x: table.x, w: table.w, top: table.y, minH: table.h, h: table.h };
  pushDown([...before, tableItem]);

  // 2. The table, split over pages. On a single page it keeps at least its designed height.
  const { start, end } = paintTable(table, ctx, tableItem.top, band, on);
  const onePage = start.page === end.page;
  const designedEnd = onePage ? Math.max(end.y, tableItem.top + table.h) : end.y;
  placements.push({
    id: table.id,
    page: start.page,
    x: table.x,
    y: start.y,
    w: table.w,
    h: onePage ? designedEnd - start.y : band.bottom - start.y,
    grew: !onePage || end.y > tableItem.top + table.h + 0.5,
    moved: start.page !== 0 || Math.abs(start.y - table.y) > 0.5,
  });

  // 3. Blocks below the table follow it, keeping their distance to it.
  for (const item of after) item.top = designedEnd + (item.block.y - tableBottom);
  pushDown(after);
  const following = placeFollowing(after, end.page, band);
  const placed: Placed[] = [...before.map((b) => ({ block: b.block, measured: b.measured, page: 0, y: b.top, h: b.h })), ...following.placed];
  const pageCount = Math.max(following.lastPage, end.page) + 1;
  on(pageCount - 1);

  // 4. Paint flowing blocks, then the repeating ones on every page, underneath the rest (a letterhead band behind the title).
  for (const p of placed) {
    currentPage = { page: p.page + 1, total: pageCount };
    on(p.page).push(...paintBlock(p.block, p.measured, p.block.x, p.y, p.h, ctx));
    if (!p.block.id.startsWith('__')) placements.push(placementOf(p));
  }
  const repeatingMeasured = measureAll(repeating);
  pages.forEach((pg, i) => {
    currentPage = { page: i + 1, total: pageCount };
    pg.primitives.unshift(...repeatingMeasured.flatMap((r) => paintBlock(r.block, r.measured, r.block.x, r.block.y, r.h, ctx)));
  });
  for (const r of repeatingMeasured) {
    placements.push({ id: r.block.id, page: 0, x: r.block.x, y: r.block.y, w: r.block.w, h: r.h, grew: r.h > r.block.h + 0.5, moved: false });
  }

  if (data.draft) markDraft(pages, data.draft, ctx, size.width);
  return { width: size.width, height: size.height, pages, placements };
}

/** Blocks whose tops are within a few points of each other move between pages together. */
function groupRows<T extends { top: number; h: number }>(items: T[]): T[][] {
  const sorted = [...items].sort((a, b) => a.top - b.top);
  const rows: T[][] = [];
  for (const item of sorted) {
    const row = rows[rows.length - 1];
    if (row && Math.abs(item.top - row[0].top) <= 4) row.push(item);
    else rows.push([item]);
  }
  return rows;
}

function paintBlock(block: TemplateBlock, measured: Measured, x: number, y: number, h: number, ctx: Ctx): Primitive[] {
  if (measured.empty) return [];
  const pad = block.box?.padding ?? 0;
  const out = boxPrimitives(block.box, x, y, block.w, h, ctx);
  if (block.type === 'rect' && out.length === 0) {
    out.push({ kind: 'rect', x, y, w: block.w, h, fill: ctx.theme.accent });
  }
  out.push(...measured.paint(x + pad, y + pad, h - 2 * pad));
  return out;
}
