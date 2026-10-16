/**
 * Built-in starting points of the designer. "Classic" mirrors the fixed layout
 * invoices had before templates existed.
 */
import {
  INVOICE_TEMPLATE_VERSION,
  PAPER_SIZES,
  type InvoiceTemplateDocument,
  type LineItemColumn,
  type PaperSize,
  type TemplateBlock,
  type TemplateTheme,
} from './schema';

export const TEMPLATE_PRESETS = ['classic', 'modern', 'minimal'] as const;
export type TemplatePreset = (typeof TEMPLATE_PRESETS)[number];

const DEFAULT_THEME: TemplateTheme = {
  font: 'helvetica',
  accent: '#3b61de',
  text: '#1a1a1f',
  muted: '#737885',
  fontSize: 9,
};

export const DEFAULT_COLUMNS: LineItemColumn[] = [
  { key: 'description', width: 46 },
  { key: 'quantity', width: 9 },
  { key: 'unitPrice', width: 15 },
  { key: 'taxRate', width: 10 },
  { key: 'amount', width: 15 },
];

function doc(paperSize: PaperSize, theme: Partial<TemplateTheme>, blocks: TemplateBlock[]): InvoiceTemplateDocument {
  return {
    version: INVOICE_TEMPLATE_VERSION,
    paperSize,
    margins: { top: 48, bottom: 56 },
    theme: { ...DEFAULT_THEME, ...theme },
    blocks,
  };
}

function classic(paperSize: PaperSize, accent?: string): InvoiceTemplateDocument {
  const { width: W, height: H } = PAPER_SIZES[paperSize];
  const M = 48;
  const right = W - M;
  return doc(paperSize, accent ? { accent } : {}, [
    { id: 'logo', type: 'logo', x: M, y: 44, w: 160, h: 48 },
    { id: 'title', type: 'field', field: 'title', layout: 'value', x: right - 240, y: 44, w: 240, h: 30, style: { fontSize: 22, bold: true, color: 'accent', align: 'right', uppercase: true } },
    { id: 'number', type: 'field', field: 'invoiceNumber', layout: 'value', x: right - 240, y: 76, w: 240, h: 14, style: { fontSize: 10, color: 'muted', align: 'right' } },
    { id: 'seller', type: 'seller', x: M, y: 116, w: 250, h: 104 },
    { id: 'issueDate', type: 'field', field: 'issueDate', layout: 'inline', x: right - 200, y: 116, w: 200, h: 14 },
    { id: 'dueDate', type: 'field', field: 'dueDate', layout: 'inline', x: right - 200, y: 132, w: 200, h: 14 },
    { id: 'reference', type: 'field', field: 'reference', layout: 'inline', x: right - 200, y: 148, w: 200, h: 14 },
    { id: 'placeOfSupply', type: 'field', field: 'placeOfSupply', layout: 'inline', x: right - 200, y: 164, w: 200, h: 14 },
    { id: 'billTo', type: 'billTo', x: M, y: 234, w: 240, h: 64 },
    { id: 'shipTo', type: 'shipTo', x: W / 2, y: 234, w: 240, h: 64 },
    { id: 'items', type: 'lineItems', x: M, y: 314, w: W - 2 * M, h: 170, columns: DEFAULT_COLUMNS },
    { id: 'notes', type: 'notes', x: M, y: 500, w: 250, h: 40 },
    { id: 'totals', type: 'totals', x: right - 210, y: 500, w: 210, h: 70 },
    { id: 'legal', type: 'legal', x: M, y: 586, w: W - 2 * M, h: 12 },
    { id: 'payment', type: 'payment', x: M, y: 612, w: W - 2 * M, h: 56 },
    { id: 'terms', type: 'terms', x: M, y: 680, w: W - 2 * M, h: 30, label: { show: false }, style: { fontSize: 8, color: 'muted' } },
    { id: 'footer', type: 'text', text: '{{footerText}}', x: M, y: H - 44, w: W - 2 * M - 80, h: 12, everyPage: true, style: { fontSize: 8, color: 'muted' } },
    { id: 'page', type: 'pageNumber', x: right - 80, y: H - 44, w: 80, h: 12, everyPage: true, style: { align: 'right' } },
  ]);
}

