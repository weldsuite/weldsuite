/**
 * Test-only: a small PDF reader, to check what `exportPdf` wrote without
 * trusting the writer. It reads the classic xref table and trailer, parses
 * objects (dictionaries, arrays, names, strings, numbers, references,
 * streams), inflates Flate streams, and lists the text a content stream
 * shows. Not for production use.
 */

import { fromLatin1 } from './bytes';
import { inflate } from './zlib';

export class PdfName {
  constructor(readonly name: string) {}
}

export class PdfString {
  /** Characters 0–255. */
  constructor(readonly bytes: string) {}
}

export class PdfRef {
  constructor(readonly n: number) {}
}

export class PdfDict {
  constructor(readonly entries: Map<string, PdfValue>) {}

  get(key: string): PdfValue | undefined {
    return this.entries.get(key);
  }
}

export type PdfValue = number | boolean | null | PdfName | PdfString | PdfRef | PdfDict | PdfValue[];

export interface PdfObject {
  value: PdfValue;
  /** Raw (still encoded) stream data. */
  stream?: Uint8Array;
}

const WS = /[\0\t\n\f\r ]/;
const DELIM = /[()<>[\]{}/%]/;

/** Where a name or operator that starts at `p` ends: at whitespace, a delimiter or the end. */
function tokenEnd(t: string, p: number): number {
  let q = p;
  while (q < t.length && !WS.test(t[q]!) && !DELIM.test(t[q]!)) q++;
  return q;
}

/** PDF object syntax over a string of characters 0–255. */
class Syntax {
  constructor(readonly text: string) {}

  skip(p: number): number {
    const t = this.text;
    for (;;) {
      while (p < t.length && WS.test(t[p]!)) p++;
      if (t[p] !== '%') return p;
      while (p < t.length && t[p] !== '\n' && t[p] !== '\r') p++;
    }
  }

  parse(start: number): { value: PdfValue; end: number } {
    const t = this.text;
    const p = this.skip(start);
    const c = t[p];
    if (t.startsWith('<<', p)) return this.dictionary(p);
    if (c === '<') return this.hexString(p);
    if (c === '[') return this.array(p);
    if (c === '(') return this.literal(p);
    if (c === '/') return this.name(p);
    return this.scalar(p);
  }

  private dictionary(start: number): { value: PdfDict; end: number } {
    const t = this.text;
    const entries = new Map<string, PdfValue>();
    let p = start + 2;
    for (;;) {
      p = this.skip(p);
      if (t.startsWith('>>', p)) return { value: new PdfDict(entries), end: p + 2 };
      const key = this.parse(p);
      if (!(key.value instanceof PdfName)) throw new Error(`Dictionary key expected at ${p}`);
      const val = this.parse(key.end);
      entries.set(key.value.name, val.value);
      p = val.end;
    }
  }

  private hexString(p: number): { value: PdfString; end: number } {
    const t = this.text;
    const end = t.indexOf('>', p);
    const hex = t.slice(p + 1, end).replace(/\s+/g, '');
    let s = '';
    for (let i = 0; i < hex.length; i += 2) s += String.fromCharCode(parseInt(hex.slice(i, i + 2).padEnd(2, '0'), 16));
    return { value: new PdfString(s), end: end + 1 };
  }

  private array(start: number): { value: PdfValue[]; end: number } {
    const t = this.text;
    const arr: PdfValue[] = [];
    let p = start + 1;
    for (;;) {
      p = this.skip(p);
      if (t[p] === ']') return { value: arr, end: p + 1 };
      const v = this.parse(p);
      arr.push(v.value);
      p = v.end;
    }
  }

