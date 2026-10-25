/**
 * A TrueType font embedded as a subset, for the characters the standard
 * fonts cannot show (Greek, Cyrillic, CJK, emoji outlines…). PDF's way to
 * use more than 256 glyphs of a font is a Type0 font over a CIDFontType2
 * descendant with two-byte Identity-H codes: each code is a CID, and each
 * CID is a glyph id of the subset. A ToUnicode map lets viewers copy and
 * search the text.
 */

import { hex4 } from './bytes';
import { name, num, ref, type PdfWriter } from './pdf-writer';
import { FontSubset } from './subset';
import type { TrueTypeFont } from './truetype';

export class EmbeddedFont {
  readonly subset: FontSubset;
  /** Object number of the Type0 font, reserved up front so pages can name it. */
  readonly n: number;

  constructor(
    readonly font: TrueTypeFont,
    /** Resource name, e.g. `E1`. */
    readonly resource: string,
    pdf: PdfWriter,
  ) {
    this.subset = new FontSubset(font);
    this.n = pdf.alloc();
  }

  /** The CID for a code point, or null when the font has no glyph for it. */
  cid(codePoint: number): number | null {
    return this.subset.use(codePoint);
  }

  /** Advance of a CID, 1/1000 em (what the /W array says). */
  width(cid: number): number {
    return Math.round((this.subset.advance(cid) * 1000) / this.font.unitsPerEm);
  }

  /** Writes the subset font and the PDF objects describing it. */
  async write(pdf: PdfWriter): Promise<void> {
    const font = this.font;
    const data = this.subset.build();
    const count = this.subset.size;
    const scale = 1000 / font.unitsPerEm;
    const tag = subsetTag(this.subset.unicode);
    const baseFont = `${tag}+${font.postScriptName}`;

    const file = await pdf.stream(`/Length1 ${data.length}`, data);
    let flags = 4; // symbolic: the glyphs are not all in the standard Latin set
    if (font.fixedPitch) flags |= 1;
    if (font.italic) flags |= 64;
    const [x0, y0, x1, y1] = font.bbox;
    // Common estimate of the dominant stem width from the weight class.
    const stemV = Math.round(10 + 220 * ((Math.max(font.weight, 50) - 50) / 650) ** 2);
    const descriptor = pdf.add(
      `<< /Type /FontDescriptor /FontName ${name(baseFont)} /Flags ${flags} ` +
        `/FontBBox [${num(x0 * scale)} ${num(y0 * scale)} ${num(x1 * scale)} ${num(y1 * scale)}] ` +
        `/ItalicAngle ${num(font.italicAngle)} /Ascent ${num(font.ascent * scale)} /Descent ${num(font.descent * scale)} ` +
        `/CapHeight ${num(font.capHeight * scale)} /StemV ${stemV} /FontFile2 ${ref(file)} >>`,
    );

    const widths: string[] = [];
    for (let cid = 0; cid < count; cid++) widths.push(String(this.width(cid)));
    const cidFont = pdf.add(
      `<< /Type /Font /Subtype /CIDFontType2 /BaseFont ${name(baseFont)} ` +
        `/CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> ` +
        `/FontDescriptor ${ref(descriptor)} /DW 1000 /W [0 [${widths.join(' ')}]] /CIDToGIDMap /Identity >>`,
    );
    const toUnicode = await pdf.stream('', new TextEncoder().encode(toUnicodeCMap(this.subset.unicode)));
    pdf.set(
      this.n,
      `<< /Type /Font /Subtype /Type0 /BaseFont ${name(baseFont)} /Encoding /Identity-H ` +
        `/DescendantFonts [${ref(cidFont)}] /ToUnicode ${ref(toUnicode)} >>`,
    );
  }
}

/** Six capital letters naming the subset (PDF wants subset fonts tagged so two subsets never clash). */
function subsetTag(unicode: Map<number, number>): string {
  let h = 0x811c9dc5;
  for (const [cid, cp] of unicode) h = Math.imul(h ^ (cid * 0x10000 + cp), 0x01000193) >>> 0;
  let tag = '';
  for (let i = 0; i < 6; i++) {
    tag += String.fromCharCode(65 + (h % 26));
    h = Math.floor(h / 26) + i * 7919;
  }
  return tag;
}

/** Maps each CID back to its character, so copied text is the real text. */
export function toUnicodeCMap(unicode: Map<number, number>): string {
  const entries = [...unicode].sort((a, b) => a[0] - b[0]);
  let body = '';
  for (let i = 0; i < entries.length; i += 100) {
    const chunk = entries.slice(i, i + 100);
    body += `${chunk.length} beginbfchar\n`;
    for (const [cid, cp] of chunk) body += `<${hex4(cid)}> <${utf16Hex(cp)}>\n`;
    body += 'endbfchar\n';
  }
  return (
    '/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n' +
    '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n' +
    '/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n' +
    '1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n' +
    body +
    'endcmap\nCMapName currentdict /CMap defineresource pop\nend\nend\n'
  );
}

function utf16Hex(cp: number): string {
  if (cp <= 0xffff) return hex4(cp);
  const v = cp - 0x10000;
  return hex4(0xd800 + (v >> 10)) + hex4(0xdc00 + (v & 0x3ff));
}
