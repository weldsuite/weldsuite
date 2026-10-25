/**
 * Test-only fixtures built byte by byte: a small TrueType font (simple and
 * composite glyphs, cmap formats 4 and 12, a short loca, a hmtx with fewer
 * metrics than glyphs), PNGs of any colour type and filter, and the
 * marker structure of a JPEG.
 */

import { ByteWriter } from './bytes';
import { assembleFont } from './subset';
import { deflate } from './zlib';

// ---------------------------------------------------------------- TrueType

export const GLYPHS = {
  notdef: 0,
  space: 1,
  omega: 2,
  zhe: 3,
  /** Only used as a component of `zhong`; no character maps to it. */
  part: 4,
  /** 中: a composite of `part` and `omega`. */
  zhong: 5,
  smile: 6,
} as const;

export const TEST_CHARS: Record<number, number> = {
  0x20: GLYPHS.space,
  0x3a9: GLYPHS.omega,
  0x416: GLYPHS.zhe,
  0x4e2d: GLYPHS.zhong,
  0x1f600: GLYPHS.smile,
};

/** Advances of glyphs 0–4; glyphs 5 and 6 repeat the last (hmtx's short form). */
export const ADVANCES = [500, 250, 700, 650, 300];

function simpleGlyph(points: [number, number][]): Uint8Array {
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  const w = new ByteWriter();
  w.i16(1).i16(Math.min(...xs)).i16(Math.min(...ys)).i16(Math.max(...xs)).i16(Math.max(...ys));
  w.u16(points.length - 1); // end point of the one contour
  w.u16(0); // no instructions
  for (let i = 0; i < points.length; i++) w.u8(0x01); // on curve, 16-bit deltas
  let x = 0;
  for (const p of points) {
    w.i16(p[0] - x);
    x = p[0];
  }
  let y = 0;
  for (const p of points) {
    w.i16(p[1] - y);
    y = p[1];
  }
  return w.finish();
}

function compositeGlyph(components: { gid: number; dx: number; dy: number }[]): Uint8Array {
  const w = new ByteWriter();
  w.i16(-1).i16(0).i16(0).i16(900).i16(700);
  components.forEach((c, i) => {
    // ARG_1_AND_2_ARE_WORDS | ARGS_ARE_XY_VALUES, plus MORE_COMPONENTS except on the last.
    w.u16(0x0003 | (i < components.length - 1 ? 0x0020 : 0));
    w.u16(c.gid);
    w.i16(c.dx).i16(c.dy);
  });
  return w.finish();
}

export function testGlyphData(): Uint8Array[] {
  return [
    simpleGlyph([
      [50, 0],
      [450, 0],
      [450, 700],
      [50, 700],
    ]),
    new Uint8Array(0),
    simpleGlyph([
      [50, 0],
      [650, 0],
      [350, 700],
    ]),
    simpleGlyph([
      [0, 0],
      [600, 0],
      [600, 600],
      [0, 600],
    ]),
    simpleGlyph([
      [0, 0],
      [200, 0],
      [100, 500],
    ]),
    compositeGlyph([
      { gid: GLYPHS.part, dx: 0, dy: 0 },
      { gid: GLYPHS.omega, dx: 200, dy: 0 },
    ]),
    simpleGlyph([
      [100, 100],
      [500, 100],
      [500, 500],
      [100, 500],
    ]),
  ];
}

