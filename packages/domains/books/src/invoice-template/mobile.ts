/**
 * Mobile layout: the same invoice and template as the A4 page, as one column
 * that reads well on a phone. Nothing is designed twice: it takes the
 * template's theme (font, colours, sizes), its blocks in reading order and
 * their settings, and the same data the page prints. Decoration that only
 * makes sense on paper (rectangles, lines, page numbers) is left out, line
 * items become stacked rows, and labels sit next to their values.
 *
 * Plain HTML with its styles scoped under `.wim`, so it can be placed inside
 * another page: the printable invoice HTML shows it on narrow screens, and the
 * designer previews it in a phone frame.
 */
import type { InvoiceDocumentData, PartyData, TotalsRowData } from './data';
import { fieldValue, fillPlaceholders, safeImageSrc, tableColumns } from './layout';
import { PAPER_SIZES, type BlockOf, type BoxStyle, type InvoiceTemplateDocument, type LabelStyle, type TemplateBlock, type TemplateColor, type TemplateTheme, type TextStyle } from './schema';
import { fontStack } from './svg';

interface Ctx {
  theme: TemplateTheme;
  data: InvoiceDocumentData;
  /** Adds `data-block-id` to each section, so the designer can select by clicking. */
  blockIds: boolean;
}

/** Body text on a phone, in CSS pixels; the template's other sizes scale from here. */
const BODY_PX = 15;

