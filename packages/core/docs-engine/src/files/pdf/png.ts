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

async function decode(bytes: Uint8Array): Promise<DecodedImage | null> {
  if (!isPng(bytes)) return null;
  const r = new ByteReader(bytes);
  let width = 0;
  let height = 0;
  let depth = 0;
  let type = -1;
  let interlace = 0;
  let palette: Uint8Array | null = null;
  let trns: Uint8Array | null = null;
  const idat: Uint8Array[] = [];
  for (let p = 8; p + 8 <= bytes.length; ) {
    const len = r.u32(p);
    const tag = r.tag(p + 4);
    const data = r.slice(p + 8, p + 8 + len);
    if (tag === 'IHDR') {
      width = r.u32(p + 8);
      height = r.u32(p + 12);
      depth = r.u8(p + 16);
      type = r.u8(p + 17);
      if (r.u8(p + 18) !== 0 || r.u8(p + 19) !== 0) return null;
      interlace = r.u8(p + 20);
    } else if (tag === 'PLTE') palette = data;
    else if (tag === 'tRNS') trns = data;
    else if (tag === 'IDAT') idat.push(data);
    else if (tag === 'IEND') break;
    p += 12 + len;
  }
  const channels = CHANNELS[type];
  if (!channels || !width || !height || width * height > MAX_PIXELS || !idat.length) return null;
  if (![1, 2, 4, 8, 16].includes(depth) || (type === 3 && (!palette || depth === 16)) || ((type === 2 || type >= 4) && depth < 8)) return null;
  if (interlace > 1) return null;

  const raw = await inflate(concatBytes(idat));
  const colors: 1 | 3 = type === 0 || type === 4 ? 1 : 3;
  const pixels = new Uint8Array(width * height * colors);
  const alpha = new Uint8Array(width * height).fill(255);
  let hasAlpha = false;

  const max = (1 << depth) - 1;
  const bpp = Math.max(1, (channels * depth) >> 3);
  const pal = palette;
  const key = trns && type !== 3 ? new ByteReader(trns) : null;

  let row = new Uint8Array(0);
  let i = 0;
  /** Sample `c` of pixel `i` of the current scanline, at the image's bit depth. */
  const sample = (c: number): number => {
    if (depth === 8) return row[i * channels + c]!;
    if (depth === 16) return (row[2 * (i * channels + c)]! << 8) | row[2 * (i * channels + c) + 1]!;
    const bit = i * depth;
    return (row[bit >> 3]! >> (8 - depth - (bit & 7))) & max;
  };
  const to8 = (v: number): number => (depth === 16 ? v >> 8 : depth === 8 ? v : Math.round((v * 255) / max));

  /** Writes pixel (x, y) from pixel `i` of the current scanline. */
  const put = (x: number, y: number): void => {
    const at = y * width + x;
    let a = 255;
    if (type === 3) {
      const idx = sample(0);
      pixels[at * 3] = pal![idx * 3] ?? 0;
      pixels[at * 3 + 1] = pal![idx * 3 + 1] ?? 0;
      pixels[at * 3 + 2] = pal![idx * 3 + 2] ?? 0;
      if (trns && idx < trns.length) a = trns[idx]!;
    } else if (colors === 1) {
      const g = sample(0);
      pixels[at] = to8(g);
      if (type === 4) a = to8(sample(1));
      else if (key && key.length >= 2 && g === key.u16(0)) a = 0;
    } else {
      const rr = sample(0);
      const gg = sample(1);
      const bb = sample(2);
      pixels[at * 3] = to8(rr);
      pixels[at * 3 + 1] = to8(gg);
      pixels[at * 3 + 2] = to8(bb);
      if (type === 6) a = to8(sample(3));
      else if (key && key.length >= 6 && rr === key.u16(0) && gg === key.u16(2) && bb === key.u16(4)) a = 0;
    }
    if (a !== 255) {
      alpha[at] = a;
      hasAlpha = true;
    }
  };

  const passes = interlace ? ADAM7 : [[0, 0, 1, 1] as const];
  let pos = 0;
  for (const [x0, y0, dx, dy] of passes) {
    const pw = Math.ceil((width - x0) / dx);
    const ph = Math.ceil((height - y0) / dy);
    if (pw <= 0 || ph <= 0) continue;
    const rowBytes = Math.ceil((pw * channels * depth) / 8);
    let prev = new Uint8Array(rowBytes);
    for (let j = 0; j < ph; j++) {
      if (pos + 1 + rowBytes > raw.length) return null;
      const filter = raw[pos]!;
      row = raw.slice(pos + 1, pos + 1 + rowBytes);
      pos += 1 + rowBytes;
      if (!unfilter(filter, row, prev, bpp)) return null;
      for (i = 0; i < pw; i++) put(x0 + i * dx, y0 + j * dy);
      prev = row;
    }
  }
  return { width, height, colors, pixels, alpha: hasAlpha ? alpha : null };
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
  const n = row.length;
  switch (filter) {
    case 0:
      return true;
    case 1:
      for (let i = bpp; i < n; i++) row[i] = (row[i]! + row[i - bpp]!) & 0xff;
      return true;
    case 2:
      for (let i = 0; i < n; i++) row[i] = (row[i]! + prev[i]!) & 0xff;
      return true;
    case 3:
      for (let i = 0; i < n; i++) row[i] = (row[i]! + (((i >= bpp ? row[i - bpp]! : 0) + prev[i]!) >> 1)) & 0xff;
      return true;
    case 4:
      for (let i = 0; i < n; i++) {
        const a = i >= bpp ? row[i - bpp]! : 0;
        const b = prev[i]!;
        const c = i >= bpp ? prev[i - bpp]! : 0;
        row[i] = (row[i]! + paeth(a, b, c)) & 0xff;
      }
      return true;
    default:
      return false;
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