/** A small valid TrueType font. With `format12` false its cmap has only format 4 (no emoji). */
export function buildTestFont(options: { format12?: boolean; postScriptName?: string } = {}): Uint8Array {
  const glyphs = testGlyphData();
  const numGlyphs = glyphs.length;
  const tables = new Map<string, Uint8Array>();

  const head = new ByteWriter();
  head.u32(0x00010000).u32(0x00010000).u32(0).u32(0x5f0f3cf5).u16(0).u16(1000);
  head.u32(0).u32(0).u32(0).u32(0); // created, modified
  head.i16(0).i16(0).i16(900).i16(700).u16(0).u16(8).i16(2).i16(0).i16(0); // bbox, macStyle, lowestRecPPEM, direction, short loca, glyph format
  tables.set('head', head.finish());

  const hhea = new ByteWriter();
  hhea.u32(0x00010000).i16(800).i16(-200).i16(0).u16(700).i16(0).i16(0).i16(900).i16(1).i16(0).i16(0);
  for (let i = 0; i < 5; i++) hhea.i16(0);
  hhea.u16(ADVANCES.length);
  tables.set('hhea', hhea.finish());

  tables.set('maxp', new ByteWriter().u32(0x00005000).u16(numGlyphs).finish());

  const hmtx = new ByteWriter();
  ADVANCES.forEach((a) => hmtx.u16(a).i16(0));
  for (let g = ADVANCES.length; g < numGlyphs; g++) hmtx.i16(0);
  tables.set('hmtx', hmtx.finish());

  const glyf = new ByteWriter();
  const loca = new ByteWriter();
  for (const g of glyphs) {
    loca.u16(glyf.length / 2);
    glyf.bytes(g);
    if (glyf.length % 2) glyf.u8(0);
  }
  loca.u16(glyf.length / 2);
  tables.set('glyf', glyf.finish());
  tables.set('loca', loca.finish());

  // Format 4: 0x20 and 0x3A9 by delta, 0x416 through the glyph id array, 0x4E2D by delta, then 0xFFFF.
  const segs: { start: number; end: number; delta: number; viaArray?: number }[] = [
    { start: 0x20, end: 0x20, delta: GLYPHS.space - 0x20 },
    { start: 0x3a9, end: 0x3a9, delta: GLYPHS.omega - 0x3a9 },
    { start: 0x416, end: 0x416, delta: 0, viaArray: GLYPHS.zhe },
    { start: 0x4e2d, end: 0x4e2d, delta: GLYPHS.zhong - 0x4e2d },
    { start: 0xffff, end: 0xffff, delta: 1 },
  ];
  const n = segs.length;
  const f4 = new ByteWriter();
  f4.u16(4).u16(16 + 8 * n + 2).u16(0).u16(n * 2).u16(8).u16(2).u16(n * 2 - 8);
  for (const s of segs) f4.u16(s.end);
  f4.u16(0);
  for (const s of segs) f4.u16(s.start);
  for (const s of segs) f4.u16(s.delta & 0xffff);
  segs.forEach((s, i) => {
    // The offset from this idRangeOffset entry to glyphIdArray[0].
    f4.u16(s.viaArray !== undefined ? (n - i) * 2 : 0);
  });
  f4.u16(segs[2]!.viaArray!);
  const sub4 = f4.finish();

  const cmap = new ByteWriter();
  const withF12 = options.format12 ?? true;
  cmap.u16(0).u16(withF12 ? 2 : 1);
  const first = 4 + (withF12 ? 2 : 1) * 8;
  cmap.u16(3).u16(1).u32(first);
  if (withF12) cmap.u16(3).u16(10).u32(first + sub4.length);
  cmap.bytes(sub4);
  if (withF12) {
    const groups = Object.entries(TEST_CHARS)
      .map(([cp, g]) => [Number(cp), g] as const)
      .sort((a, b) => a[0] - b[0]);
    cmap.u16(12).u16(0).u32(16 + 12 * groups.length).u32(0).u32(groups.length);
    for (const [cp, g] of groups) cmap.u32(cp).u32(cp).u32(g);
  }
  tables.set('cmap', cmap.finish());

  const os2 = new ByteWriter();
  os2.u16(4).i16(500).u16(400);
  while (os2.length < 62) os2.u16(0);
  os2.u16(0x40); // fsSelection: regular
  os2.u16(0x20).u16(0x4e2d); // first / last char index
  os2.i16(800).i16(-200).i16(0).u16(1000).u16(200); // typo ascender, descender, line gap, win ascent, win descent
  os2.u32(1).u32(0); // code page ranges
  os2.i16(500).i16(700).u16(0).u16(0x20).u16(0); // x-height, cap height, default char, break char, max context
  tables.set('OS/2', os2.finish());

  const post = new ByteWriter();
  post.u32(0x00030000).u32(0).i16(-100).i16(50).u32(0).u32(0).u32(0).u32(0).u32(0);
  tables.set('post', post.finish());

  const ps = options.postScriptName ?? 'TestSans-Regular';
  const nameW = new ByteWriter();
  const strings = new ByteWriter();
  const records: [number, string][] = [
    [1, 'Test Sans'],
    [6, ps],
  ];
  nameW.u16(0).u16(records.length).u16(6 + 12 * records.length);
  for (const [id, text] of records) {
    const at = strings.length;
    for (const ch of text) strings.u16(ch.charCodeAt(0));
    nameW.u16(3).u16(1).u16(0x409).u16(id).u16(strings.length - at).u16(at);
  }
  nameW.bytes(strings.finish());
  tables.set('name', nameW.finish());

  return assembleFont(tables);
}

