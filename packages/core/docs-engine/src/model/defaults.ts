/**
 * The built-in named styles and list definitions every new document starts
 * with. Close to Google Docs' defaults (Arial 11 pt, 1.15 line height), so a
 * document looks familiar and round-trips to .docx without surprises.
 */

import type { ListDef, ListLevel, NamedStyle } from './styles';

export const DEFAULT_FONT = 'Arial';
export const DEFAULT_SIZE = 11;
export const NORMAL = 'normal';

export const BUILT_IN_STYLES: Record<string, NamedStyle> = {
  normal: {
    name: 'Normal text',
    text: { font: DEFAULT_FONT, size: DEFAULT_SIZE, color: '#000000' },
    para: { lineHeight: 1.15, spaceBefore: 0, spaceAfter: 0 },
  },
  title: {
    name: 'Title',
    basedOn: NORMAL,
    next: NORMAL,
    text: { size: 26 },
    para: { spaceAfter: 3, keepNext: true },
    outline: 0,
  },
  subtitle: {
    name: 'Subtitle',
    basedOn: NORMAL,
    next: NORMAL,
    text: { size: 15, color: '#666666' },
    para: { spaceAfter: 16, keepNext: true },
  },
  heading1: {
    name: 'Heading 1',
    basedOn: NORMAL,
    next: NORMAL,
    text: { size: 20 },
    para: { spaceBefore: 20, spaceAfter: 6, keepNext: true },
    outline: 1,
  },
  heading2: {
    name: 'Heading 2',
    basedOn: NORMAL,
    next: NORMAL,
    text: { size: 16 },
    para: { spaceBefore: 18, spaceAfter: 6, keepNext: true },
    outline: 2,
  },
  heading3: {
    name: 'Heading 3',
    basedOn: NORMAL,
    next: NORMAL,
    text: { size: 14, color: '#434343' },
    para: { spaceBefore: 16, spaceAfter: 4, keepNext: true },
    outline: 3,
  },
  heading4: {
    name: 'Heading 4',
    basedOn: NORMAL,
    next: NORMAL,
    text: { size: 12, color: '#666666' },
    para: { spaceBefore: 14, spaceAfter: 4, keepNext: true },
    outline: 4,
  },
  heading5: {
    name: 'Heading 5',
    basedOn: NORMAL,
    next: NORMAL,
    text: { size: 11, color: '#666666' },
    para: { spaceBefore: 12, spaceAfter: 4, keepNext: true },
    outline: 5,
  },
  heading6: {
    name: 'Heading 6',
    basedOn: NORMAL,
    next: NORMAL,
    text: { size: 11, italic: true, color: '#666666' },
    para: { spaceBefore: 12, spaceAfter: 4, keepNext: true },
    outline: 6,
  },
  quote: {
    name: 'Quote',
    basedOn: NORMAL,
    text: { italic: true, color: '#555555' },
    para: { indentLeft: 36, indentRight: 36, spaceBefore: 6, spaceAfter: 6 },
  },
  code: {
    name: 'Code',
    basedOn: NORMAL,
    text: { font: 'Courier New', size: 10 },
    para: { lineHeight: 1, shading: '#f3f3f3' },
  },
};

export const HEADING_STYLES = ['heading1', 'heading2', 'heading3', 'heading4', 'heading5', 'heading6'] as const;

const BULLETS = ['●', '○', '■'];
const NUMBERS: ListLevel['format'][] = ['decimal', 'lowerAlpha', 'lowerRoman'];

function levels(make: (level: number) => Pick<ListLevel, 'format' | 'text'> & Partial<ListLevel>): ListLevel[] {
  return Array.from({ length: 9 }, (_, level) => ({ indent: 36 * (level + 1), hanging: 18, ...make(level) }));
}

export function bulletList(): ListDef {
  return { levels: levels((l) => ({ format: 'bullet', text: BULLETS[l % 3]! })) };
}

export function numberedList(): ListDef {
  return { levels: levels((l) => ({ format: NUMBERS[l % 3]!, text: `%${l + 1}.`, start: 1 })) };
}

export function checkList(): ListDef {
  return { levels: levels(() => ({ format: 'check', text: '☐' })) };
}
