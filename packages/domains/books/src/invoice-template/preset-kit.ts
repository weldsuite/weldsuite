/**
 * Building blocks shared by the built-in template designs in `./presets/`: the document shell, the
 * default theme and table columns, and the colour helpers designs derive tints and readable text with.
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

export const DEFAULT_THEME: TemplateTheme = {
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

/** A preset's document: version, paper, the standard margins, the theme over the default, and the blocks. */
export function doc(
  paperSize: PaperSize,
  theme: Partial<TemplateTheme>,
  blocks: TemplateBlock[],
  margins: { top: number; bottom: number } = { top: 48, bottom: 56 },
): InvoiceTemplateDocument {
  return {
    version: INVOICE_TEMPLATE_VERSION,
    paperSize,
    margins,
    theme: { ...DEFAULT_THEME, ...theme },
    blocks,
  };
}

/** Page width and height in points. */
export function page(paperSize: PaperSize): { W: number; H: number } {
  const { width, height } = PAPER_SIZES[paperSize];
  return { W: width, H: height };
}

export { contrast, legible, luminance, mix, readableOn, shade, tint } from './colors';
