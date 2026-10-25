/**
 * PDF file syntax: numbered objects, streams, the cross-reference table and
 * the trailer. Objects can be reserved before they are written (a page
 * points at its resources before the fonts in them are finished), and the
 * file is assembled at the end, so every xref offset is exact.
 */

import { ByteWriter, concatBytes, hex2, latin1 } from './bytes';
import { deflate } from './zlib';

/** An indirect reference. */
export function ref(n: number): string {
  return `${n} 0 R`;
}

/** A number as PDF writes it: no exponent, at most four decimals. */
export function num(n: number): string {
  if (!Number.isFinite(n)) return '0';
  const s = (Math.round(n * 10000) / 10000).toString();
  if (!s.includes('e')) return s === '-0' ? '0' : s;
  return trimZeros(n.toFixed(4));
}

/** `s` without its trailing zeros, and without the decimal point before them when there is one. */
function trimZeros(s: string): string {
  let end = s.length;
  while (end > 0 && s[end - 1] === '0') end--;
  if (end === s.length) return s;
  if (s[end - 1] === '.') end--;
  return s.slice(0, end);
}

/** What a literal string escapes, and how. */
const LITERAL_ESCAPES: Record<string, string> = { '\\': '\\\\', '(': '\\(', ')': '\\)', '\r': '\\r', '\n': '\\n' };

/** A name (`/Helvetica`), with delimiters and non-printing characters escaped. */
export function name(s: string): string {
  let out = '/';
  for (const b of new TextEncoder().encode(s)) {
    out += b < 0x21 || b > 0x7e || '#()<>[]{}/%'.includes(String.fromCharCode(b)) ? `#${hex2(b)}` : String.fromCharCode(b);
  }
  return out;
}

/** A literal string of bytes (characters 0–255), escaping what the syntax needs. */
export function literal(bytes: string): string {
  return `(${bytes.replace(/[\\()\r\n]/g, (c) => LITERAL_ESCAPES[c]!)})`;
}

/** A text string (document info, bookmarks): plain when ASCII, else UTF-16BE with a byte order mark. */
export function textString(s: string): string {
  if (/^[\x20-\x7e]*$/.test(s)) return literal(s);
  let hex = 'FEFF';
  for (let i = 0; i < s.length; i++) hex += s.charCodeAt(i).toString(16).padStart(4, '0').toUpperCase();
  return `<${hex}>`;
}

/** A PDF date, `D:YYYYMMDDHHmmSSZ` in UTC. */
export function pdfDate(d: Date): string {
  const p = (n: number, w = 2): string => String(n).padStart(w, '0');
  return `D:${p(d.getUTCFullYear(), 4)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

export class PdfWriter {
  private readonly objects: (Uint8Array | undefined)[] = [];

  /** Reserves an object number to write later. */
  alloc(): number {
    this.objects.push(undefined);
    return this.objects.length;
  }

  set(n: number, body: string | Uint8Array): void {
    this.objects[n - 1] = typeof body === 'string' ? latin1(body) : body;
  }

  add(body: string | Uint8Array): number {
    const n = this.alloc();
    this.set(n, body);
    return n;
  }

  /**
   * A stream object. `dict` is the dictionary's inside without /Length
   * (and without /Filter when `compress` is on, which adds FlateDecode).
   */
  async stream(dict: string, data: Uint8Array, options: { compress?: boolean; n?: number } = {}): Promise<number> {
    const compress = options.compress ?? true;
    const body = compress ? await deflate(data) : data;
    const head = `<< ${dict}${compress ? ' /Filter /FlateDecode' : ''} /Length ${body.length} >>\nstream\n`;
    const n = options.n ?? this.alloc();
    this.set(n, concatBytes([latin1(head), body, latin1('\nendstream')]));
    return n;
  }

  /** The finished file. */
  finish(root: number, info: number): Uint8Array {
    const w = new ByteWriter(64 * 1024);
    // The comment's high bytes tell transfer tools the file is binary.
    w.latin1('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n');
    const offsets: number[] = [];
    this.objects.forEach((body, i) => {
      offsets.push(w.length);
      w.latin1(`${i + 1} 0 obj\n`);
      w.bytes(body ?? latin1('null'));
      w.latin1('\nendobj\n');
    });
    const xref = w.length;
    const size = this.objects.length + 1;
    w.latin1(`xref\n0 ${size}\n0000000000 65535 f \n`);
    for (const o of offsets) w.latin1(`${String(o).padStart(10, '0')} 00000 n \n`);
    const id = fileId(w.finish());
    w.latin1(`trailer\n<< /Size ${size} /Root ${ref(root)} /Info ${ref(info)} /ID [<${id}> <${id}>] >>\nstartxref\n${xref}\n%%EOF\n`);
    return w.finish();
  }
}

/** A 16-byte file identifier from the content (FNV-1a with four seeds; it only has to differ between files). */
function fileId(bytes: Uint8Array): string {
  let a = 0x811c9dc5;
  let b = 0x01000193;
  let c = 0x9e3779b9;
  let d = 0x85ebca6b;
  for (let i = 0; i < bytes.length; i++) {
    const x = bytes[i]!;
    a = Math.imul(a ^ x, 0x01000193);
    b = Math.imul(b ^ x, 0x01000193);
    c = Math.imul(c ^ x, 0x01000193);
    d = Math.imul(d ^ x, 0x01000193);
  }
  return [a, b, c, d].map((h) => (h >>> 0).toString(16).padStart(8, '0').toUpperCase()).join('');
}
