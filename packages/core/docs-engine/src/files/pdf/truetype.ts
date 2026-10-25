/**
 * A TrueType reader: just what embedding a subset in a PDF needs. Glyph
 * outlines (glyf/loca), advance widths (hhea/hmtx), the character map
 * (cmap formats 4 and 12) and the numbers a PDF font descriptor asks for
 * (head, OS/2, post, name). CFF-flavoured OpenType ('OTTO') is not
 * glyf-based and is refused, so the caller falls back to another font.
 */

import { ByteReader } from './bytes';

export interface TrueTypeFont {
  unitsPerEm: number;
  numGlyphs: number;
  /** Font-wide box, font units. */
  bbox: [number, number, number, number];
  ascent: number;
  descent: number;
  capHeight: number;
  italicAngle: number;
  fixedPitch: boolean;
  italic: boolean;
  weight: number;
  postScriptName: string;
  familyName: string;
  /** Raw tables by tag (the subsetter copies some unchanged). */
  tables: Map<string, Uint8Array>;
  /** Glyph id for a code point, 0 when the font has none. */
  glyphIndex(codePoint: number): number;
  /** Advance width, font units. */
  advance(gid: number): number;
  leftSideBearing(gid: number): number;
  /** The glyph's glyf record (empty for blank glyphs such as the space). */
  glyphData(gid: number): Uint8Array;
}

/** Parses a TrueType font (or the first font of a collection); null when it is not one we can embed. */
export function parseTrueType(bytes: Uint8Array): TrueTypeFont | null {
  try {
    return parse(bytes);
  } catch {
    return null;
  }
}

/** The table directory of the font (the first one in a collection); null when it is not TrueType. */
function readTables(r: ByteReader): Map<string, Uint8Array> | null {
  let base = 0;
  if (r.tag(0) === 'ttcf') base = r.u32(12);
  const version = r.u32(base);
  if (version !== 0x00010000 && r.tag(base) !== 'true') return null;
  const numTables = r.u16(base + 4);
  const tables = new Map<string, Uint8Array>();
  for (let i = 0; i < numTables; i++) {
    const rec = base + 12 + i * 16;
    const offset = r.u32(rec + 8);
    const length = r.u32(rec + 12);
    tables.set(r.tag(rec), r.slice(offset, offset + length));
  }
  return tables;
}

/** Vertical metrics, weight and slant from head and hhea, refined by OS/2 when the font has it. */
function styleMetrics(
  head: ByteReader,
  hhea: ByteReader,
  os2Data: Uint8Array | undefined,
): { ascent: number; descent: number; capHeight: number; weight: number; italic: boolean } {
  const macStyle = head.u16(44);
  const ascent = hhea.i16(4);
  const m = { ascent, descent: hhea.i16(6), capHeight: Math.round(ascent * 0.7), weight: macStyle & 1 ? 700 : 400, italic: (macStyle & 2) !== 0 };
  if (!os2Data || os2Data.length < 78) return m;
  const os2 = new ByteReader(os2Data);
  m.weight = os2.u16(4) || m.weight;
  const fsSelection = os2.u16(62);
  if (fsSelection & 1) m.italic = true;
  // Typo metrics when the font says to use them (USE_TYPO_METRICS), else hhea.
  if (fsSelection & 0x80) {
    m.ascent = os2.i16(68);
    m.descent = os2.i16(70);
  }
  if (os2.u16(0) >= 2 && os2Data.length >= 90) m.capHeight = os2.i16(88) || m.capHeight;
  return m;
}

/** Italic angle and fixed pitch from the post table, when the font has one. */
function postInfo(postData: Uint8Array | undefined): { italicAngle: number; fixedPitch: boolean } {
  if (!postData || postData.length < 16) return { italicAngle: 0, fixedPitch: false };
  const post = new ByteReader(postData);
  return { italicAngle: post.i32(4) / 65536, fixedPitch: post.u32(12) !== 0 };
}