// ---------------------------------------------------------------- PNG

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of data) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(w: ByteWriter, tag: string, data: Uint8Array): void {
  const body = new ByteWriter().latin1(tag).bytes(data).finish();
  w.u32(data.length).bytes(body).u32(crc32(body));
}

export interface PngSpec {
  width: number;
  height: number;
  /** 0 grey, 2 RGB, 3 palette, 4 grey + alpha, 6 RGBA. */
  colorType: number;
  bitDepth: number;
  /** Unfiltered scanlines (packed samples, no filter byte), one per row; for interlaced images, the passes' rows in order. */
  rows: Uint8Array[];
  /** Filter type per row (default 0). */
  filters?: number[];
  palette?: Uint8Array;
  trns?: Uint8Array;
  interlace?: boolean;
}

/** Encodes a PNG, applying each row's filter for real so decoding exercises it. */
export async function makePng(spec: PngSpec): Promise<Uint8Array> {
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[spec.colorType as 0 | 2 | 3 | 4 | 6];
  const bpp = Math.max(1, (channels * spec.bitDepth) >> 3);
  const raw = new ByteWriter();
  let prev: Uint8Array | null = null;
  spec.rows.forEach((row, i) => {
    const f = spec.filters?.[i] ?? 0;
    // A new pass of an interlaced image starts with an empty previous row.
    const up = prev && prev.length === row.length ? prev : new Uint8Array(row.length);
    raw.u8(f);
    for (let k = 0; k < row.length; k++) {
      const a = k >= bpp ? row[k - bpp]! : 0;
      const b = up[k]!;
      const c = k >= bpp ? up[k - bpp]! : 0;
      let pred = 0;
      if (f === 1) pred = a;
      else if (f === 2) pred = b;
      else if (f === 3) pred = (a + b) >> 1;
      else if (f === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      raw.u8((row[k]! - pred) & 0xff);
    }
    prev = row;
  });
  const w = new ByteWriter();
  w.bytes(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  chunk(w, 'IHDR', new ByteWriter().u32(spec.width).u32(spec.height).u8(spec.bitDepth).u8(spec.colorType).u8(0).u8(0).u8(spec.interlace ? 1 : 0).finish());
  if (spec.palette) chunk(w, 'PLTE', spec.palette);
  if (spec.trns) chunk(w, 'tRNS', spec.trns);
  const z = await deflate(raw.finish());
  // Split the data over two IDAT chunks, as encoders may.
  const half = z.length >> 1;
  chunk(w, 'IDAT', z.subarray(0, half));
  chunk(w, 'IDAT', z.subarray(half));
  chunk(w, 'IEND', new Uint8Array(0));
  return w.finish();
}

// ---------------------------------------------------------------- JPEG

/**
 * The marker structure of a baseline JPEG (SOI, APP0, DQT, SOF0, DHT, SOS,
 * EOI) with the given size: enough for the frame-header parser. The scan
 * data is filler, so a viewer would not decode the picture.
 */
export function makeJpeg(width: number, height: number, components: 1 | 3 | 4, adobe = false): Uint8Array {
  const w = new ByteWriter();
  w.u16(0xffd8);
  w.u16(0xffe0).u16(16).latin1('JFIF\0').u8(1).u8(1).u8(0).u16(72).u16(72).u8(0).u8(0);
  if (adobe) w.u16(0xffee).u16(14).latin1('Adobe').u16(100).u16(0).u16(0).u8(2);
  w.u16(0xffdb).u16(67).u8(0);
  for (let i = 0; i < 64; i++) w.u8(1);
  w.u16(0xffc0).u16(8 + 3 * components).u8(8).u16(height).u16(width).u8(components);
  for (let c = 0; c < components; c++) w.u8(c + 1).u8(0x11).u8(0);
  w.u16(0xffc4).u16(20).u8(0);
  for (let i = 0; i < 16; i++) w.u8(i === 0 ? 1 : 0);
  w.u8(0);
  w.u16(0xffda).u16(6 + 2 * components).u8(components);
  for (let c = 0; c < components; c++) w.u8(c + 1).u8(0);
  w.u8(0).u8(63).u8(0);
  w.u8(0x00).u8(0x3f).u8(0xff).u8(0x00);
  w.u16(0xffd9);
  return w.finish();
}
