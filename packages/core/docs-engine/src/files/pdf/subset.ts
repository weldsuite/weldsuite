/**
 * Builds a TrueType font holding only the glyphs a document uses, so a PDF
 * carries a few kilobytes of a font instead of megabytes.
 *
 * Glyphs are renumbered densely in the order they were first used (0 stays
 * .notdef); the components of composite glyphs are added after them and the
 * composites rewritten to point at the new ids. The PDF then uses the new
 * glyph ids as CIDs directly (CIDToGIDMap /Identity). Hinting tables (cvt,
 * fpgm, prep, gasp) are copied unchanged, since glyph programs call into them.
 */

import { ByteReader, ByteWriter } from './bytes';
import { glyphComponents, type TrueTypeFont } from './truetype';

export class FontSubset {
  /** Original glyph id → new id. */
  private readonly ids = new Map<number, number>([[0, 0]]);
  /** New id → original glyph id. */
  private readonly glyphs: number[] = [0];
  /** New id → the code point it was first used for (ToUnicode, cmap). */
  readonly unicode = new Map<number, number>();

  constructor(readonly font: TrueTypeFont) {}

  /** The new glyph id showing `codePoint`, or null when the font has no glyph for it. */
  use(codePoint: number): number | null {
    const gid = this.font.glyphIndex(codePoint);
    if (!gid) return null;
    const id = this.add(gid);
    if (!this.unicode.has(id)) this.unicode.set(id, codePoint);
    return id;
  }

  private add(gid: number): number {
    let id = this.ids.get(gid);
    if (id === undefined) {
      id = this.glyphs.length;
      this.ids.set(gid, id);
      this.glyphs.push(gid);
    }
    return id;
  }

  /** Advance width of a new glyph id, font units. */
  advance(id: number): number {
    return this.font.advance(this.glyphs[id] ?? 0);
  }

  /** Number of glyphs so far (grows when `build` pulls in components). */
  get size(): number {
    return this.glyphs.length;
  }

  /** Writes the subset font. Call once, after the last `use`. */
  build(): Uint8Array {
    const font = this.font;
    // Pull in composite components (which may themselves be composite).
    for (let i = 0; i < this.glyphs.length; i++) {
      for (const c of glyphComponents(font.glyphData(this.glyphs[i]!))) this.add(c.gid);
    }
    const n = this.glyphs.length;

    const glyf = new ByteWriter();
    const loca = new ByteWriter();
    const hmtx = new ByteWriter();
    for (const gid of this.glyphs) {
      loca.u32(glyf.length);
      const data = font.glyphData(gid);
      const components = glyphComponents(data);
      if (components.length) {
        const copy = data.slice();
        const w = new DataView(copy.buffer);
        for (const c of components) w.setUint16(c.at, this.ids.get(c.gid) ?? 0);
        glyf.bytes(copy);
      } else glyf.bytes(data);
      glyf.pad4();
      hmtx.u16(font.advance(gid)).i16(font.leftSideBearing(gid));
    }
    loca.u32(glyf.length);

    const tables = new Map<string, Uint8Array>();
    const head = copyTable(font, 'head');
    const hv = new DataView(head.buffer);
    hv.setUint32(8, 0); // checkSumAdjustment, set once the font is assembled
    hv.setInt16(50, 1); // long loca offsets
    tables.set('head', head);
    const hhea = copyTable(font, 'hhea');
    new DataView(hhea.buffer).setUint16(34, n);
    tables.set('hhea', hhea);
    const maxp = copyTable(font, 'maxp');
    new DataView(maxp.buffer).setUint16(4, n);
    tables.set('maxp', maxp);
    tables.set('glyf', glyf.finish());
    tables.set('loca', loca.finish());
    tables.set('hmtx', hmtx.finish());
    tables.set('cmap', buildCmap(this.unicode));
    tables.set('post', buildPost(font));
    tables.set('name', buildName(font.familyName, font.postScriptName));
    for (const tag of ['OS/2', 'cvt ', 'fpgm', 'prep', 'gasp']) {
      const t = font.tables.get(tag);
      if (t) tables.set(tag, t.slice());
    }
    return assembleFont(tables);
  }
}

function copyTable(font: TrueTypeFont, tag: string): Uint8Array {
  const t = font.tables.get(tag);
  if (!t) throw new Error(`Missing ${tag} table`);
  return t.slice();
}

// ---------------------------------------------------------------- tables