function parse(bytes: Uint8Array): TrueTypeFont | null {
  const tables = readTables(new ByteReader(bytes));
  if (!tables) return null;
  const need = (tag: string): ByteReader => {
    const t = tables.get(tag);
    if (!t) throw new Error(`Missing ${tag} table`);
    return new ByteReader(t);
  };
  const head = need('head');
  const hhea = need('hhea');
  const maxp = need('maxp');
  const hmtx = need('hmtx');
  const loca = need('loca');
  const glyf = need('glyf');
  const cmap = need('cmap');
  const unitsPerEm = head.u16(18) || 1000;
  const bbox: [number, number, number, number] = [head.i16(36), head.i16(38), head.i16(40), head.i16(42)];
  const longLoca = head.i16(50) === 1;
  const numGlyphs = maxp.u16(4);
  const numHMetrics = Math.max(1, Math.min(hhea.u16(34), numGlyphs));

  const offsets = new Uint32Array(numGlyphs + 1);
  for (let g = 0; g <= numGlyphs; g++) offsets[g] = longLoca ? loca.u32(g * 4) : loca.u16(g * 2) * 2;

  const { ascent, descent, capHeight, weight, italic } = styleMetrics(head, hhea, tables.get('OS/2'));
  const { italicAngle, fixedPitch } = postInfo(tables.get('post'));

  const names = readNames(tables.get('name'));
  const lookup = cmapLookup(cmap);

  return {
    unitsPerEm,
    numGlyphs,
    bbox,
    ascent,
    descent,
    capHeight,
    italicAngle,
    fixedPitch,
    italic: italic || italicAngle !== 0,
    weight,
    postScriptName: names.postScript || names.family.replace(/[^A-Za-z0-9-]/g, '') || 'Font',
    familyName: names.family || names.postScript || 'Font',
    tables,
    glyphIndex(codePoint) {
      const g = lookup(codePoint);
      return g > 0 && g < numGlyphs ? g : 0;
    },
    advance(gid) {
      return hmtx.u16(4 * Math.min(gid, numHMetrics - 1));
    },
    leftSideBearing(gid) {
      return gid < numHMetrics ? hmtx.i16(4 * gid + 2) : hmtx.i16(4 * numHMetrics + 2 * (gid - numHMetrics));
    },
    glyphData(gid) {
      if (gid < 0 || gid >= numGlyphs) return new Uint8Array(0);
      return glyf.slice(offsets[gid]!, offsets[gid + 1]!);
    },
  };
}

// ---------------------------------------------------------------- composite glyphs

const ARG_1_AND_2_ARE_WORDS = 0x0001;
const WE_HAVE_A_SCALE = 0x0008;
const MORE_COMPONENTS = 0x0020;
const WE_HAVE_AN_X_AND_Y_SCALE = 0x0040;
const WE_HAVE_A_TWO_BY_TWO = 0x0080;

/** The components of a composite glyph: each one's glyph id and where that id sits in the record. */
export function glyphComponents(data: Uint8Array): { gid: number; at: number }[] {
  if (data.length < 10) return [];
  const r = new ByteReader(data);
  if (r.i16(0) >= 0) return [];
  const out: { gid: number; at: number }[] = [];
  let p = 10;
  for (;;) {
    const flags = r.u16(p);
    out.push({ gid: r.u16(p + 2), at: p + 2 });
    p += 4 + (flags & ARG_1_AND_2_ARE_WORDS ? 4 : 2);
    if (flags & WE_HAVE_A_SCALE) p += 2;
    else if (flags & WE_HAVE_AN_X_AND_Y_SCALE) p += 4;
    else if (flags & WE_HAVE_A_TWO_BY_TWO) p += 8;
    if (!(flags & MORE_COMPONENTS)) return out;
  }
}

// ---------------------------------------------------------------- cmap

