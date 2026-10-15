/**
 * Creates the blocks the palette adds: default content and a sensible default
 * size per type, collision-free ids, and the palette's grouping.
 */
import { DEFAULT_COLUMNS } from '@weldsuite/books-domain/invoice-template/presets';
import type { InvoiceTemplateDocument, TemplateBlock, TemplateBlockType } from '@weldsuite/books-domain/invoice-template/schema';

export interface PaletteGroup {
  key: 'content' | 'parties' | 'invoice' | 'shapes' | 'page';
  types: TemplateBlockType[];
}

/** The palette, in the order the designer shows it. */
export const PALETTE_GROUPS: readonly PaletteGroup[] = [
  { key: 'content', types: ['text', 'field', 'logo', 'image'] },
  { key: 'parties', types: ['seller', 'billTo', 'shipTo'] },
  { key: 'invoice', types: ['lineItems', 'totals', 'payment', 'notes', 'terms', 'legal'] },
  { key: 'shapes', types: ['rect', 'line'] },
  { key: 'page', types: ['pageNumber'] },
];

/** A transparent 1x1 PNG: an image block's src until the user picks a picture. */
export const PLACEHOLDER_IMAGE =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

export function isPlaceholderImage(src: string | undefined): boolean {
  return !src || src === PLACEHOLDER_IMAGE;
}

/** Default size (points) of a new block. */
export const DEFAULT_SIZES: Record<TemplateBlockType, { w: number; h: number }> = {
  text: { w: 180, h: 20 },
  field: { w: 200, h: 14 },
  logo: { w: 140, h: 48 },
  image: { w: 120, h: 60 },
  seller: { w: 220, h: 90 },
  billTo: { w: 220, h: 70 },
  shipTo: { w: 220, h: 70 },
  lineItems: { w: 500, h: 170 },
  totals: { w: 220, h: 90 },
  payment: { w: 250, h: 60 },
  notes: { w: 250, h: 50 },
  terms: { w: 250, h: 50 },
  legal: { w: 400, h: 40 },
  rect: { w: 120, h: 60 },
  line: { w: 200, h: 1 },
  pageNumber: { w: 120, h: 12 },
};

/** Smallest size a block can be resized to: 4pt, except the thin side of a line (the schema's minimum width is 2pt). */
export function minSizeOf(block: Pick<TemplateBlock, 'type'> & { orientation?: string }): { minW: number; minH: number } {
  if (block.type === 'line') {
    return block.orientation === 'vertical' ? { minW: 2, minH: 4 } : { minW: 4, minH: 1 };
  }
  return { minW: 4, minH: 4 };
}

/** A block id that is not in `taken`: `<type>-<n>`, counting up. */
export function newBlockId(type: TemplateBlockType, taken: ReadonlySet<string> | readonly string[]): string {
  const used = taken instanceof Set ? taken : new Set(taken);
  let n = 1;
  while (used.has(`${type}-${n}`)) n += 1;
  return `${type}-${n}`;
}

export interface CreateBlockOptions {
  x?: number;
  y?: number;
  /** Text of a new text block (translated by the caller). */
  text?: string;
}

/** A new block of a type with its defaults; the id is assigned by the caller. */
export function createBlock(type: TemplateBlockType, id: string, options: CreateBlockOptions = {}): TemplateBlock {
  const { w, h } = DEFAULT_SIZES[type];
  const base = { id, x: options.x ?? 48, y: options.y ?? 48, w, h };
  switch (type) {
    case 'text':
      return { ...base, type, text: options.text ?? 'Text' };
    case 'field':
      return { ...base, type, field: 'invoiceNumber', layout: 'inline' };
    case 'logo':
      return { ...base, type };
    case 'image':
      return { ...base, type, src: PLACEHOLDER_IMAGE };
    case 'seller':
      return { ...base, type, showContact: true, showTaxIds: true };
    case 'billTo':
      return { ...base, type, showEmail: true };
    case 'shipTo':
      return { ...base, type };
    case 'lineItems':
      return { ...base, type, columns: DEFAULT_COLUMNS.map((c) => ({ ...c })) };
    case 'totals':
      return { ...base, type, showBalance: true };
    case 'payment':
      return { ...base, type, showBank: true, showInstructions: true };
    case 'notes':
      return { ...base, type };
    case 'terms':
      return { ...base, type };
    case 'legal':
      return { ...base, type };
    case 'rect':
      return { ...base, type, box: { background: '#eef1f6' } };
    case 'line':
      return { ...base, type, color: 'muted', thickness: 1, orientation: 'horizontal' };
    case 'pageNumber':
      return { ...base, type, style: { align: 'right', color: 'muted', fontSize: 8 } };
  }
}

/** Where a new block lands: near the top-left of the visible area, cascaded when something already sits there. */
export function placementForNew(
  doc: Pick<InvoiceTemplateDocument, 'blocks'>,
  size: { w: number; h: number },
  visibleOrigin: { x: number; y: number },
  page: { width: number; height: number },
): { x: number; y: number } {
  const clampX = (x: number) => Math.max(0, Math.min(x, Math.max(0, page.width - size.w)));
  const clampY = (y: number) => Math.max(0, Math.min(y, Math.max(0, page.height - size.h)));
  let x = clampX(Math.round(visibleOrigin.x / 4) * 4);
  let y = clampY(Math.round(visibleOrigin.y / 4) * 4);
  for (let i = 0; i < 40; i++) {
    const taken = doc.blocks.some((b) => Math.abs(b.x - x) < 1 && Math.abs(b.y - y) < 1);
    if (!taken) break;
    x = clampX(x + 12);
    y = clampY(y + 12);
  }
  return { x, y };
}

/** Whether a template may hold another block of the type (exactly one line-items table). */
export function canAddBlock(doc: Pick<InvoiceTemplateDocument, 'blocks'>, type: TemplateBlockType): boolean {
  return type !== 'lineItems' || !doc.blocks.some((b) => b.type === 'lineItems');
}

/** Ids of the blocks a delete may remove: everything except the line-items table. */
export function removableIds(doc: Pick<InvoiceTemplateDocument, 'blocks'>, ids: readonly string[]): string[] {
  const protectedIds = new Set(doc.blocks.filter((b) => b.type === 'lineItems').map((b) => b.id));
  return ids.filter((id) => !protectedIds.has(id));
}
