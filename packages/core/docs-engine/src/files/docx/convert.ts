/**
 * Conversions shared by the .docx reader and writer: units, colours, borders,
 * number formats and the names Word gives the built-in styles.
 *
 * WordprocessingML measures most distances in twips (1/20 pt), font sizes in
 * half-points, border widths in eighths of a point and drawings in EMU
 * (12,700 per point); the engine works in points throughout.
 */

import type { ListFormat } from '../../model/styles';
import type { BorderLine } from '../../model/styles';
import type { SectionProps, SectionStart } from '../../model/objects';

export const NS = {
  w: 'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
  r: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
  wp: 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing',
  a: 'http://schemas.openxmlformats.org/drawingml/2006/main',
  pic: 'http://schemas.openxmlformats.org/drawingml/2006/picture',
  rels: 'http://schemas.openxmlformats.org/package/2006/relationships',
  ct: 'http://schemas.openxmlformats.org/package/2006/content-types',
  mc: 'http://schemas.openxmlformats.org/markup-compatibility/2006',
  w14: 'http://schemas.microsoft.com/office/word/2010/wordml',
  w15: 'http://schemas.microsoft.com/office/word/2012/wordml',
};

export const REL = {
  officeDocument: `${NS.r}/officeDocument`,
  styles: `${NS.r}/styles`,
  numbering: `${NS.r}/numbering`,
  settings: `${NS.r}/settings`,
  footnotes: `${NS.r}/footnotes`,
  endnotes: `${NS.r}/endnotes`,
  header: `${NS.r}/header`,
  footer: `${NS.r}/footer`,
  image: `${NS.r}/image`,
  hyperlink: `${NS.r}/hyperlink`,
  theme: `${NS.r}/theme`,
  comments: `${NS.r}/comments`,
  commentsExtended: 'http://schemas.microsoft.com/office/2011/relationships/commentsExtended',
  coreProps: 'http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties',
  appProps: `${NS.r}/extended-properties`,
};

export const EMU_PER_POINT = 12_700;

export function twips(points: number): number {
  return Math.round(points * 20);
}

/** Points from a twips attribute, or undefined when it is missing or not a number. */
export function fromTwips(value: string | undefined): number | undefined {
  const n = num(value);
  return n === undefined ? undefined : round2(n / 20);
}

export function halfPoints(points: number): number {
  return Math.max(1, Math.round(points * 2));
}

