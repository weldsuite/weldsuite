import {
  Building2,
  Hash,
  Image as ImageIcon,
  Landmark,
  Minus,
  Scale,
  ScrollText,
  Sigma,
  Square,
  StickyNote,
  Table2,
  TextCursorInput,
  Truck,
  Type,
  UserRound,
  Hexagon,
  createLucideIcon,
  type LucideIcon,
} from 'lucide-react';
import type { TemplateBlock, TemplateBlockType, TemplateField } from '@weldsuite/books-domain/invoice-template/schema';

/**
 * Lucide's `square-dimensions` (lucide 1.x, ISC). Newer than the lucide-react in this repo, so it is
 * built from the official path data with lucide's own factory and renders like every other icon.
 */
export const SquareDimensions = createLucideIcon('square-dimensions', [
  ['rect', { width: '18', height: '18', x: '3', y: '3', rx: '2', key: 'square' }],
  ['path', { d: 'M12 7H7v5', key: 'top-left' }],
  ['path', { d: 'M12 17h5v-5', key: 'bottom-right' }],
]);

export const BLOCK_ICONS: Record<TemplateBlockType, LucideIcon> = {
  text: Type,
  field: TextCursorInput,
  logo: Hexagon,
  image: ImageIcon,
  seller: Building2,
  billTo: UserRound,
  shipTo: Truck,
  lineItems: Table2,
  totals: Sigma,
  payment: Landmark,
  notes: StickyNote,
  terms: ScrollText,
  legal: Scale,
  rect: Square,
  line: Minus,
  pageNumber: Hash,
};

/** The name a block goes by in the layers list and the inspector header. */
export function blockLabel(block: TemplateBlock, names: Record<TemplateBlockType, string>, fieldNames: Record<TemplateField, string>): string {
  if (block.type === 'field') return fieldNames[block.field] ?? names.field;
  if (block.type === 'text') {
    // `{{footerText}}` reads as "Footer text": placeholders show as the field they print.
    const named = block.text.replace(/\{\{\s*(\w+)\s*\}\}/g, (match, key: string) => (fieldNames as Record<string, string>)[key] ?? match);
    const first = named.split('\n')[0].trim();
    if (first) return first.length > 28 ? `${first.slice(0, 27)}…` : first;
  }
  return names[block.type];
}
