/**
 * Just enough XML for SpreadsheetML: a streaming scanner for the large parts
 * (worksheets, shared strings), a small element tree built on it for the
 * rest, and escaping for the writer.
 *
 * Element and attribute names are reduced to their local part ("x:c" → "c"),
 * since producers differ in the prefixes they pick. Namespace declarations
 * are dropped. A DOCTYPE is skipped, never expanded, so no entity in a file
 * can reach outside it or grow without bound.
 */

export type XmlAttrs = Record<string, string>;

export interface XmlHandler {
  open?(name: string, attrs: XmlAttrs, selfClosing: boolean): void;
  close?(name: string): void;
  text?(text: string): void;
}

export class XmlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'XmlError';
  }
}

const LT = 60;
const GT = 62;
const QUOTE = 34;
const APOS = 39;
const SLASH = 47;

/** Walks `xml`, calling the handler for each tag and each run of text. */
export function scanXml(xml: string, handler: XmlHandler): void {
  const len = xml.length;
  let i = 0;
  while (i < len) {
    const lt = xml.indexOf('<', i);
    if (lt < 0) {
      emitText(xml.slice(i), handler);
      return;
    }
    if (lt > i) emitText(xml.slice(i, lt), handler);
    i = scanMarkup(xml, lt, handler);
  }
}

/** Handles the markup starting at `lt`; returns where scanning continues. */
function scanMarkup(xml: string, lt: number, handler: XmlHandler): number {
  if (xml.startsWith('<!--', lt)) return skipPast(xml, lt, '-->');
  if (xml.startsWith('<![CDATA[', lt)) {
    const end = xml.indexOf(']]>', lt);
    if (end < 0) throw new XmlError('Unclosed CDATA section');
    handler.text?.(xml.slice(lt + 9, end));
    return end + 3;
  }
  if (xml.startsWith('<?', lt)) return skipPast(xml, lt, '?>');
  if (xml.startsWith('<!', lt)) return skipDeclaration(xml, lt);
  const gt = tagEnd(xml, lt);
  if (xml.charCodeAt(lt + 1) === SLASH) {
    handler.close?.(localName(xml.slice(lt + 2, gt).trim()));
    return gt + 1;
  }
  const selfClosing = xml.charCodeAt(gt - 1) === SLASH;
  const body = xml.slice(lt + 1, selfClosing ? gt - 1 : gt);
  const space = body.search(/\s/);
  const name = localName(space < 0 ? body : body.slice(0, space));
  handler.open?.(name, space < 0 ? {} : parseAttrs(body.slice(space)), selfClosing);
  if (selfClosing) handler.close?.(name);
  return gt + 1;
}

function emitText(raw: string, handler: XmlHandler): void {
  if (handler.text) handler.text(raw.includes('&') ? decodeEntities(raw) : raw);
}

function skipPast(xml: string, from: number, marker: string): number {
  const end = xml.indexOf(marker, from);
  if (end < 0) throw new XmlError(`Unclosed ${marker}`);
  return end + marker.length;
}

/** Skips `<!DOCTYPE …>`, including an internal subset in brackets. */
function skipDeclaration(xml: string, lt: number): number {
  let depth = 0;
  for (let j = lt + 2; j < xml.length; j++) {
    const ch = xml[j];
    if (ch === '[') depth++;
    else if (ch === ']') depth--;
    else if (ch === '>' && depth <= 0) return j + 1;
  }
  throw new XmlError('Unclosed declaration');
}

/** The '>' ending the tag at `lt`, skipping any inside quoted attribute values. */
function tagEnd(xml: string, lt: number): number {
  let j = lt + 1;
  while (j < xml.length) {
    const c = xml.charCodeAt(j);
    if (c === GT) return j;
    if (c === LT) break;
    if (c === QUOTE || c === APOS) {
      const close = xml.indexOf(c === QUOTE ? '"' : "'", j + 1);
      if (close < 0) break;
      j = close + 1;
    } else {
      j++;
    }
  }
  throw new XmlError(`Unclosed tag at ${lt}`);
}

/** `name="value"` pairs (either quote), in the text after a tag's name. */
function parseAttrs(text: string): XmlAttrs {
  const attrs: XmlAttrs = {};
  let i = 0;
  while (i < text.length) {
    const eq = text.indexOf('=', i);
    if (eq < 0) break;
    let q = eq + 1;
    while (q < text.length && /\s/.test(text[q]!)) q++;
    const quote = text[q];
    if (quote !== '"' && quote !== "'") break;
    const end = text.indexOf(quote, q + 1);
    if (end < 0) break;
    setAttr(attrs, text.slice(i, eq).trim(), text.slice(q + 1, end));
    i = end + 1;
  }
  return attrs;
}

