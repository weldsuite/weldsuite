/**
 * Text measurement with the metrics of the bundled invoice fonts (Noto Sans,
 * Noto Serif, Noto Sans Mono; files in ./fonts, widths in ./font-metrics).
 * The layout engine measures with these, the PDF embeds the same files and
 * the HTML/SVG loads them through @font-face, so line breaks and
 * right-aligned amounts land on the same spot in every output.
 *
 * The files have no kerning or ligature tables: a line is exactly the sum of
 * its characters' advance widths, in a browser as much as in the PDF.
 */
import { FONT_METRICS, type FontFaceKey } from './font-metrics';
import type { TemplateFont } from './schema';

export { FONT_FACE_KEYS, FONT_METRICS, type FontFaceKey } from './font-metrics';

export interface FontFace {
  font: TemplateFont;
  bold?: boolean;
  italic?: boolean;
}

export type FontFamilyKey = 'sans' | 'serif' | 'mono';

/** The template fonts keep their original names; what they are drawn with is Noto. */
const FAMILY: Record<TemplateFont, FontFamilyKey> = { helvetica: 'sans', times: 'serif', courier: 'mono' };

export function fontFamilyOf(font: TemplateFont): FontFamilyKey {
  return FAMILY[font] ?? 'sans';
}

/**
 * Noto Sans Mono has no italic: an italic mono run is drawn with the upright
 * face, slanted (the browser synthesises the same oblique).
 */
export function isSlanted(face: FontFace): boolean {
  return Boolean(face.italic) && fontFamilyOf(face.font) === 'mono';
}

/** The bundled face a run is drawn with. */
export function faceKeyOf(face: FontFace): FontFaceKey {
  const family = fontFamilyOf(face.font);
  const italic = face.italic && family !== 'mono';
  const style = [face.bold && 'bold', italic && 'italic'].filter(Boolean).join('-') || 'regular';
  return `${family}-${style}` as FontFaceKey;
}

const widthTables = new Map<FontFaceKey, Map<number, number>>();

function widthsOf(key: FontFaceKey): Map<number, number> {
  let table = widthTables.get(key);
  if (!table) {
    table = new Map();
    for (const [first, ...widths] of FONT_METRICS[key].runs) {
      widths.forEach((w, i) => table!.set(first + i, w));
    }
    widthTables.set(key, table);
  }
  return table;
}

/** Narrow / thin / figure / hair spaces some locales put in amounts and dates. */
const SPACE_LIKE = /[\u2007\u2009\u200a\u202f]/g;
/** Soft hyphen, zero-width and bidi control characters: a browser draws nothing for them. */
const INVISIBLE = /[\u00ad\u200b-\u200f\u202a-\u202e\u2060-\u2064\ufeff]/g;

/**
 * The text as the layout works on it: composed (NFC, so "e" + combining acute
 * is one "é" glyph), odd spaces and line breaks as plain spaces, invisible
 * format characters gone.
 */
export function normalizeText(text: string): string {
  return text.normalize('NFC').replace(INVISIBLE, '').replace(SPACE_LIKE, ' ').replace(/[\t\r\n]/g, ' ');
}

/** Whether the bundled font has a glyph for the character. */
export function hasGlyph(char: string, face: FontFace): boolean {
  return widthsOf(faceKeyOf(face)).has(char.codePointAt(0) ?? 0);
}

/**
 * The text as the PDF can draw it. The bundled fonts cover Latin (every
 * European language and Vietnamese), Greek, Cyrillic and the currency signs;
 * a character outside that (CJK, Indic, Arabic, emoji) becomes "?". The HTML
 * keeps the real characters and lets the browser fall back for those.
 */
export function drawableText(text: string, face: FontFace): string {
  const widths = widthsOf(faceKeyOf(face));
  let out = '';
  for (const ch of normalizeText(text)) out += widths.has(ch.codePointAt(0) ?? 0) ? ch : '?';
  return out;
}

/** Width in points; characters the font lacks count as "?", which the PDF draws in their place. */
export function textWidth(text: string, size: number, face: FontFace): number {
  const widths = widthsOf(faceKeyOf(face));
  const fallback = widths.get(0x3f) ?? 500;
  let total = 0;
  for (const ch of text) total += widths.get(ch.codePointAt(0) ?? 0) ?? fallback;
  return (total * size) / 1000;
}

/** Distance from the top of the glyphs to the baseline, as a fraction of the font size. */
export function ascentRatio(face: FontFace): number {
  return FONT_METRICS[faceKeyOf(face)].ascent;
}

/**
 * Greedy word wrap. Words longer than the line are broken by character, so an
 * IBAN or a Pix code never runs off the block.
 */
export function wrapText(text: string, size: number, face: FontFace, maxWidth: number): string[] {
  const fits = (value: string) => textWidth(value, size, face) <= maxWidth;
  return text.split(/\r?\n/).flatMap((paragraph) => wrapParagraph(normalizeText(paragraph), fits));
}

function wrapParagraph(paragraph: string, fits: (value: string) => boolean): string[] {
  const lines: string[] = [];
  let current = '';
  for (const word of paragraph.split(/ +/).filter(Boolean)) {
    const candidate = current ? `${current} ${word}` : word;
    if (fits(candidate)) {
      current = candidate;
      continue;
    }
    if (current) lines.push(current);
    const pieces = breakWord(word, fits);
    lines.push(...pieces.slice(0, -1));
    current = pieces[pieces.length - 1];
  }
  lines.push(current);
  return lines;
}

/** A word in pieces that each fit the line; a single piece when the whole word fits. */
function breakWord(word: string, fits: (value: string) => boolean): string[] {
  const pieces: string[] = [];
  let piece = '';
  for (const ch of word) {
    if (piece && !fits(piece + ch)) {
      pieces.push(piece);
      piece = '';
    }
    piece += ch;
  }
  pieces.push(piece);
  return pieces;
}