function esc(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

/** Escaped text with its line breaks kept. */
function text(value: string): string {
  return esc(value).replaceAll('\n', '<br>');
}

function hex(value: string): string {
  return /^#[0-9a-fA-F]{6}$/.test(value) ? value : '#000000';
}

function color(value: TemplateColor | undefined, ctx: Ctx, fallback: TemplateColor): string {
  const v = value ?? fallback;
  if (v === 'accent') return hex(ctx.theme.accent);
  if (v === 'text') return hex(ctx.theme.text);
  if (v === 'muted') return hex(ctx.theme.muted);
  return hex(v);
}

/**
 * A template size (points, tuned for A4) as phone pixels. Sizes keep their
 * order but grow less than linearly, so a 26pt title does not fill the screen
 * while 9pt body text stays readable.
 */
function px(size: number, ctx: Ctx): number {
  const ratio = size / ctx.theme.fontSize;
  return Math.round(BODY_PX * ratio ** 0.6 * 10) / 10;
}

function textCss(style: TextStyle | undefined, ctx: Ctx, defaults: { size?: number; bold?: boolean; color?: TemplateColor; align?: string } = {}): string {
  const size = style?.fontSize ?? defaults.size ?? ctx.theme.fontSize;
  const parts = [`font-size:${px(size, ctx)}px`, `color:${color(style?.color, ctx, defaults.color ?? 'text')}`];
  const bold = style?.bold ?? defaults.bold;
  if (bold) parts.push('font-weight:700');
  if (style?.italic) parts.push('font-style:italic');
  const align = style?.align ?? defaults.align;
  if (align && align !== 'left') parts.push(`text-align:${align}`);
  if (style?.uppercase) parts.push('text-transform:uppercase');
  if (style?.lineHeight) parts.push(`line-height:${style.lineHeight}`);
  return parts.join(';');
}

function labelHtml(label: LabelStyle | undefined, fallback: string, ctx: Ctx): string {
  if (label?.show === false) return '';
  const value = label?.text ?? fallback;
  if (!value) return '';
  const css = [
    `color:${color(label?.color, ctx, 'muted')}`,
    label?.bold === false ? 'font-weight:400' : '',
    label?.uppercase === false ? 'text-transform:none;letter-spacing:0' : '',
  ]
    .filter(Boolean)
    .join(';');
  return `<div class="wim-label" style="${css}">${text(value)}</div>`;
}

function boxCss(box: BoxStyle | undefined, ctx: Ctx): string {
  if (!box) return '';
  const parts: string[] = [];
  if (box.background) parts.push(`background:${color(box.background, ctx, 'accent')}`);
  if (box.borderWidth && box.borderColor) parts.push(`border:${Math.min(box.borderWidth, 3)}px solid ${color(box.borderColor, ctx, 'muted')}`);
  if (box.radius) parts.push(`border-radius:${Math.min(box.radius, 16)}px`);
  if (parts.length > 0) parts.push(`padding:${Math.max(10, Math.round((box.padding ?? 8) * 1.4))}px`);
  return parts.join(';');
}

function section(block: TemplateBlock, inner: string, ctx: Ctx, cls = ''): string {
  if (!inner) return '';
  const attr = ctx.blockIds ? ` data-block-id="${esc(block.id)}"` : '';
  const style = boxCss(block.box, ctx);
  return `<section class="wim-section${cls ? ` ${cls}` : ''}"${attr}${style ? ` style="${style}"` : ''}>${inner}</section>`;
}

// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------

function partyHtml(block: BlockOf<'seller'> | BlockOf<'billTo'> | BlockOf<'shipTo'>, party: PartyData | null | undefined, label: string, ctx: Ctx): string {
  if (!party || (!party.name && party.lines.length === 0)) return '';
  const showContact = block.type === 'seller' ? block.showContact !== false : block.type === 'billTo' ? block.showEmail !== false : false;
  const showTaxIds = block.type === 'seller' ? block.showTaxIds !== false : true;
  const body = textCss(block.style, ctx);
  const lines = [...party.lines, ...(showContact ? (party.contactLines ?? []) : []), ...(showTaxIds ? (party.taxIdLines ?? []) : [])].filter(Boolean);
  const name = party.name ? `<div class="wim-name"${block.boldName === false ? ' style="font-weight:400"' : ''}>${text(party.name)}</div>` : '';
  return `${labelHtml(block.label, label, ctx)}<div style="${body}">${name}${lines.map((l) => `<div>${text(l)}</div>`).join('')}</div>`;
}

/** A field as a label / value row; a field without a label (the title) as a heading-like value. */
function fieldHtml(block: BlockOf<'field'>, ctx: Ctx): { row?: string; standalone?: string } {
  const value = fieldValue(ctx.data, block.field);
  if (!value) return {};
  const label = block.label?.text ?? ctx.data.fieldLabels[block.field] ?? '';
  const valueOnly = block.layout === 'value' || block.label?.show === false || !label;
  if (valueOnly) return { standalone: `<div style="${textCss(block.style, ctx)}">${text(value)}</div>` };
  const labelStyle = `color:${color(block.label?.color, ctx, 'muted')}`;
  const valueStyle = textCss({ ...block.style, align: undefined }, ctx);
  return { row: `<div class="wim-kv"><span style="${labelStyle}">${text(label)}</span><span style="${valueStyle}">${text(value)}</span></div>` };
}

function logoHtml(block: BlockOf<'logo'>, ctx: Ctx): string {
  const align = block.align ?? 'left';
  const src = safeImageSrc(ctx.data.logoUrl);
  if (src) return `<div class="wim-logo" style="text-align:${align}"><img src="${esc(src)}" alt="${esc(ctx.data.seller.name)}"></div>`;
  if (!ctx.data.seller.name) return '';
  return `<div style="${textCss(block.fallbackStyle, ctx, { size: 16, bold: true, align })}">${text(ctx.data.seller.name)}</div>`;
}

function imageHtml(block: BlockOf<'image'>): string {
  const src = safeImageSrc(block.src);
  return src ? `<div class="wim-image" style="text-align:${block.align ?? 'left'}"><img src="${esc(src)}" alt=""></div>` : '';
}

function itemsHtml(block: BlockOf<'lineItems'>, ctx: Ctx): string {
  const columns = tableColumns(block, ctx.data);
  const amountColumn = [...columns].reverse().find((c) => c.key === 'amountWithTax' || c.key === 'amount');
  const detailColumns = columns.filter((c) => c.key !== 'description' && c.key !== 'index' && c !== amountColumn);
  const rule = color(block.header?.rule, ctx, 'accent');
  const rowRule = color(block.rowRule, ctx, 'muted');
  const rows = ctx.data.table.rows.map((row, i) => {
    const description = row.cells.description ?? '';
    const amount = amountColumn ? (row.cells[amountColumn.key] ?? '') : '';
    const details = detailColumns
      .map((c) => {
        const value = row.cells[c.key];
        return value ? `${text(c.label)} ${text(value)}` : '';
      })
      .filter(Boolean)
      .join(' · ');
    const sub = (row.subLines ?? []).map((l) => `<div class="wim-muted">${text(l)}</div>`).join('');
    const zebra = block.zebra && i % 2 === 1 ? ` style="background:${color(block.zebra, ctx, 'muted')}"` : '';
    return `<div class="wim-item"${zebra}><div class="wim-item-top"><div class="wim-item-desc">${text(description)}</div>${
      amount ? `<div class="wim-item-amount">${text(amount)}</div>` : ''
    }</div>${sub}${details ? `<div class="wim-muted">${details}</div>` : ''}</div>`;
  });
  if (rows.length === 0) return '';
  return `<div class="wim-items" style="border-top:2px solid ${rule};--wim-row-rule:${rowRule}33">${rows.join('')}</div>`;
}

function totalsRowHtml(row: TotalsRowData, block: BlockOf<'totals'>, ctx: Ctx): string {
  const value = row.value ? `<span>${text(row.value)}</span>` : '<span></span>';
  switch (row.kind) {
    case 'heading':
      return `<div class="wim-kv wim-totals-heading" style="color:${hex(ctx.theme.muted)}"><span>${text(row.label)}</span>${value}</div>`;
    case 'muted':
      return `<div class="wim-kv wim-small" style="color:${hex(ctx.theme.muted)}"><span>${text(row.label)}</span>${value}</div>`;
    case 'total': {
      const size = px(block.total?.fontSize ?? (block.style?.fontSize ?? ctx.theme.fontSize) + 2, ctx);
      const bg = block.total?.background ? `background:${color(block.total.background, ctx, 'accent')};padding:10px 12px;border-radius:6px;` : '';
      return `<div class="wim-kv wim-total" style="${bg}border-top:2px solid ${color(block.total?.rule, ctx, 'accent')};font-size:${size}px;color:${color(block.total?.color, ctx, 'text')}"><span>${text(row.label)}</span>${value}</div>`;
    }
    case 'balance':
      return `<div class="wim-kv" style="font-weight:700;color:${hex(ctx.theme.accent)}"><span>${text(row.label)}</span>${value}</div>`;
    default:
      return `<div class="wim-kv"><span style="color:${hex(ctx.theme.muted)}">${text(row.label)}</span>${value}</div>`;
  }
}

function totalsHtml(block: BlockOf<'totals'>, ctx: Ctx): string {
  const rows = block.showBalance === false ? ctx.data.totals.filter((r) => r.kind !== 'balance') : ctx.data.totals;
  if (rows.length === 0) return '';
  return `<div class="wim-totals" style="${textCss({ ...block.style, align: undefined }, ctx)}">${rows.map((r) => totalsRowHtml(r, block, ctx)).join('')}</div>`;
}

function paymentHtml(block: BlockOf<'payment'>, ctx: Ctx): string {
  const lines = block.showBank === false ? [] : ctx.data.payment.bankLines;
  const notes = block.showInstructions === false ? '' : (ctx.data.payment.instructions ?? '');
  if (lines.length === 0 && !notes) return '';
  return `${labelHtml(block.label, ctx.data.labels.payment, ctx)}<div style="${textCss(block.style, ctx)}">${lines.map((l) => `<div>${text(l)}</div>`).join('')}${
    notes ? `<p>${text(notes)}</p>` : ''
  }</div>`;
}

function labeledTextHtml(block: BlockOf<'notes'> | BlockOf<'terms'>, value: string | null | undefined, label: string, ctx: Ctx): string {
  if (!value?.trim()) return '';
  return `${labelHtml(block.label, label, ctx)}<div style="${textCss(block.style, ctx)}">${text(value)}</div>`;
}

function qrSvg(matrix: boolean[][]): string {
  const n = Math.max(1, matrix.length);
  let d = '';
  matrix.forEach((row, r) =>
    row.forEach((dark, c) => {
      if (dark) d += `M${c} ${r}h1v1h-1z`;
    }),
  );
  return `<svg class="wim-qr" viewBox="0 0 ${n} ${n}" xmlns="http://www.w3.org/2000/svg"><rect width="${n}" height="${n}" fill="#fff"/><path d="${d}" fill="#000" shape-rendering="crispEdges"/></svg>`;
}

function legalHtml(block: BlockOf<'legal'> | null, ctx: Ctx): string {
  const legal = ctx.data.legal;
  const muted = `color:${hex(ctx.theme.muted)}`;
  const parts = [
    legal.fiscalDocument?.length ? `<div>${legal.fiscalDocument.map(text).join('<br>')}</div>` : '',
    legal.notices.length > 0 ? `<div style="font-weight:700">${legal.notices.map(text).join('<br>')}</div>` : '',
    legal.pix
      ? `<div class="wim-pix">${qrSvg(legal.pix.matrix)}<div><div style="font-weight:700">${text(legal.pix.title)}</div><div>${text(legal.pix.key)}</div><div class="wim-small wim-break" style="${muted}">${text(legal.pix.payload)}</div></div></div>`
      : '',
    legal.requiredFooter ? `<div class="wim-small" style="${muted}">${text(legal.requiredFooter)}</div>` : '',
  ].filter(Boolean);
  if (parts.length === 0) return '';
  return `<div class="wim-legal" style="${textCss(block?.style, ctx, { size: ctx.theme.fontSize - 0.5 })}">${parts.join('')}</div>`;
}

function textBlockHtml(block: BlockOf<'text'>, ctx: Ctx): string {
  const value = fillPlaceholders(block.text, ctx.data).trim();
  return value ? `<div style="${textCss(block.style, ctx)}">${text(value)}</div>` : '';
}

// ---------------------------------------------------------------------------
// Reading order
// ---------------------------------------------------------------------------

/** The totals a template without a totals block prints anyway, in the theme's default style. */
const IMPLICIT_TOTALS: BlockOf<'totals'> = { id: '__totals', type: 'totals', x: 0, y: 0, w: 1, h: 1 };

/** Paper-only blocks that do not carry over to a phone. */
const PAPER_ONLY = new Set<TemplateBlock['type']>(['rect', 'line', 'pageNumber']);

/**
 * Blocks top to bottom as a reader would meet them: blocks that sit side by
 * side (overlapping vertically) form a row and read left to right.
 */
export function readingOrder(blocks: TemplateBlock[], keep: (b: TemplateBlock) => boolean = (b) => !PAPER_ONLY.has(b.type)): TemplateBlock[] {
  const sorted = blocks.filter((b) => !b.hidden && keep(b)).sort((a, b) => a.y - b.y || a.x - b.x);
  const rows: Array<{ top: number; bottom: number; items: TemplateBlock[] }> = [];
  for (const block of sorted) {
    const row = rows[rows.length - 1];
    // Same row when the block starts above the middle of the row's first block.
    if (row && block.y < row.top + Math.max(8, (row.items[0].h || 0) / 2)) {
      row.items.push(block);
      row.bottom = Math.max(row.bottom, block.y + block.h);
    } else {
      rows.push({ top: block.y, bottom: block.y + block.h, items: [block] });
    }
  }
  return rows.flatMap((r) => r.items.sort((a, b) => a.x - b.x));
}

/** A filled rectangle with the blocks drawn on top of it: on a phone, a coloured band around them. */
interface Band {
  rect: BlockOf<'rect'>;
  members: TemplateBlock[];
}

/**
 * Filled rectangles and what sits on them. Without its rectangle, white text
 * on a coloured header band would be white on white, so the band comes along.
 */
function findBands(blocks: TemplateBlock[]): Band[] {
  const rects = blocks.filter((b): b is BlockOf<'rect'> => b.type === 'rect' && !b.hidden && !!b.box?.background);
  return rects
    .map((rect) => ({
      rect,
      members: blocks.filter((b) => {
        if (b === rect || b.hidden || PAPER_ONLY.has(b.type) || b.type === 'lineItems') return false;
        const cx = b.x + b.w / 2;
        const cy = b.y + b.h / 2;
        return cx >= rect.x && cx <= rect.x + rect.w && cy >= rect.y && cy <= rect.y + rect.h;
      }),
    }))
    .filter((band) => band.members.length > 0);
}

/** Sections for blocks in reading order; consecutive label/value fields share one list. */
function renderBlocks(order: TemplateBlock[], bands: Map<string, Band>, ctx: Ctx, page: { width: number }, hasTotals: boolean): string[] {
  const out: string[] = [];
  let fieldRows: string[] = [];
  let fieldIds: string[] = [];
  const flushFields = () => {
    if (fieldRows.length === 0) return;
    const attr = ctx.blockIds ? ` data-block-ids="${esc(fieldIds.join(' '))}"` : '';
    out.push(`<section class="wim-section wim-fields"${attr}>${fieldRows.join('')}</section>`);
    fieldRows = [];
    fieldIds = [];
  };

  for (const block of order) {
    if (block.type === 'field') {
      const { row, standalone } = fieldHtml(block, ctx);
      if (row) {
        // A field row carries its own id so a click selects that field.
        fieldRows.push(ctx.blockIds ? row.replace('<div class="wim-kv"', `<div class="wim-kv" data-block-id="${esc(block.id)}"`) : row);
        fieldIds.push(block.id);
        continue;
      }
      flushFields();
      if (standalone) out.push(section(block, standalone, ctx));
      continue;
    }
    flushFields();
    switch (block.type) {
      case 'rect': {
        const band = bands.get(block.id);
        if (!band) break;
        const inner = renderBlocks(readingOrder(band.members), bands, ctx, page, true).join('');
        if (!inner) break;
        // A band across the page runs edge to edge on the phone too; one at the top meets the top.
        const fullWidth = block.x <= 8 && block.x + block.w >= page.width - 8;
        const classes = ['wim-section', 'wim-band', fullWidth ? 'wim-bleed' : '', fullWidth && block.y <= 8 ? 'wim-bleed-top' : ''].filter(Boolean).join(' ');
        const attr = ctx.blockIds ? ` data-block-id="${esc(block.id)}"` : '';
        // Only the colour carries over: the band's padding and corners suit a phone, not the page's.
        out.push(`<section class="${classes}"${attr} style="background:${color(block.box?.background, ctx, 'accent')}">${inner}</section>`);
        break;
      }
      case 'text':
        out.push(section(block, textBlockHtml(block, ctx), ctx));
        break;
      case 'logo':
        out.push(section(block, logoHtml(block, ctx), ctx));
        break;
      case 'image':
        out.push(section(block, imageHtml(block), ctx));
        break;
      case 'seller':
        out.push(section(block, partyHtml(block, ctx.data.seller, ctx.data.labels.from, ctx), ctx));
        break;
      case 'billTo':
        out.push(section(block, partyHtml(block, ctx.data.billTo, ctx.data.labels.billTo, ctx), ctx));
        break;
      case 'shipTo':
        out.push(section(block, partyHtml(block, ctx.data.shipTo, ctx.data.labels.shipTo, ctx), ctx));
        break;
      case 'lineItems':
        out.push(section(block, itemsHtml(block, ctx), ctx, 'wim-section-items'));
        // A template without a totals block still shows the totals right under the items, as the page does.
        if (!hasTotals) out.push(`<section class="wim-section">${totalsHtml(IMPLICIT_TOTALS, ctx)}</section>`);
        break;
      case 'totals':
        out.push(section(block, totalsHtml(block, ctx), ctx));
        break;
      case 'payment':
        out.push(section(block, paymentHtml(block, ctx), ctx));
        break;
      case 'notes':
        out.push(section(block, labeledTextHtml(block, ctx.data.notes, ctx.data.labels.notes, ctx), ctx));
        break;
      case 'terms':
        out.push(section(block, labeledTextHtml(block, block.text ?? ctx.data.terms, ctx.data.labels.terms, ctx), ctx));
        break;
      case 'legal':
        out.push(section(block, legalHtml(block, ctx), ctx));
        break;
      default:
        break;
    }
  }
  flushFields();
  return out.filter(Boolean);
}

/**
 * Each field once: a value the page prints twice (the invoice number under the title and again in the
 * running footer) shows where it first appears, preferring a block that is not repeated on every page.
 */
function withoutRepeatedFields(blocks: TemplateBlock[]): TemplateBlock[] {
  const rank = (b: TemplateBlock) => (b.everyPage ? 1_000_000 : 0) + b.y * 1000 + b.x;
  const shown = new Map<string, TemplateBlock>();
  for (const b of blocks) {
    if (b.type !== 'field' || b.hidden) continue;
    const current = shown.get(b.field);
    if (!current || rank(b) < rank(current)) shown.set(b.field, b);
  }
  return blocks.filter((b) => b.type !== 'field' || b.hidden || shown.get(b.field) === b);
}

/** The mobile layout's sections, in order. */
function sections(template: InvoiceTemplateDocument, ctx: Ctx): string[] {
  const blocks = withoutRepeatedFields(template.blocks);
  const bands = findBands(blocks);
  const inBand = new Set(bands.flatMap((b) => b.members.map((m) => m.id)));
  const bandIds = new Set(bands.map((b) => b.rect.id));
  // Blocks on a band read inside it; the band itself takes their place in the order.
  const order = readingOrder(blocks, (b) => !inBand.has(b.id) && (bandIds.has(b.id) || !PAPER_ONLY.has(b.type)));
  const visible = blocks.filter((b) => !b.hidden);
  const hasTotals = visible.some((b) => b.type === 'totals');
  const hasLegal = visible.some((b) => b.type === 'legal');
  const out = renderBlocks(order, new Map(bands.map((b) => [b.rect.id, b])), ctx, PAPER_SIZES[template.paperSize], hasTotals);
  if (!hasLegal) {
    const legal = legalHtml(null, ctx);
    if (legal) out.push(`<section class="wim-section">${legal}</section>`);
  }
  return out;
}

function styles(theme: TemplateTheme): string {
  const muted = hex(theme.muted);
  return `<style>
.wim{box-sizing:border-box;font-family:${fontStack(theme.font)};font-size:${BODY_PX}px;line-height:1.45;color:${hex(theme.text)};background:#fff;padding:20px 18px 28px;-webkit-text-size-adjust:100%;overflow-wrap:anywhere}
.wim *{box-sizing:border-box}
.wim p{margin:6px 0 0}
.wim img{max-width:100%;height:auto;display:inline-block}
.wim-section{margin:0 0 18px}
.wim-section:last-child{margin-bottom:0}
.wim-label{font-size:12px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;margin:0 0 4px}
.wim-name{font-weight:700}
.wim-logo img{max-height:56px}
.wim-image img{max-height:140px}
.wim-kv{display:flex;justify-content:space-between;align-items:baseline;gap:16px;padding:3px 0}
.wim-kv>span:last-child{text-align:right;font-variant-numeric:tabular-nums}
.wim-fields{border-top:1px solid ${muted}33;border-bottom:1px solid ${muted}33;padding:8px 0}
.wim-items{margin:0}
.wim-item{padding:12px 0;border-bottom:1px solid var(--wim-row-rule)}
.wim-item-top{display:flex;justify-content:space-between;align-items:baseline;gap:16px}
.wim-item-desc{font-weight:600;min-width:0}
.wim-item-amount{font-weight:600;white-space:nowrap;font-variant-numeric:tabular-nums}
.wim-muted{color:${muted};font-size:13px;margin-top:2px}
.wim-small{font-size:13px}
.wim-break{word-break:break-all}
.wim-totals .wim-kv{padding:4px 0}
.wim-totals-heading{font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;padding-top:10px}
.wim-total{font-weight:700;margin-top:6px;padding-top:10px}
.wim-legal>div+div{margin-top:8px}
.wim-pix{display:flex;gap:12px;align-items:flex-start}
.wim-qr{width:96px;height:96px;flex:none}
.wim-band{padding:18px;border-radius:10px}
.wim-band .wim-section{margin-bottom:10px}
.wim-band .wim-section:last-child{margin-bottom:0}
.wim-bleed{margin-left:-18px;margin-right:-18px;border-radius:0;padding:22px 18px}
.wim-bleed-top{margin-top:-20px}
.wim-draft{background:#fef3c7;color:#92400e;font-size:13px;font-weight:700;padding:8px 12px;border-radius:6px;margin:0 0 16px}
</style>`;
}

/**
 * The invoice as a single-column layout for phones, styled by the template.
 * `blockIds` marks each section with the block it came from (designer only).
 */
export function renderMobileInvoice(template: InvoiceTemplateDocument, data: InvoiceDocumentData, opts: { blockIds?: boolean } = {}): string {
  const ctx: Ctx = { theme: template.theme, data, blockIds: opts.blockIds ?? false };
  const draft = data.draft ? `<div class="wim-draft">${text(data.draft.banner)}</div>` : '';
  return `${styles(template.theme)}<div class="wim">${draft}${sections(template, ctx).join('')}</div>`;
}