export function num(value: string | undefined): number | undefined {
  if (value === undefined || value === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** An OOXML on/off value: present without a value means on. */
export function onOff(value: string | undefined): boolean {
  return value === undefined || !['0', 'false', 'off', 'none'].includes(value.toLowerCase());
}

// ---------------------------------------------------------------- dates

/** Epoch ms as Word writes a revision's or comment's date (`2026-10-25T12:00:00Z`); undefined for none or one out of range. */
export function wordDate(ms: number): string | undefined {
  if (Number.isNaN(ms) || ms <= 0) return undefined;
  const d = new Date(ms);
  return Number.isFinite(d.getTime()) ? d.toISOString().replace(/\.\d{3}Z$/, 'Z') : undefined;
}

/** Epoch ms of a Word date (UTC when it names no zone); 0 when it is missing or unreadable. */
export function readWordDate(value: string | undefined): number {
  if (!value) return 0;
  const v = value.trim();
  const zoned = !v.includes('T') || /(?:z|[+-]\d\d:?\d\d)$/i.test(v);
  const ms = Date.parse(zoned ? v : `${v}Z`);
  return Number.isFinite(ms) && ms > 0 ? ms : 0;
}

// ---------------------------------------------------------------- colours

/** `#rrggbb` → `RRGGBB`. */
export function hex(color: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(color.trim());
  return m ? m[1]!.toUpperCase() : '000000';
}

/** `RRGGBB` → `#rrggbb`; `auto` and anything else unreadable → undefined. */
export function fromHex(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const m = /^#?([0-9a-f]{6})$/i.exec(value.trim());
  return m ? `#${m[1]!.toLowerCase()}` : undefined;
}

/** Word's highlight colours (`w:highlight`); any other background is written as run shading. */
export const HIGHLIGHTS: Record<string, string> = {
  yellow: '#ffff00',
  green: '#00ff00',
  cyan: '#00ffff',
  magenta: '#ff00ff',
  blue: '#0000ff',
  red: '#ff0000',
  darkBlue: '#000080',
  darkCyan: '#008080',
  darkGreen: '#008000',
  darkMagenta: '#800080',
  darkRed: '#800000',
  darkYellow: '#808000',
  darkGray: '#808080',
  lightGray: '#c0c0c0',
  black: '#000000',
  white: '#ffffff',
};

export function highlightName(color: string): string | undefined {
  const c = color.toLowerCase();
  return Object.keys(HIGHLIGHTS).find((k) => HIGHLIGHTS[k] === c);
}

// ---------------------------------------------------------------- borders

const BORDER_OUT: Record<NonNullable<BorderLine['style']>, string> = { solid: 'single', dashed: 'dashed', dotted: 'dotted', double: 'double' };

/** Attributes of a border element (`w:top`, `w:bottom`, …). */
export function borderAttrs(line: BorderLine): Record<string, string | number> {
  if (!line.width) return { 'w:val': 'nil' };
  return {
    'w:val': BORDER_OUT[line.style ?? 'solid'],
    'w:sz': Math.min(96, Math.max(2, Math.round(line.width * 8))),
    'w:space': 0,
    'w:color': hex(line.color),
  };
}

/** A border element's attributes as a line; `nil`/`none` → width 0. */
export function readBorder(a: Record<string, string> | undefined): BorderLine | undefined {
  if (!a) return undefined;
  const val = a.val ?? 'single';
  if (val === 'nil' || val === 'none') return { width: 0, color: '#000000' };
  const line: BorderLine = { width: round2((num(a.sz) ?? 4) / 8), color: fromHex(a.color) ?? '#000000' };
  if (val === 'dashed' || val.startsWith('dashDot') || val === 'dashSmallGap') line.style = 'dashed';
  else if (val === 'dotted' || val === 'dotDash' || val === 'dotDotDash') line.style = 'dotted';
  else if (val === 'double' || val.startsWith('thinThick') || val.startsWith('thickThin') || val === 'triple') line.style = 'double';
  return line;
}

// ---------------------------------------------------------------- lists

const NUM_FMT_OUT: Record<ListFormat, string> = {
  bullet: 'bullet',
  check: 'bullet',
  decimal: 'decimal',
  lowerAlpha: 'lowerLetter',
  upperAlpha: 'upperLetter',
  lowerRoman: 'lowerRoman',
  upperRoman: 'upperRoman',
  none: 'none',
};

export function numFmt(format: ListFormat): string {
  return NUM_FMT_OUT[format];
}

export function readNumFmt(value: string | undefined): ListFormat {
  switch (value) {
    case 'bullet':
      return 'bullet';
    case 'lowerLetter':
      return 'lowerAlpha';
    case 'upperLetter':
      return 'upperAlpha';
    case 'lowerRoman':
      return 'lowerRoman';
    case 'upperRoman':
      return 'upperRoman';
    case 'none':
      return 'none';
    default:
      return 'decimal';
  }
}

// ---------------------------------------------------------------- sections

type PageFormat = NonNullable<SectionProps['pageNumberFormat']>;

export function pageFmt(format: PageFormat): string {
  if (format === 'lowerAlpha') return 'lowerLetter';
  return format === 'upperAlpha' ? 'upperLetter' : format;
}

export function readPageFmt(value: string | undefined): PageFormat | undefined {
  switch (value) {
    case 'decimal':
    case 'lowerRoman':
    case 'upperRoman':
      return value;
    case 'lowerLetter':
      return 'lowerAlpha';
    case 'upperLetter':
      return 'upperAlpha';
    default:
      return undefined;
  }
}

export function readSectionStart(value: string | undefined): SectionStart {
  return value === 'continuous' || value === 'evenPage' || value === 'oddPage' ? value : 'nextPage';
}

// ---------------------------------------------------------------- styles

/** The engine's built-in styles and the ids and names Word knows them by. */
export const BUILT_IN_WORD_STYLES: Record<string, { id: string; name: string }> = {
  normal: { id: 'Normal', name: 'Normal' },
  title: { id: 'Title', name: 'Title' },
  subtitle: { id: 'Subtitle', name: 'Subtitle' },
  heading1: { id: 'Heading1', name: 'heading 1' },
  heading2: { id: 'Heading2', name: 'heading 2' },
  heading3: { id: 'Heading3', name: 'heading 3' },
  heading4: { id: 'Heading4', name: 'heading 4' },
  heading5: { id: 'Heading5', name: 'heading 5' },
  heading6: { id: 'Heading6', name: 'heading 6' },
  quote: { id: 'Quote', name: 'Quote' },
  code: { id: 'Code', name: 'Code' },
};

/** Engine style id for a Word style name (matched without regard to case), or undefined for a custom style. */
export function builtInForName(name: string): string | undefined {
  const n = name.trim().toLowerCase();
  for (const [id, w] of Object.entries(BUILT_IN_WORD_STYLES)) if (w.name.toLowerCase() === n) return id;
  return undefined;
}

// ---------------------------------------------------------------- images

const MIME_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpeg',
  'image/gif': 'gif',
  'image/bmp': 'bmp',
  'image/tiff': 'tiff',
};

/** Extension for an image type Word can show, or undefined for one it cannot. */
export function imageExtension(mime: string): string | undefined {
  return MIME_EXT[mime.toLowerCase().split(';')[0]!.trim()];
}

export function mimeOf(name: string): string {
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
  switch (ext) {
    case 'png':
      return 'image/png';
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'gif':
      return 'image/gif';
    case 'bmp':
      return 'image/bmp';
    case 'tif':
    case 'tiff':
      return 'image/tiff';
    case 'svg':
      return 'image/svg+xml';
    case 'webp':
      return 'image/webp';
    case 'emf':
      return 'image/emf';
    case 'wmf':
      return 'image/wmf';
    default:
      return 'application/octet-stream';
  }
}
