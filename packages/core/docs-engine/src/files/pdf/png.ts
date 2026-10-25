/**
 * A PNG decoder, enough to put any PNG in a PDF: every colour type, bit
 * depths 1–16, transparency (alpha channels and tRNS) and Adam7 interlacing.
 * PDF has no PNG filter of its own that handles alpha, so the image comes
 * out as 8-bit samples plus a separate 8-bit alpha plane (the PDF SMask).
 */

import { ByteReader, concatBytes } from './bytes';
import { inflate } from './zlib';

export interface DecodedImage {
  width: number;
  height: number;
  /** 1 = grey, 3 = RGB. */
  colors: 1 | 3;
  /** 8-bit samples, row by row. */
  pixels: Uint8Array;
  /** 8-bit opacity per pixel, null when the image is fully opaque. */
  alpha: Uint8Array | null;
}

/** Larger images are refused rather than risk running out of memory. */
const MAX_PIXELS = 40_000_000;

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export function isPng(bytes: Uint8Array): boolean {
  return bytes.length > 8 && SIGNATURE.every((b, i) => bytes[i] === b);
}

/** Decodes a PNG; null when it is not one or is broken. */
export async function decodePng(bytes: Uint8Array): Promise<DecodedImage | null> {
  try {
    return await decode(bytes);
  } catch {
    return null;
  }
}

const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

/** What the chunks say: the header fields, the palette and transparency, and the compressed data. */
interface PngChunks {
  width: number;
  height: number;
  depth: number;
  type: number;
  interlace: number;
  palette: Uint8Array | null;
  trns: Uint8Array | null;
  idat: Uint8Array[];
}

async function decode(bytes: Uint8Array): Promise<DecodedImage | null> {
  if (!isPng(bytes)) return null;
  const chunks = readChunks(new ByteReader(bytes));
  if (!chunks || !isSupported(chunks)) return null;
  const raw = await inflate(concatBytes(chunks.idat));
  return new PngPixels(chunks).decode(raw);
}

/** Reads the chunks up to IEND; null when the compression or filter method is not 0. */
function readChunks(r: ByteReader): PngChunks | null {
  const out: PngChunks = { width: 0, height: 0, depth: 0, type: -1, interlace: 0, palette: null, trns: null, idat: [] };
  for (let p = 8; p + 8 <= r.length; ) {
    const len = r.u32(p);
    const tag = r.tag(p + 4);
    const data = r.slice(p + 8, p + 8 + len);
    if (tag === 'IHDR') {
      if (!readHeader(r, p, out)) return null;
    } else if (tag === 'PLTE') out.palette = data;
    else if (tag === 'tRNS') out.trns = data;
    else if (tag === 'IDAT') out.idat.push(data);
    else if (tag === 'IEND') break;
    p += 12 + len;
  }
  return out;
}

/** Reads the IHDR chunk at `p` into `out`; false when the compression or filter method is not 0. */
function readHeader(r: ByteReader, p: number, out: PngChunks): boolean {
  out.width = r.u32(p + 8);
  out.height = r.u32(p + 12);
  out.depth = r.u8(p + 16);
  out.type = r.u8(p + 17);
  if (r.u8(p + 18) !== 0 || r.u8(p + 19) !== 0) return false;
  out.interlace = r.u8(p + 20);
  return true;
}

/** Whether the colour type, bit depth, size and interlace method are ones this decoder reads. */
function isSupported(h: PngChunks): boolean {
  const channels = CHANNELS[h.type];
  if (!channels || !h.width || !h.height || h.width * h.height > MAX_PIXELS || !h.idat.length) return false;
  if (![1, 2, 4, 8, 16].includes(h.depth) || (h.type === 3 && (!h.palette || h.depth === 16)) || ((h.type === 2 || h.type >= 4) && h.depth < 8)) return false;
  return h.interlace <= 1;
}

/** Turns the inflated scanlines into 8-bit samples and an alpha plane. */
class PngPixels {
  private readonly channels: number;
  private readonly colors: 1 | 3;
  private readonly pixels: Uint8Array;
  private readonly alpha: Uint8Array;
  private hasAlpha = false;
  private readonly max: number;
  private readonly bpp: number;
  /** tRNS of a grey or RGB image: the one colour that is transparent. */
  private readonly key: ByteReader | null;
  /** The current scanline, and the pixel of it being written. */
  private row = new Uint8Array(0);
  private i = 0;

  constructor(private readonly h: PngChunks) {
    this.channels = CHANNELS[h.type]!;
    this.colors = h.type === 0 || h.type === 4 ? 1 : 3;
    this.pixels = new Uint8Array(h.width * h.height * this.colors);
    this.alpha = new Uint8Array(h.width * h.height).fill(255);
    this.max = (1 << h.depth) - 1;
    this.bpp = Math.max(1, (this.channels * h.depth) >> 3);
    this.key = h.trns && h.type !== 3 ? new ByteReader(h.trns) : null;
  }

  decode(raw: Uint8Array): DecodedImage | null {
    const passes = this.h.interlace ? ADAM7 : [[0, 0, 1, 1] as const];
    let pos: number | null = 0;
    for (const pass of passes) {
      pos = this.readPass(raw, pos, pass);
      if (pos === null) return null;
    }
    const { width, height } = this.h;
    return { width, height, colors: this.colors, pixels: this.pixels, alpha: this.hasAlpha ? this.alpha : null };
  }

