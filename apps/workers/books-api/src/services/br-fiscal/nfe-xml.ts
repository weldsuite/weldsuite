/**
 * Reading a received NF-e (layout 4.00): a small, dependency-free XML reader
 * and the extraction of what a purchase needs: access key, issuer, number,
 * date, total, items with their ICMS / IPI / PIS / COFINS, installments.
 *
 * The reader handles what NF-e files contain (elements, attributes, text,
 * CDATA, the five predefined entities and numeric character references) and
 * ignores the rest. DOCTYPEs and custom entities are never expanded, so a
 * hostile file cannot make it read or allocate more than its own size.
 */

export interface XmlNode {
  /** Local name, without the namespace prefix. */
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  text: string;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decode(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith('#x')) return String.fromCodePoint(Number.parseInt(body.slice(2), 16));
    if (body.startsWith('#')) return String.fromCodePoint(Number.parseInt(body.slice(1), 10));
    return ENTITIES[body] ?? whole;
  });
}

function localName(name: string): string {
  const colon = name.indexOf(':');
  return colon === -1 ? name : name.slice(colon + 1);
}

export class XmlParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'XmlParseError';
  }
}

// --- Scanner ----------------------------------------------------------------------------
// Tokens: text (character data, CDATA included), opening and closing tags. Comments,
// processing instructions and DOCTYPEs are skipped; a `<` that starts none of these is
// dropped and the scan goes on after it.

type XmlToken =
  | { kind: 'text'; text: string }
  | { kind: 'open'; name: string; attrs: Array<[name: string, rawValue: string]>; selfClosing: boolean }
  | { kind: 'close'; name: string };

interface Scanned {
  token: XmlToken | null;
  end: number;
}

const SPACE = /\s/;
const NAME_START = /[A-Za-z_]/;
const NAME_CHAR = /[\w:.-]/;
/** What ends an attribute name. */
const ATTR_NAME_END = /[\s=/>]/;

/** The first index at or after `from` whose character `pattern` does not match (`stop` false) or matches (`stop` true). */
function skip(xml: string, from: number, pattern: RegExp, stop = false): number {
  let i = from;
  while (i < xml.length && pattern.test(xml[i]) !== stop) i++;
  return i;
}

/** Markup that runs from `open` at `pos` to the first `close` after it; null when it is not there or never closed. */
function scanDelimited(xml: string, pos: number, open: string, close: string): { inner: string; end: number } | null {
  if (!xml.startsWith(open, pos)) return null;
  const at = xml.indexOf(close, pos + open.length);
  return at === -1 ? null : { inner: xml.slice(pos + open.length, at), end: at + close.length };
}

/** A comment, CDATA section, processing instruction or DOCTYPE at `pos`. */
function scanMarkup(xml: string, pos: number): Scanned | null {
  const cdata = scanDelimited(xml, pos, '<![CDATA[', ']]>');
  if (cdata) return { token: { kind: 'text', text: cdata.inner }, end: cdata.end };
  const skipped =
    scanDelimited(xml, pos, '<!--', '-->') ?? scanDelimited(xml, pos, '<?', '?>') ?? scanDelimited(xml, pos, '<!DOCTYPE', '>');
  return skipped ? { token: null, end: skipped.end } : null;
}

/** ` name="value"` (or single quotes) at `from`: at least one space, then the attribute. */
function scanAttribute(xml: string, from: number): { name: string; rawValue: string; end: number } | null {
  const nameStart = skip(xml, from, SPACE);
  if (nameStart === from) return null;
  const nameEnd = skip(xml, nameStart, ATTR_NAME_END, true);
  if (nameEnd === nameStart) return null;
  const equals = skip(xml, nameEnd, SPACE);
  if (xml[equals] !== '=') return null;
  const valueStart = skip(xml, equals + 1, SPACE);
  const quote = xml[valueStart];
  if (quote !== '"' && quote !== "'") return null;
  const valueEnd = xml.indexOf(quote, valueStart + 1);
  if (valueEnd === -1) return null;
  return { name: xml.slice(nameStart, nameEnd), rawValue: xml.slice(valueStart + 1, valueEnd), end: valueEnd + 1 };
}

/** An opening, closing or self-closing tag at `pos`. */
function scanTag(xml: string, pos: number): Scanned | null {
  let i = pos + 1;
  const closing = xml[i] === '/';
  if (closing) i++;
  if (i >= xml.length || !NAME_START.test(xml[i])) return null;
  const nameStart = i;
  i = skip(xml, i + 1, NAME_CHAR);
  const name = xml.slice(nameStart, i);

  const attrs: Array<[string, string]> = [];
  for (let attr = scanAttribute(xml, i); attr; attr = scanAttribute(xml, i)) {
    attrs.push([attr.name, attr.rawValue]);
    i = attr.end;
  }
  i = skip(xml, i, SPACE);
  const selfClosing = xml[i] === '/';
  if (selfClosing) i++;
  if (xml[i] !== '>') return null;
  const token: XmlToken = closing ? { kind: 'close', name } : { kind: 'open', name, attrs, selfClosing };
  return { token, end: i + 1 };
}

