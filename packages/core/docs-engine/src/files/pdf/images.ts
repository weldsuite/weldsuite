/**
 * Images for the PDF: JPEG goes in as it is (PDF's DCTDecode is JPEG), PNG
 * is decoded and re-compressed with Flate, its alpha as a soft mask. Other
 * formats (GIF, WebP, SVG) are not supported and come back null, and the
 * writer draws a placeholder.
 */

import { ByteReader } from './bytes';
import { decodePng, isPng, type DecodedImage } from './png';

export interface JpegInfo {
  width: number;
  height: number;
  components: 1 | 3 | 4;
  bitsPerComponent: number;
  /** An Adobe APP14 marker: CMYK data is stored inverted. */
  adobe: boolean;
}

export type PdfImage = { kind: 'jpeg'; info: JpegInfo; bytes: Uint8Array } | { kind: 'pixels'; image: DecodedImage };

export function isJpeg(bytes: Uint8Array): boolean {
  return bytes.length > 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

/** Reads a JPEG's size and colour components from its frame header; null when there is none. */
export function parseJpeg(bytes: Uint8Array): JpegInfo | null {
  if (!isJpeg(bytes)) return null;
  try {
    return scanJpeg(new ByteReader(bytes));
  } catch {
    // Truncated file.
    return null;
  }
}

/** Walks the markers up to the frame header. */
function scanJpeg(r: ByteReader): JpegInfo | null {
  let adobe = false;
  let p = 2;
  while (p + 4 <= r.length) {
    if (r.u8(p) !== 0xff) return null;
    const marker = r.u8(p + 1);
    if (marker === 0xff) {
      p++; // fill byte
      continue;
    }
    if (isStandaloneMarker(marker)) {
      p += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return null; // end of image, or scan data before any frame header
    const len = r.u16(p + 2);
    if (isAdobeSegment(r, p, marker, len)) adobe = true;
    if (isFrameHeader(marker)) return frameHeader(r, p, len, adobe);
    p += 2 + len;
  }
  return null;
}

/** TEM and RST0–RST7 / SOI: markers with no length after them. */
function isStandaloneMarker(marker: number): boolean {
  return marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8);
}

/** SOF0–SOF15, except DHT (C4), JPG (C8) and DAC (CC). */
function isFrameHeader(marker: number): boolean {
  return marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
}

function isAdobeSegment(r: ByteReader, p: number, marker: number, len: number): boolean {
  return marker === 0xee && len >= 7 && r.tag(p + 4) === 'Adob';
}

/** The frame header at `p`, whose segment is `len` bytes long. */
function frameHeader(r: ByteReader, p: number, len: number, adobe: boolean): JpegInfo | null {
  const bits = r.u8(p + 4);
  const height = r.u16(p + 5);
  const width = r.u16(p + 7);
  const components = r.u8(p + 9);
  if (!width || !height || (components !== 1 && components !== 3 && components !== 4)) return null;
  // An Adobe marker may follow the frame header.
  return { width, height, components, bitsPerComponent: bits === 12 ? 12 : 8, adobe: adobe || hasAdobeMarker(r, p + 2 + len) };
}

function hasAdobeMarker(r: ByteReader, from: number): boolean {
  let p = from;
  while (p + 4 <= r.length && r.u8(p) === 0xff) {
    const marker = r.u8(p + 1);
    if (marker === 0xda) return false;
    const len = r.u16(p + 2);
    if (marker === 0xee && len >= 7 && p + 8 <= r.length && r.tag(p + 4) === 'Adob') return true;
    p += 2 + len;
  }
  return false;
}

/** Turns image bytes into something the writer can embed, by content (not by the stated type). */
export async function readImage(bytes: Uint8Array): Promise<PdfImage | null> {
  if (isJpeg(bytes)) {
    const info = parseJpeg(bytes);
    // 12-bit JPEG is not allowed in PDF.
    return info && info.bitsPerComponent === 8 ? { kind: 'jpeg', info, bytes } : null;
  }
  if (isPng(bytes)) {
    const image = await decodePng(bytes);
    return image ? { kind: 'pixels', image } : null;
  }
  return null;
}

/** The bytes of a base64 `data:` URL, so inline images need no fetcher. */
export function dataUrlBytes(src: string): Uint8Array | null {
  const m = /^data:[^;,]*(;[^,]*)?,([\s\S]*)$/.exec(src);
  if (!m) return null;
  try {
    if (m[1]?.includes('base64')) {
      const bin = atob(m[2]!.replace(/\s+/g, ''));
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    }
    return new TextEncoder().encode(decodeURIComponent(m[2]!));
  } catch {
    return null;
  }
}
