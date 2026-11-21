/**
 * The add-block menu: every field type with its icon, in groups. Labels come
 * from i18n (`weldforms.blockTypes`).
 */

import {
  AlignLeft,
  AtSign,
  Calendar,
  CheckSquare,
  CircleDot,
  FileUp,
  Gauge,
  Globe,
  Grid3x3,
  Hash,
  Heart,
  Image as ImageIcon,
  ListChecks,
  ListOrdered,
  type LucideIcon,
  MapPin,
  MessageSquareQuote,
  PenLine,
  Phone,
  Scissors,
  Shapes,
  Star,
  ThumbsUp,
  Type,
  User,
  ChevronDownSquare,
  ToggleLeft,
} from 'lucide-react';
import type { FieldType } from '@weldsuite/forms-engine';

export type BlockKind = FieldType | 'statement' | 'group' | 'page_break';

export const BLOCK_ICONS: Record<BlockKind, LucideIcon> = {
  short_text: Type,
  long_text: AlignLeft,
  email: AtSign,
  phone: Phone,
  number: Hash,
  website: Globe,
  date: Calendar,
  multiple_choice: ListChecks,
  dropdown: ChevronDownSquare,
  picture_choice: ImageIcon,
  yes_no: ToggleLeft,
  legal: CheckSquare,
  rating: Star,
  opinion_scale: Gauge,
  nps: ThumbsUp,
  ranking: ListOrdered,
  matrix: Grid3x3,
  file_upload: FileUp,
  signature: PenLine,
  contact_info: User,
  address: MapPin,
  statement: MessageSquareQuote,
  group: Shapes,
  page_break: Scissors,
};

export type BlockCategory = 'text' | 'choice' | 'scales' | 'files' | 'composite' | 'layout';

export const BLOCK_CATEGORIES: ReadonlyArray<{ id: BlockCategory; kinds: readonly BlockKind[] }> = [
  { id: 'text', kinds: ['short_text', 'long_text', 'email', 'phone', 'number', 'website', 'date'] },
  { id: 'choice', kinds: ['multiple_choice', 'dropdown', 'picture_choice', 'yes_no', 'legal'] },
  { id: 'scales', kinds: ['rating', 'opinion_scale', 'nps', 'ranking', 'matrix'] },
  { id: 'files', kinds: ['file_upload', 'signature'] },
  { id: 'composite', kinds: ['contact_info', 'address'] },
  { id: 'layout', kinds: ['statement', 'group', 'page_break'] },
];

export const ENDING_ICON = CircleDot;
export const RATING_SHAPE_ICON = Heart;