function scanAt(xml: string, pos: number): Scanned {
  if (xml[pos] !== '<') {
    const next = xml.indexOf('<', pos);
    const end = next === -1 ? xml.length : next;
    return { token: { kind: 'text', text: decode(xml.slice(pos, end)) }, end };
  }
  return scanMarkup(xml, pos) ?? scanTag(xml, pos) ?? { token: null, end: pos + 1 };
}

function* scan(xml: string): Generator<XmlToken> {
  let pos = 0;
  while (pos < xml.length) {
    const { token, end } = scanAt(xml, pos);
    if (token) yield token;
    pos = end;
  }
}

function elementOf(token: Extract<XmlToken, { kind: 'open' }>): XmlNode {
  const attrs: Record<string, string> = {};
  for (const [name, rawValue] of token.attrs) attrs[localName(name)] = decode(rawValue);
  return { name: localName(token.name), attrs, children: [], text: '' };
}

/** The root element of an XML document. */
export function parseXml(xml: string): XmlNode {
  const root: XmlNode = { name: '#document', attrs: {}, children: [], text: '' };
  const stack: XmlNode[] = [root];
  for (const token of scan(xml)) {
    const top = stack[stack.length - 1];
    if (token.kind === 'text') {
      top.text += token.text;
    } else if (token.kind === 'close') {
      if (stack.length > 1 && top.name === localName(token.name)) stack.pop();
      else throw new XmlParseError(`Unexpected closing tag </${token.name}>`);
    } else {
      const node = elementOf(token);
      top.children.push(node);
      if (!token.selfClosing) stack.push(node);
    }
  }
  if (stack.length > 1) throw new XmlParseError(`Unclosed tag <${stack[stack.length - 1].name}>`);
  const [element] = root.children;
  if (!element) throw new XmlParseError('The file has no XML element');
  return element;
}

export function child(node: XmlNode | undefined, name: string): XmlNode | undefined {
  return node?.children.find((c) => c.name === name);
}

export function childrenOf(node: XmlNode | undefined, name: string): XmlNode[] {
  return node?.children.filter((c) => c.name === name) ?? [];
}

/** The first element called `name` at any depth (the node itself included). */
export function find(node: XmlNode | undefined, name: string): XmlNode | undefined {
  if (!node) return undefined;
  if (node.name === name) return node;
  for (const c of node.children) {
    const hit = find(c, name);
    if (hit) return hit;
  }
  return undefined;
}

/** Text of the element at `path` below `node`. */
export function textAt(node: XmlNode | undefined, ...path: string[]): string | undefined {
  let current = node;
  for (const name of path) current = child(current, name);
  const text = current?.text.trim();
  return text === '' ? undefined : text;
}

function numberAt(node: XmlNode | undefined, ...path: string[]): number {
  const parsed = Number.parseFloat(textAt(node, ...path) ?? '');
  return Number.isFinite(parsed) ? parsed : 0;
}

// --- NF-e ------------------------------------------------------------------------------

export interface ParsedTax {
  /** CST, or the CSOSN of a Simples Nacional issuer. */
  cst: string | null;
  base: number;
  /** Percent. */
  rate: number;
  value: number;
}

export interface ParsedNfeItem {
  number: number;
  code: string;
  description: string;
  ncm: string;
  cfop: string;
  unit: string;
  quantity: number;
  unitPrice: number;
  /** Gross value of the line (vProd). */
  total: number;
  discount: number;
  origin: string | null;
  icms: ParsedTax;
  ipi: ParsedTax;
  pis: ParsedTax;
  cofins: ParsedTax;
}

export interface ParsedNfe {
  accessKey: string;
  issuer: { taxId: string | null; name: string | null; tradeName: string | null; stateRegistration: string | null; uf: string | null };
  recipient: { taxId: string | null; name: string | null };
  number: string | null;
  series: string | null;
  /** yyyy-mm-dd, as printed (Brasília time). */
  issueDate: string | null;
  operation: string | null;
  /** vNF: what the buyer owes. */
  total: number;
  products: number;
  discount: number;
  freight: number;
  insurance: number;
  other: number;
  /** ICMS ST charged on top (vST). */
  icmsSt: number;
  ipi: number;
  installments: Array<{ number: string; dueDate: string | null; amount: number }>;
  payments: Array<{ method: string; amount: number }>;
  protocol: string | null;
  items: ParsedNfeItem[];
}