function modern(paperSize: PaperSize, accent?: string): InvoiceTemplateDocument {
  const { width: W, height: H } = PAPER_SIZES[paperSize];
  const M = 44;
  const right = W - M;
  const white = '#ffffff';
  return doc(paperSize, { accent: accent ?? '#0f766e' }, [
    { id: 'band', type: 'rect', x: 0, y: 0, w: W, h: 118, box: { background: 'accent' } },
    { id: 'logo', type: 'logo', x: M, y: 34, w: 150, h: 50, fallbackStyle: { fontSize: 18, bold: true, color: white } },
    { id: 'title', type: 'field', field: 'title', layout: 'value', x: right - 260, y: 30, w: 260, h: 36, style: { fontSize: 26, bold: true, color: white, align: 'right', uppercase: true } },
    { id: 'number', type: 'field', field: 'invoiceNumber', layout: 'value', x: right - 260, y: 68, w: 260, h: 16, style: { fontSize: 11, color: white, align: 'right' } },
    { id: 'total', type: 'field', field: 'balanceDue', layout: 'value', x: right - 260, y: 86, w: 260, h: 18, style: { fontSize: 12, bold: true, color: white, align: 'right' } },
    { id: 'billTo', type: 'billTo', x: M, y: 146, w: 170, h: 80 },
    { id: 'shipTo', type: 'shipTo', x: M + 180, y: 146, w: 160, h: 80 },
    { id: 'issueDate', type: 'field', field: 'issueDate', x: right - 150, y: 146, w: 150, h: 26 },
    { id: 'dueDate', type: 'field', field: 'dueDate', x: right - 150, y: 178, w: 150, h: 26 },
    { id: 'reference', type: 'field', field: 'reference', x: right - 150, y: 210, w: 150, h: 26 },
    {
      id: 'items',
      type: 'lineItems',
      x: M,
      y: 252,
      w: W - 2 * M,
      h: 200,
      columns: DEFAULT_COLUMNS,
      header: { background: 'accent', color: white, uppercase: true },
      zebra: '#f3f5f7',
      rowRule: '#ffffff',
    },
    { id: 'totals', type: 'totals', x: right - 220, y: 468, w: 220, h: 70, total: { background: 'accent', color: white, rule: 'accent' } },
    { id: 'payment', type: 'payment', x: M, y: 468, w: 240, h: 60, box: { background: '#f3f5f7', padding: 10, radius: 4 } },
    { id: 'notes', type: 'notes', x: M, y: 552, w: W - 2 * M, h: 30 },
    { id: 'legal', type: 'legal', x: M, y: 594, w: W - 2 * M, h: 12 },
    { id: 'terms', type: 'terms', x: M, y: 620, w: W - 2 * M, h: 30, style: { fontSize: 8, color: 'muted' } },
    { id: 'rule', type: 'line', x: M, y: H - 62, w: W - 2 * M, h: 4, everyPage: true, color: 'accent', thickness: 1.5 },
    { id: 'seller', type: 'seller', x: M, y: H - 52, w: W - 2 * M - 90, h: 20, everyPage: true, inline: true, label: { show: false }, style: { fontSize: 7.5, color: 'muted' } },
    { id: 'page', type: 'pageNumber', x: right - 80, y: H - 52, w: 80, h: 12, everyPage: true, style: { align: 'right' } },
  ]);
}

function minimal(paperSize: PaperSize, accent?: string): InvoiceTemplateDocument {
  const { width: W, height: H } = PAPER_SIZES[paperSize];
  const M = 56;
  const right = W - M;
  return doc(paperSize, { font: 'times', accent: accent ?? '#1a1a1f', fontSize: 9.5 }, [
    { id: 'title', type: 'field', field: 'title', layout: 'value', x: M, y: 52, w: 300, h: 40, style: { fontSize: 28, color: 'text' } },
    { id: 'logo', type: 'logo', x: right - 140, y: 52, w: 140, h: 40, align: 'right' },
    { id: 'number', type: 'field', field: 'invoiceNumber', layout: 'inline', x: M, y: 112, w: 180, h: 14, label: { uppercase: false } },
    { id: 'issueDate', type: 'field', field: 'issueDate', layout: 'inline', x: M, y: 128, w: 180, h: 14, label: { uppercase: false } },
    { id: 'dueDate', type: 'field', field: 'dueDate', layout: 'inline', x: M, y: 144, w: 180, h: 14, label: { uppercase: false } },
    { id: 'seller', type: 'seller', x: W / 2 - 20, y: 112, w: 160, h: 80 },
    { id: 'billTo', type: 'billTo', x: right - 140, y: 112, w: 140, h: 80 },
    {
      id: 'items',
      type: 'lineItems',
      x: M,
      y: 222,
      w: W - 2 * M,
      h: 200,
      columns: [
        { key: 'description', width: 55 },
        { key: 'quantity', width: 10 },
        { key: 'unitPrice', width: 17 },
        { key: 'amount', width: 18 },
      ],
      header: { uppercase: false, rule: 'text' },
      rowRule: '#ececec',
    },
    { id: 'totals', type: 'totals', x: right - 200, y: 440, w: 200, h: 60, total: { rule: 'text' } },
    { id: 'notes', type: 'notes', x: M, y: 440, w: 220, h: 40, label: { uppercase: false } },
    { id: 'legal', type: 'legal', x: M, y: 520, w: W - 2 * M, h: 12 },
    { id: 'payment', type: 'payment', x: M, y: 548, w: W - 2 * M, h: 40, label: { uppercase: false } },
    { id: 'terms', type: 'terms', x: M, y: 600, w: W - 2 * M, h: 24, label: { show: false }, style: { fontSize: 8, color: 'muted' } },
    { id: 'page', type: 'pageNumber', x: M, y: H - 40, w: W - 2 * M, h: 12, everyPage: true, style: { align: 'center' } },
  ]);
}

export function presetTemplate(preset: TemplatePreset, paperSize: PaperSize, accent?: string | null): InvoiceTemplateDocument {
  const color = accent && /^#[0-9a-fA-F]{6}$/.test(accent) ? accent : undefined;
  if (preset === 'modern') return modern(paperSize, color);
  if (preset === 'minimal') return minimal(paperSize, color);
  return classic(paperSize, color);
}