/** A code point → glyph id function for the best Unicode subtable (format 12 preferred, then 4). */
function cmapLookup(cmap: ByteReader): (cp: number) => number {
  const count = cmap.u16(2);
  let best: { score: number; offset: number } | null = null;
  for (let i = 0; i < count; i++) {
    const platform = cmap.u16(4 + i * 8);
    const encoding = cmap.u16(6 + i * 8);
    const offset = cmap.u32(8 + i * 8);
    const format = cmap.u16(offset);
    let score = 0;
    if (format === 12 && ((platform === 3 && encoding === 10) || platform === 0)) score = 4;
    else if (format === 4 && platform === 3 && encoding === 1) score = 3;
    else if (format === 4 && platform === 0) score = 2;
    else if (format === 4 && platform === 3 && encoding === 0) score = 1;
    if (score && (!best || score > best.score)) best = { score, offset };
  }
  if (!best) return () => 0;
  return cmap.u16(best.offset) === 12 ? format12(cmap, best.offset) : format4(cmap, best.offset, best.score === 1);
}

function format4(r: ByteReader, base: number, symbol: boolean): (cp: number) => number {
  const segCount = r.u16(base + 6) / 2;
  const endAt = base + 14;
  const startAt = endAt + segCount * 2 + 2;
  const deltaAt = startAt + segCount * 2;
  const rangeAt = deltaAt + segCount * 2;
  const find = (c: number): number => {
    let lo = 0;
    let hi = segCount - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (r.u16(endAt + mid * 2) < c) lo = mid + 1;
      else hi = mid;
    }
    const start = r.u16(startAt + lo * 2);
    if (c < start || c > r.u16(endAt + lo * 2)) return 0;
    const delta = r.u16(deltaAt + lo * 2);
    const rangeOffset = r.u16(rangeAt + lo * 2);
    if (rangeOffset === 0) return (c + delta) & 0xffff;
    const g = r.u16(rangeAt + lo * 2 + rangeOffset + (c - start) * 2);
    return g ? (g + delta) & 0xffff : 0;
  };
  return (cp) => {
    if (cp > 0xffff) return 0;
    const g = find(cp);
    // Symbol fonts put their glyphs at U+F000 + the byte.
    if (!g && symbol && cp < 0x100) return find(0xf000 + cp);
    return g;
  };
}

function format12(r: ByteReader, base: number): (cp: number) => number {
  const groups = r.u32(base + 12);
  return (cp) => {
    let lo = 0;
    let hi = groups - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const g = base + 16 + mid * 12;
      if (cp < r.u32(g)) hi = mid - 1;
      else if (cp > r.u32(g + 4)) lo = mid + 1;
      else return r.u32(g + 8) + (cp - r.u32(g));
    }
    return 0;
  };
}

// ---------------------------------------------------------------- name

function readNames(data: Uint8Array | undefined): { family: string; postScript: string } {
  const out = { family: '', postScript: '' };
  if (!data) return out;
  try {
    const r = new ByteReader(data);
    const count = r.u16(2);
    const strings = r.u16(4);
    for (let i = 0; i < count; i++) {
      const rec = 6 + i * 12;
      const platform = r.u16(rec);
      const id = r.u16(rec + 6);
      if (id !== 1 && id !== 6) continue;
      const s = nameString(r, platform, strings + r.u16(rec + 10), r.u16(rec + 8));
      if (s !== null) keepName(out, id, platform, s);
    }
  } catch {
    // A broken name table only costs the font its name.
  }
  return out;
}

/** A name record's string: UTF-16BE on Unicode and Windows, single bytes on Mac; null for other platforms. */
function nameString(r: ByteReader, platform: number, off: number, len: number): string | null {
  let s = '';
  if (platform === 3 || platform === 0) for (let k = 0; k + 1 < len; k += 2) s += String.fromCharCode(r.u16(off + k));
  else if (platform === 1) for (let k = 0; k < len; k++) s += String.fromCharCode(r.u8(off + k));
  else return null;
  return s;
}

/** Takes a family (1) or PostScript (6) name, the Windows one over any other. */
function keepName(out: { family: string; postScript: string }, id: number, platform: number, s: string): void {
  if (id === 1 && (!out.family || platform === 3)) out.family = s;
  if (id === 6 && (!out.postScript || platform === 3)) out.postScript = s.replace(/[^\x21-\x7e]|[[\](){}<>/%#]/g, '');
}