/** cmap with a format 4 subtable for the BMP and, when needed, a format 12 one for everything. */
function buildCmap(unicode: Map<number, number>): Uint8Array {
  const pairs = [...unicode].map(([gid, cp]) => [cp, gid] as const).sort((a, b) => a[0] - b[0]);
  const deduped: (readonly [number, number])[] = [];
  for (const p of pairs) if (!deduped.length || deduped[deduped.length - 1]![0] !== p[0]) deduped.push(p);
  const bmp = deduped.filter(([cp]) => cp <= 0xfffe);
  const astral = deduped.length !== bmp.length;

  // Format 4: one segment per character, plus the closing 0xFFFF segment.
  const segs = bmp.length + 1;
  const f4 = new ByteWriter();
  const log = Math.floor(Math.log2(segs));
  f4.u16(4).u16(16 + 8 * segs).u16(0).u16(segs * 2);
  f4.u16(2 * 2 ** log).u16(log).u16(segs * 2 - 2 * 2 ** log);
  for (const [cp] of bmp) f4.u16(cp);
  f4.u16(0xffff).u16(0);
  for (const [cp] of bmp) f4.u16(cp);
  f4.u16(0xffff);
  for (const [cp, gid] of bmp) f4.u16((gid - cp) & 0xffff);
  f4.u16(1);
  for (let i = 0; i < segs; i++) f4.u16(0);
  const sub4 = f4.finish();

  let sub12: Uint8Array | null = null;
  if (astral) {
    const f12 = new ByteWriter();
    f12.u16(12).u16(0).u32(16 + 12 * deduped.length).u32(0).u32(deduped.length);
    for (const [cp, gid] of deduped) f12.u32(cp).u32(cp).u32(gid);
    sub12 = f12.finish();
  }

  const w = new ByteWriter();
  const count = sub12 ? 2 : 1;
  w.u16(0).u16(count);
  const first = 4 + count * 8;
  w.u16(3).u16(1).u32(first);
  if (sub12) w.u16(3).u16(10).u32(first + sub4.length);
  w.bytes(sub4);
  if (sub12) w.bytes(sub12);
  return w.finish();
}

/** post format 3: the font-wide values, no glyph names. */
function buildPost(font: TrueTypeFont): Uint8Array {
  const w = new ByteWriter();
  const src = font.tables.get('post');
  w.u32(0x00030000);
  if (src && src.length >= 16) w.bytes(src.subarray(4, 16));
  else w.u32(0).u32(0).u32(font.fixedPitch ? 1 : 0);
  w.u32(0).u32(0).u32(0).u32(0);
  return w.finish();
}

/** A minimal name table (Windows, US English): family, subfamily, full name, PostScript name. */
function buildName(family: string, postScript: string): Uint8Array {
  const records: [number, string][] = [
    [1, family],
    [2, 'Regular'],
    [4, family],
    [6, postScript],
  ];
  const strings = new ByteWriter();
  const w = new ByteWriter();
  w.u16(0).u16(records.length).u16(6 + records.length * 12);
  for (const [id, text] of records) {
    const start = strings.length;
    for (let i = 0; i < text.length; i++) strings.u16(text.charCodeAt(i));
    w.u16(3).u16(1).u16(0x409).u16(id).u16(strings.length - start).u16(start);
  }
  w.bytes(strings.finish());
  return w.finish();
}

// ---------------------------------------------------------------- assembly

export function tableChecksum(data: Uint8Array): number {
  let sum = 0;
  const r = new ByteReader(data);
  const whole = data.length & ~3;
  for (let i = 0; i < whole; i += 4) sum = (sum + r.u32(i)) >>> 0;
  if (whole < data.length) {
    let last = 0;
    for (let i = whole; i < whole + 4; i++) last = (last << 8) | (i < data.length ? r.u8(i) : 0);
    sum = (sum + (last >>> 0)) >>> 0;
  }
  return sum;
}

/** Writes an sfnt from its tables: sorted directory, long-aligned tables, checksums and head's checkSumAdjustment. */
export function assembleFont(tables: Map<string, Uint8Array>): Uint8Array {
  const tags = [...tables.keys()].sort();
  const n = tags.length;
  const log = Math.floor(Math.log2(n));
  const w = new ByteWriter();
  w.u32(0x00010000).u16(n).u16(16 * 2 ** log).u16(log).u16(n * 16 - 16 * 2 ** log);
  let offset = 12 + n * 16;
  let headAt = -1;
  for (const tag of tags) {
    const data = tables.get(tag)!;
    if (tag === 'head') headAt = offset;
    w.latin1(tag).u32(tableChecksum(data)).u32(offset).u32(data.length);
    offset += (data.length + 3) & ~3;
  }
  for (const tag of tags) w.bytes(tables.get(tag)!).pad4();
  const out = w.finish();
  if (headAt >= 0) new DataView(out.buffer).setUint32(headAt + 8, (0xb1b0afba - tableChecksum(out)) >>> 0);
  return out;
}