  private name(p: number): { value: PdfName; end: number } {
    const t = this.text;
    const q = tokenEnd(t, p + 1);
    const raw = t.slice(p + 1, q).replace(/#([0-9a-fA-F]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
    return { value: new PdfName(raw), end: q };
  }

  /** A boolean, null, a number, or a reference (`n 0 R`). */
  private scalar(p: number): { value: PdfValue; end: number } {
    const t = this.text;
    for (const [word, value] of [
      ['true', true],
      ['false', false],
      ['null', null],
    ] as const) {
      if (t.startsWith(word, p)) return { value, end: p + word.length };
    }
    const m = /^[+-]?(\d+\.?\d*|\.\d+)/.exec(t.slice(p, p + 40));
    if (!m) throw new Error(`Unexpected ${JSON.stringify(t.slice(p, p + 10))} at ${p}`);
    const n = Number(m[0]);
    const after = p + m[0].length;
    const r = /^\s+(\d+)\s+R(?![A-Za-z])/.exec(t.slice(after, after + 20));
    if (Number.isInteger(n) && r) return { value: new PdfRef(n), end: after + r[0].length };
    return { value: n, end: after };
  }

  private literal(start: number): { value: PdfString; end: number } {
    const t = this.text;
    const esc: Record<string, string> = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '(': '(', ')': ')', '\\': '\\' };
    let p = start + 1;
    let depth = 1;
    let s = '';
    while (p < t.length) {
      const c = t[p]!;
      if (c === '\\') {
        const n = t[p + 1]!;
        if (esc[n] !== undefined) {
          s += esc[n];
          p += 2;
        } else if (/[0-7]/.test(n)) {
          const oct = /^[0-7]{1,3}/.exec(t.slice(p + 1, p + 4))![0];
          s += String.fromCharCode(parseInt(oct, 8));
          p += 1 + oct.length;
        } else p += 2;
        continue;
      }
      if (c === '(') depth++;
      if (c === ')' && --depth === 0) return { value: new PdfString(s), end: p + 1 };
      s += c;
      p++;
    }
    throw new Error('Unterminated string');
  }
}

export class PdfReader {
  readonly text: string;
  private readonly syntax: Syntax;
  /** Byte offset of each object, by number (index 0 unused). */
  readonly offsets: number[] = [];
  readonly trailer: PdfDict;
  readonly startxref: number;

  constructor(readonly bytes: Uint8Array) {
    this.text = fromLatin1(bytes);
    this.syntax = new Syntax(this.text);
    const sx = this.text.lastIndexOf('startxref');
    if (sx < 0) throw new Error('No startxref');
    this.startxref = parseInt(this.text.slice(sx + 9).trim(), 10);
    let p = this.startxref;
    if (!this.text.startsWith('xref', p)) throw new Error('startxref does not point at an xref table');
    p += 4;
    const trailerAt = this.text.indexOf('trailer', p);
    const lines = this.text.slice(p, trailerAt).trim().split(/\r?\n/);
    let i = 0;
    while (i < lines.length) {
      const [start, count] = lines[i]!.trim().split(/\s+/).map(Number);
      i++;
      for (let k = 0; k < count!; k++, i++) {
        const [off, , kind] = lines[i]!.trim().split(/\s+/);
        if (kind === 'n') this.offsets[start! + k] = Number(off);
      }
    }
    const t = this.syntax.parse(trailerAt + 7);
    if (!(t.value instanceof PdfDict)) throw new Error('Bad trailer');
    this.trailer = t.value;
  }

  object(n: number): PdfObject {
    const off = this.offsets[n];
    if (off === undefined) throw new Error(`No object ${n}`);
    const head = `${n} 0 obj`;
    if (!this.text.startsWith(head, off)) throw new Error(`Object ${n} is not at its xref offset`);
    const { value, end } = this.syntax.parse(off + head.length);
    let p = this.syntax.skip(end);
    if (this.text.startsWith('stream', p) && value instanceof PdfDict) {
      p += 6;
      if (this.text[p] === '\r') p++;
      if (this.text[p] === '\n') p++;
      const length = this.resolve(value.get('Length'));
      if (typeof length !== 'number') throw new Error('Stream without a length');
      const after = this.syntax.skip(p + length);
      if (!this.text.startsWith('endstream', after)) throw new Error(`Object ${n}: /Length does not end at endstream`);
      return { value, stream: this.bytes.subarray(p, p + length) };
    }
    if (!this.text.startsWith('endobj', p)) throw new Error(`Object ${n} does not end with endobj`);
    return { value };
  }