  /** Reads one interlace pass from `pos`; returns where the next one starts, null when the data is short or broken. */
  private readPass(raw: Uint8Array, pos: number, [x0, y0, dx, dy]: readonly [number, number, number, number]): number | null {
    const pw = Math.ceil((this.h.width - x0) / dx);
    const ph = Math.ceil((this.h.height - y0) / dy);
    if (pw <= 0 || ph <= 0) return pos;
    const rowBytes = Math.ceil((pw * this.channels * this.h.depth) / 8);
    let at = pos;
    let prev = new Uint8Array(rowBytes);
    for (let j = 0; j < ph; j++) {
      if (at + 1 + rowBytes > raw.length) return null;
      const filter = raw[at]!;
      this.row = raw.slice(at + 1, at + 1 + rowBytes);
      at += 1 + rowBytes;
      if (!unfilter(filter, this.row, prev, this.bpp)) return null;
      for (this.i = 0; this.i < pw; this.i++) this.put(x0 + this.i * dx, y0 + j * dy);
      prev = this.row;
    }
    return at;
  }

  /** Sample `c` of pixel `i` of the current scanline, at the image's bit depth. */
  private sample(c: number): number {
    const { row, i, channels } = this;
    const depth = this.h.depth;
    if (depth === 8) return row[i * channels + c]!;
    if (depth === 16) return (row[2 * (i * channels + c)]! << 8) | row[2 * (i * channels + c) + 1]!;
    const bit = i * depth;
    return (row[bit >> 3]! >> (8 - depth - (bit & 7))) & this.max;
  }

  private to8(v: number): number {
    if (this.h.depth === 16) return v >> 8;
    if (this.h.depth === 8) return v;
    return Math.round((v * 255) / this.max);
  }

  /** Writes pixel (x, y) from pixel `i` of the current scanline. */
  private put(x: number, y: number): void {
    const at = y * this.h.width + x;
    let a: number;
    if (this.h.type === 3) a = this.putIndexed(at);
    else if (this.colors === 1) a = this.putGrey(at);
    else a = this.putRgb(at);
    if (a !== 255) {
      this.alpha[at] = a;
      this.hasAlpha = true;
    }
  }

  /** Writes a palette pixel; returns its opacity. */
  private putIndexed(at: number): number {
    const pal = this.h.palette!;
    const trns = this.h.trns;
    const idx = this.sample(0);
    this.pixels[at * 3] = pal[idx * 3] ?? 0;
    this.pixels[at * 3 + 1] = pal[idx * 3 + 1] ?? 0;
    this.pixels[at * 3 + 2] = pal[idx * 3 + 2] ?? 0;
    return trns && idx < trns.length ? trns[idx]! : 255;
  }

  /** Writes a grey pixel; returns its opacity. */
  private putGrey(at: number): number {
    const key = this.key;
    const g = this.sample(0);
    this.pixels[at] = this.to8(g);
    if (this.h.type === 4) return this.to8(this.sample(1));
    return key && key.length >= 2 && g === key.u16(0) ? 0 : 255;
  }

  /** Writes an RGB pixel; returns its opacity. */
  private putRgb(at: number): number {
    const key = this.key;
    const rr = this.sample(0);
    const gg = this.sample(1);
    const bb = this.sample(2);
    this.pixels[at * 3] = this.to8(rr);
    this.pixels[at * 3 + 1] = this.to8(gg);
    this.pixels[at * 3 + 2] = this.to8(bb);
    if (this.h.type === 6) return this.to8(this.sample(3));
    return key && key.length >= 6 && rr === key.u16(0) && gg === key.u16(2) && bb === key.u16(4) ? 0 : 255;
  }
}

/** Start x, start y, step x, step y of the seven interlace passes. */
const ADAM7 = [
  [0, 0, 8, 8],
  [4, 0, 8, 8],
  [0, 4, 4, 8],
  [2, 0, 4, 4],
  [0, 2, 2, 4],
  [1, 0, 2, 2],
  [0, 1, 1, 2],
] as const;

/** Reverses a scanline's filter in place; false for an unknown filter type. */
function unfilter(filter: number, row: Uint8Array, prev: Uint8Array, bpp: number): boolean {
  switch (filter) {
    case 0:
      return true;
    case 1:
      unfilterSub(row, bpp);
      return true;
    case 2:
      unfilterUp(row, prev);
      return true;
    case 3:
      unfilterAverage(row, prev, bpp);
      return true;
    case 4:
      unfilterPaeth(row, prev, bpp);
      return true;
    default:
      return false;
  }
}

function unfilterSub(row: Uint8Array, bpp: number): void {
  for (let i = bpp; i < row.length; i++) row[i] = (row[i]! + row[i - bpp]!) & 0xff;
}

function unfilterUp(row: Uint8Array, prev: Uint8Array): void {
  for (let i = 0; i < row.length; i++) row[i] = (row[i]! + prev[i]!) & 0xff;
}

function unfilterAverage(row: Uint8Array, prev: Uint8Array, bpp: number): void {
  for (let i = 0; i < row.length; i++) row[i] = (row[i]! + (((i >= bpp ? row[i - bpp]! : 0) + prev[i]!) >> 1)) & 0xff;
}

function unfilterPaeth(row: Uint8Array, prev: Uint8Array, bpp: number): void {
  for (let i = 0; i < row.length; i++) {
    const a = i >= bpp ? row[i - bpp]! : 0;
    const b = prev[i]!;
    const c = i >= bpp ? prev[i - bpp]! : 0;
    row[i] = (row[i]! + paeth(a, b, c)) & 0xff;
  }
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}
