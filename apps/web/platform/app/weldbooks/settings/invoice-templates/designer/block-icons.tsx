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
  type LucideIcon,
} from 'lucide-react';
import type { TemplateBlock, TemplateBlockType, TemplateField } from '@weldsuite/books-domain/invoice-template/schema';

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
    const first = block.text.split('\n')[0].trim();
    if (first) return first.length > 28 ? `${first.slice(0, 27)}…` : first;
  }
  return names[block.type];
}
