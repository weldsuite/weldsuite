/**
 * Byte helpers shared by the PDF writer, the TrueType parser and subsetter,
 * and the image decoders: a growable big-endian writer, a bounds-checked
 * reader, and Latin-1 conversion (PDF syntax is bytes, not UTF-8).
 */

/** Appends big-endian values to a buffer that grows as needed. */
export class ByteWriter {
  private buf: Uint8Array;
  length = 0;

  constructor(capacity = 1024) {
    this.buf = new Uint8Array(capacity);
  }

  private ensure(extra: number): void {
    const need = this.length + extra;
    if (need <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < need) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buf.subarray(0, this.length));
    this.buf = next;
  }

  bytes(data: Uint8Array): this {
    this.ensure(data.length);
    this.buf.set(data, this.length);
    this.length += data.length;
    return this;
  }

  u8(v: number): this {
    this.ensure(1);
    this.buf[this.length++] = v & 0xff;
    return this;
  }

  u16(v: number): this {
    this.ensure(2);
    this.buf[this.length++] = (v >>> 8) & 0xff;
    this.buf[this.length++] = v & 0xff;
    return this;
  }

  /** Signed values are written as their two's complement, which `u16` already does. */
  i16(v: number): this {
    return this.u16(v & 0xffff);
  }

  u32(v: number): this {
    this.ensure(4);
    this.buf[this.length++] = (v >>> 24) & 0xff;
    this.buf[this.length++] = (v >>> 16) & 0xff;
    this.buf[this.length++] = (v >>> 8) & 0xff;
    this.buf[this.length++] = v & 0xff;
    return this;
  }

  /** Characters 0–255 as single bytes. */
  latin1(s: string): this {
    this.ensure(s.length);
    for (let i = 0; i < s.length; i++) this.buf[this.length++] = s.charCodeAt(i) & 0xff;
    return this;
  }

  setU16(at: number, v: number): void {
    this.buf[at] = (v >>> 8) & 0xff;
    this.buf[at + 1] = v & 0xff;
  }

  setU32(at: number, v: number): void {
    this.buf[at] = (v >>> 24) & 0xff;
    this.buf[at + 1] = (v >>> 16) & 0xff;
    this.buf[at + 2] = (v >>> 8) & 0xff;
    this.buf[at + 3] = v & 0xff;
  }

  /** Zero bytes up to the next multiple of 4 (TrueType tables are long-aligned). */
  pad4(): this {
    while (this.length % 4) this.u8(0);
    return this;
  }

  finish(): Uint8Array {
    return this.buf.slice(0, this.length);
  }
}

/** Reads big-endian values; out-of-range reads throw, so a truncated file fails cleanly. */
export class ByteReader {
  private readonly view: DataView;

  constructor(readonly data: Uint8Array) {
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  }

  get length(): number {
    return this.data.length;
  }

  u8(o: number): number {
    return this.view.getUint8(o);
  }

  u16(o: number): number {
    return this.view.getUint16(o);
  }

  i16(o: number): number {
    return this.view.getInt16(o);
  }

  u32(o: number): number {
    return this.view.getUint32(o);
  }

  i32(o: number): number {
    return this.view.getInt32(o);
  }

  /** Four ASCII characters (a TrueType table tag). */
  tag(o: number): string {
    return String.fromCharCode(this.u8(o), this.u8(o + 1), this.u8(o + 2), this.u8(o + 3));
  }

  slice(from: number, to: number): Uint8Array {
    if (from < 0 || to > this.data.length || from > to) throw new RangeError('Read past the end of the data');
    return this.data.subarray(from, to);
  }
}

/** A string of characters 0–255 as bytes. */
export function latin1(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

/** Bytes as a string of characters 0–255. */
export function fromLatin1(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return s;
}

export function concatBytes(parts: Uint8Array[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export function hex2(n: number): string {
  return (n & 0xff).toString(16).padStart(2, '0').toUpperCase();
}

export function hex4(n: number): string {
  return (n & 0xffff).toString(16).padStart(4, '0').toUpperCase();
}
