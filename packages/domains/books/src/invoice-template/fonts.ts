/**
 * Text measurement with the metrics of the standard PDF fonts, the same
 * numbers pdf-lib uses when it draws. The layout engine measures with these,
 * so line breaks and right-aligned amounts land on the same spot in the PDF
 * and in the HTML/SVG (where Arial, Times New Roman and Courier New are
 * metric-compatible stand-ins).
 */
import { Encodings, Font, FontNames } from '@pdf-lib/standard-fonts';
import type { TemplateFont } from './schema';

export interface FontFace {
  font: TemplateFont;
  bold?: boolean;
  italic?: boolean;
}

const FACE_NAMES: Record<TemplateFont, [regular: FontNames, bold: FontNames, italic: FontNames, boldItalic: FontNames]> = {
  helvetica: [FontNames.Helvetica, FontNames.HelveticaBold, FontNames.HelveticaOblique, FontNames.HelveticaBoldOblique],
  times: [FontNames.TimesRoman, FontNames.TimesRomanBold, FontNames.TimesRomanItalic, FontNames.TimesRomanBoldItalic],
  courier: [FontNames.Courier, FontNames.CourierBold, FontNames.CourierOblique, FontNames.CourierBoldOblique],
};

export function standardFontName(face: FontFace): FontNames {
  const names = FACE_NAMES[face.font] ?? FACE_NAMES.helvetica;
  return names[(face.bold ? 1 : 0) + (face.italic ? 2 : 0)];
}

const loaded = new Map<FontNames, Font>();

function metricsOf(face: FontFace): Font {
  const name = standardFontName(face);
  let font = loaded.get(name);
  if (!font) {
    font = Font.load(name);
    loaded.set(name, font);
  }
  return font;
}

/** Narrow / thin / no-break spaces some locales put in amounts and dates. */
const SPACE_LIKE = new RegExp(`[${String.fromCharCode(0x202f, 0x2009, 0x2007, 0x200a)}]`, 'g');

/** Odd spaces (narrow, thin, tabs, line breaks) as plain ones; the layout works on this. */
export function normalizeText(text: string): string {
  return text.replace(SPACE_LIKE, ' ').replace(/[\t\r\n]/g, ' ');
}

/**
 * The text as the standard (WinAnsi) PDF fonts can draw it: any character the
 * font lacks (ł, ő, ₹, CJK) becomes "?". Only the PDF painter applies this;
 * the HTML keeps the real characters.
 */
export function drawableText(text: string): string {
  const winAnsi = Encodings.WinAnsi;
  let out = '';
  for (const ch of normalizeText(text)) out += winAnsi.canEncodeUnicodeCodePoint(ch.codePointAt(0) ?? 0) ? ch : '?';
  return out;
}

/** Width in points; characters the font lacks count as "?", the width the PDF gives them. */
export function textWidth(text: string, size: number, face: FontFace): number {
  const font = metricsOf(face);
  const winAnsi = Encodings.WinAnsi;
  const glyphs = Array.from(text, (ch) => {
    const cp = ch.codePointAt(0) ?? 63;
    return winAnsi.canEncodeUnicodeCodePoint(cp) ? winAnsi.encodeUnicodeCodePoint(cp).name : 'question';
  });
  let total = 0;
  for (let i = 0; i < glyphs.length; i++) {
    const kern = i + 1 < glyphs.length ? font.getXAxisKerningForPair(glyphs[i], glyphs[i + 1]) || 0 : 0;
    total += (font.getWidthOfGlyph(glyphs[i]) || 0) + kern;
  }
  return (total * size) / 1000;
}

/** Distance from the top of a line box to its baseline, as a fraction of the font size. */
export function ascentRatio(face: FontFace): number {
  const font = metricsOf(face);
  return ((font.Ascender || font.FontBBox[3]) as number) / 1000;
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