function setAttr(attrs: XmlAttrs, full: string, raw: string): void {
  if (full === 'xmlns' || full.startsWith('xmlns:')) return;
  const value = raw.includes('&') ? decodeEntities(raw) : raw;
  const local = localName(full);
  // An unprefixed attribute wins over a prefixed one with the same local name.
  if (local === full || !(local in attrs)) attrs[local] = value;
}

export function localName(name: string): string {
  const colon = name.indexOf(':');
  return colon < 0 ? name : name.slice(colon + 1);
}

const NAMED: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (whole, ref: string) => {
    if (ref[0] !== '#') return NAMED[ref] ?? whole;
    const code = ref[1] === 'x' || ref[1] === 'X' ? Number.parseInt(ref.slice(2), 16) : Number.parseInt(ref.slice(1), 10);
    return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
  });
}

// ---------------------------------------------------------------------------
// Element tree (for the small parts)
// ---------------------------------------------------------------------------

export interface XmlElement {
  name: string;
  attrs: XmlAttrs;
  children: XmlElement[];
  /** Text directly inside this element (not its children's). */
  text: string;
}

/** The document's root element. */
export function parseXml(xml: string): XmlElement {
  const root: XmlElement = { name: '#document', attrs: {}, children: [], text: '' };
  const stack: XmlElement[] = [root];
  scanXml(xml, {
    open(name, attrs) {
      const el: XmlElement = { name, attrs, children: [], text: '' };
      stack[stack.length - 1]!.children.push(el);
      stack.push(el);
    },
    close() {
      if (stack.length > 1) stack.pop();
    },
    text(text) {
      stack[stack.length - 1]!.text += text;
    },
  });
  const first = root.children[0];
  if (!first) throw new XmlError('The part has no root element');
  return first;
}

export function child(el: XmlElement | undefined, name: string): XmlElement | undefined {
  return el?.children.find((c) => c.name === name);
}

export function childrenOf(el: XmlElement | undefined, name: string): XmlElement[] {
  return el ? el.children.filter((c) => c.name === name) : [];
}

/** Text of a string item: its own `t`, or its runs' `t`s, leaving out phonetic runs (`rPh`). */
export function stringItemText(el: XmlElement): string {
  let out = '';
  for (const c of el.children) {
    if (c.name === 't') out += c.text;
    else if (c.name === 'r') out += child(c, 't')?.text ?? '';
  }
  return decodeEscapes(out);
}

/** SpreadsheetML writes characters XML cannot hold as `_xHHHH_` (and a literal `_x…_` as `_x005F_x…_`). */
export function decodeEscapes(text: string): string {
  if (!text.includes('_x')) return text;
  return text.replace(/_x([0-9a-fA-F]{4})_/g, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/** Escapes text for element content or a double-quoted attribute. */
export function esc(text: string): string {
  return text.replace(/[&<>"]/g, (ch) => {
    if (ch === '&') return '&amp;';
    if (ch === '<') return '&lt;';
    return ch === '>' ? '&gt;' : '&quot;';
  });
}

/**
 * Cell text for a `t` element: control characters XML cannot carry become
 * `_xHHHH_`, and text that already looks like an escape is protected.
 */
export function escCellText(text: string): string {
  const protectedText = text.replace(/_x([0-9a-fA-F]{4})_/g, '_x005F_x$1_');
  let out = '';
  let from = 0;
  for (let i = 0; i < protectedText.length; i++) {
    const code = protectedText.charCodeAt(i);
    if (!isXmlUnsafe(code)) continue;
    out += `${protectedText.slice(from, i)}_x${code.toString(16).toUpperCase().padStart(4, '0')}_`;
    from = i + 1;
  }
  return esc(from === 0 ? protectedText : out + protectedText.slice(from));
}

/** Characters XML 1.0 cannot contain (tab, newline and carriage return it can). */
function isXmlUnsafe(code: number): boolean {
  return (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) || code === 0xfffe || code === 0xffff;
}

/** `name="value"` pairs for the attributes that are set. */
export function attrs(values: Record<string, string | number | boolean | undefined | null>): string {
  let out = '';
  for (const [k, v] of Object.entries(values)) {
    if (v === undefined || v === null || v === false) continue;
    out += ` ${k}="${v === true ? '1' : esc(String(v))}"`;
  }
  return out;
}

export const XML_HEADER = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