function taxOf(group: XmlNode | undefined, rateTag: string, valueTag: string): ParsedTax {
  // The group holds one variant (ICMS00, ICMSSN102, IPITrib, PISAliq ...), after possible
  // siblings such as the IPI's cEnq: the variant is the child that carries the CST.
  const variant = group?.children.find((c) => child(c, 'CST') || child(c, 'CSOSN'));
  return {
    cst: textAt(variant, 'CST') ?? textAt(variant, 'CSOSN') ?? null,
    base: numberAt(variant, 'vBC'),
    rate: numberAt(variant, rateTag),
    value: numberAt(variant, valueTag),
  };
}

function stripZeros(value: string | undefined): string | null {
  if (!value) return null;
  const stripped = value.replace(/^0+/, '');
  return stripped === '' ? '0' : stripped;
}

/** Parse the XML of an NF-e (an `nfeProc` or a bare `NFe`). */
export function parseNfeXml(xml: string): ParsedNfe {
  const root = parseXml(xml);
  const inf = find(root, 'infNFe');
  if (!inf) throw new XmlParseError('This is not an NF-e: it has no infNFe element');

  const accessKey = (inf.attrs.Id ?? '').replace(/^NFe/, '') || textAt(find(root, 'infProt'), 'chNFe') || '';
  if (!/^\d{44}$/.test(accessKey)) throw new XmlParseError('The NF-e has no valid 44-digit access key');

  const ide = child(inf, 'ide');
  const emit = child(inf, 'emit');
  const dest = child(inf, 'dest');
  const total = child(child(inf, 'total'), 'ICMSTot');
  const issued = textAt(ide, 'dhEmi') ?? textAt(ide, 'dEmi');

  const items: ParsedNfeItem[] = childrenOf(inf, 'det').map((det, index) => {
    const prod = child(det, 'prod');
    const imposto = child(det, 'imposto');
    const icmsGroup = child(imposto, 'ICMS');
    return {
      number: Number.parseInt(det.attrs.nItem ?? '', 10) || index + 1,
      code: textAt(prod, 'cProd') ?? '',
      description: textAt(prod, 'xProd') ?? '',
      ncm: textAt(prod, 'NCM') ?? '',
      cfop: textAt(prod, 'CFOP') ?? '',
      unit: textAt(prod, 'uCom') ?? 'UN',
      quantity: numberAt(prod, 'qCom'),
      unitPrice: numberAt(prod, 'vUnCom'),
      total: numberAt(prod, 'vProd'),
      discount: numberAt(prod, 'vDesc'),
      origin: textAt(icmsGroup?.children[0], 'orig') ?? null,
      icms: taxOf(icmsGroup, 'pICMS', 'vICMS'),
      ipi: taxOf(child(imposto, 'IPI'), 'pIPI', 'vIPI'),
      pis: taxOf(child(imposto, 'PIS'), 'pPIS', 'vPIS'),
      cofins: taxOf(child(imposto, 'COFINS'), 'pCOFINS', 'vCOFINS'),
    };
  });

  return {
    accessKey,
    issuer: {
      taxId: textAt(emit, 'CNPJ') ?? textAt(emit, 'CPF') ?? null,
      name: textAt(emit, 'xNome') ?? null,
      tradeName: textAt(emit, 'xFant') ?? null,
      stateRegistration: textAt(emit, 'IE') ?? null,
      uf: textAt(emit, 'enderEmit', 'UF') ?? null,
    },
    recipient: { taxId: textAt(dest, 'CNPJ') ?? textAt(dest, 'CPF') ?? null, name: textAt(dest, 'xNome') ?? null },
    number: stripZeros(textAt(ide, 'nNF')),
    series: stripZeros(textAt(ide, 'serie')),
    issueDate: issued ? issued.slice(0, 10) : null,
    operation: textAt(ide, 'natOp') ?? null,
    total: numberAt(total, 'vNF'),
    products: numberAt(total, 'vProd'),
    discount: numberAt(total, 'vDesc'),
    freight: numberAt(total, 'vFrete'),
    insurance: numberAt(total, 'vSeg'),
    other: numberAt(total, 'vOutro'),
    icmsSt: numberAt(total, 'vST'),
    ipi: numberAt(total, 'vIPI'),
    installments: childrenOf(child(inf, 'cobr'), 'dup').map((dup) => ({
      number: textAt(dup, 'nDup') ?? '',
      dueDate: textAt(dup, 'dVenc') ?? null,
      amount: numberAt(dup, 'vDup'),
    })),
    payments: childrenOf(child(inf, 'pag'), 'detPag').map((p) => ({ method: textAt(p, 'tPag') ?? '', amount: numberAt(p, 'vPag') })),
    protocol: textAt(find(root, 'infProt'), 'nProt') ?? null,
    items,
  };
}
