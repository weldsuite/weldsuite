/**
 * The standard 14 PDF fonts, which every viewer has, so Latin text needs no
 * embedding. Text is encoded in WinAnsiEncoding (Windows-1252 as PDF
 * defines it).
 *
 * The faces are picked exactly as `MetricsMeasurer` picks its widths (serif,
 * mono or sans by family name), and each font's /Widths are the measurer's
 * widths, so the viewer places every character where the layout did.
 */

import type { FontSpec, TextMeasurer } from '../../layout/measure';

export type StandardFontName =
  | 'Helvetica'
  | 'Helvetica-Bold'
  | 'Helvetica-Oblique'
  | 'Helvetica-BoldOblique'
  | 'Times-Roman'
  | 'Times-Bold'
  | 'Times-Italic'
  | 'Times-BoldItalic'
  | 'Courier'
  | 'Courier-Bold'
  | 'Courier-Oblique'
  | 'Courier-BoldOblique';

// Same tests as `faceOf` in layout/measure.ts; keep the two in step.
const SERIF = /times|georgia|garamond|cambria|serif|merriweather|playfair|lora|book/i;
const MONO = /courier|mono|consolas|menlo|code/i;

type Family = 'sans' | 'serif' | 'mono';

function familyOf(family: string): Family {
  if (MONO.test(family)) return 'mono';
  if (SERIF.test(family) && !/sans/i.test(family)) return 'serif';
  return 'sans';
}

const NAMES: Record<Family, [StandardFontName, StandardFontName, StandardFontName, StandardFontName]> = {
  sans: ['Helvetica', 'Helvetica-Bold', 'Helvetica-Oblique', 'Helvetica-BoldOblique'],
  serif: ['Times-Roman', 'Times-Bold', 'Times-Italic', 'Times-BoldItalic'],
  mono: ['Courier', 'Courier-Bold', 'Courier-Oblique', 'Courier-BoldOblique'],
};

/** A family name the measurer classifies like each standard family. */
const REPRESENTATIVE: Record<Family, string> = { sans: 'Helvetica', serif: 'Times', mono: 'Courier' };

export function standardFont(font: Pick<FontSpec, 'family' | 'bold' | 'italic'>): StandardFontName {
  return NAMES[familyOf(font.family)][(font.bold ? 1 : 0) + (font.italic ? 2 : 0)]!;
}

export const FIRST_CHAR = 32;
export const LAST_CHAR = 255;

/** The family a standard font belongs to. */
function standardFamily(name: StandardFontName): Family {
  if (name.startsWith('Times')) return 'serif';
  return name.startsWith('Courier') ? 'mono' : 'sans';
}

/**
 * /Widths for codes 32–255 in 1/1000 em: what the measurer gives each
 * character's Unicode equivalent (0 for the five unused codes).
 */
export function standardWidths(name: StandardFontName, measurer: TextMeasurer): number[] {
  const spec: FontSpec = { family: REPRESENTATIVE[standardFamily(name)], size: 1000, bold: name.includes('Bold'), italic: /Oblique|Italic/.test(name) };
  const out: number[] = [];
  for (let code = FIRST_CHAR; code <= LAST_CHAR; code++) {
    const u = WIN_ANSI_TO_UNICODE[code];
    out.push(u === undefined ? 0 : roundWidth(measurer.measure(String.fromCodePoint(u), spec)));
  }
  return out;
}

/** Widths go into the file with three decimals; positioning uses the same rounded value. */
export function roundWidth(w: number): number {
  return Math.round(w * 1000) / 1000;
}

// ---------------------------------------------------------------- WinAnsiEncoding

/** Codes 0x80–0x9F, which differ from Latin-1 (undefined where Windows-1252 has no character). */
const HIGH: (number | undefined)[] = [
  0x20ac, undefined, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, undefined, 0x017d, undefined,
  undefined, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, undefined, 0x017e, 0x0178,
];

/** Unicode of each WinAnsi code 32–255 (undefined: unused). */
const WIN_ANSI_TO_UNICODE: (number | undefined)[] = [];
const UNICODE_TO_WIN_ANSI = new Map<number, number>();

for (let code = 32; code <= 255; code++) {
  let u: number | undefined;
  if (code < 0x7f || code >= 0xa0) u = code;
  else if (code >= 0x80) u = HIGH[code - 0x80];
  WIN_ANSI_TO_UNICODE[code] = u;
  if (u !== undefined) UNICODE_TO_WIN_ANSI.set(u, code);
}

/** The WinAnsi code for a code point, or null when the standard fonts cannot show it. */
export function winAnsiCode(codePoint: number): number | null {
  return UNICODE_TO_WIN_ANSI.get(codePoint) ?? null;
}