  resolve(v: PdfValue | undefined): PdfValue | undefined {
    return v instanceof PdfRef ? this.object(v.n).value : v;
  }

  dict(v: PdfValue | undefined): PdfDict {
    const d = this.resolve(v);
    if (!(d instanceof PdfDict)) throw new Error('Expected a dictionary');
    return d;
  }

  /** Decoded stream data of an object (Flate inflated). */
  async streamOf(n: number): Promise<Uint8Array> {
    const obj = this.object(n);
    if (!obj.stream || !(obj.value instanceof PdfDict)) throw new Error(`Object ${n} is not a stream`);
    const filter = obj.value.get('Filter');
    return filter instanceof PdfName && filter.name === 'FlateDecode' ? inflate(obj.stream) : obj.stream;
  }

  /** Page dictionaries in order, with their object numbers. */
  pages(): { n: number; dict: PdfDict }[] {
    const out: { n: number; dict: PdfDict }[] = [];
    const root = this.dict(this.trailer.get('Root'));
    const walk = (r: PdfValue | undefined): void => {
      if (!(r instanceof PdfRef)) throw new Error('Page tree entries must be references');
      const d = this.dict(r);
      const type = d.get('Type');
      if (type instanceof PdfName && type.name === 'Pages') {
        const kids = d.get('Kids');
        if (Array.isArray(kids)) for (const k of kids) walk(k);
      } else out.push({ n: r.n, dict: d });
    };
    walk(root.get('Pages'));
    return out;
  }

  /** Every object number the xref lists. */
  objectNumbers(): number[] {
    const out: number[] = [];
    this.offsets.forEach((o, n) => {
      if (o !== undefined) out.push(n);
    });
    return out;
  }
}

export interface ShownText {
  /** The string's bytes (WinAnsi codes, or two-byte CIDs). */
  text: string;
  font: string;
  size: number;
  /** Text matrix origin from the latest `Tm`. */
  x: number;
  y: number;
}

/** Text shown by `Tj` and `TJ` operators, one entry per operator (enough for content written as BT … Tm … TJ ET). */
export function shownStrings(content: string): ShownText[] {
  const syntax = new Syntax(content);
  const state = new TextOperators();
  let operands: PdfValue[] = [];
  let p = 0;
  for (;;) {
    p = syntax.skip(p);
    if (p >= content.length) return state.out;
    if (/[[(</+\-.\d]/.test(content[p]!)) {
      const v = syntax.parse(p);
      operands.push(v.value);
      p = v.end;
      continue;
    }
    // An operator is at least one character, even a stray delimiter.
    const end = Math.max(tokenEnd(content, p), p + 1);
    state.apply(content.slice(p, end), operands);
    p = end;
    operands = [];
  }
}

/** The text state `shownStrings` tracks (font, size, matrix origin) and the text it has seen shown. */
class TextOperators {
  readonly out: ShownText[] = [];
  private font = '';
  private size = 0;
  private x = 0;
  private y = 0;

  apply(op: string, operands: PdfValue[]): void {
    if (op === 'Tf') {
      const f = operands[0];
      this.font = f instanceof PdfName ? f.name : '';
      this.size = Number(operands[1]);
    } else if (op === 'Tm') {
      this.x = Number(operands[4]);
      this.y = Number(operands[5]);
    } else if (op === 'Tj' || op === 'TJ') {
      const v = operands[0];
      let text = '';
      for (const part of Array.isArray(v) ? v : [v]) if (part instanceof PdfString) text += part.bytes;
      this.out.push({ text, font: this.font, size: this.size, x: this.x, y: this.y });
    }
  }
}
