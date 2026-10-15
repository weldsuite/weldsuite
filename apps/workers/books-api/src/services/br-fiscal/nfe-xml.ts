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

const TOKEN =
  /<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<(\/?)([A-Za-z_][\w:.-]*)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
const ATTRIBUTE = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

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

/** The root element of an XML document. */
export function parseXml(xml: string): XmlNode {
  const root: XmlNode = { name: '#document', attrs: {}, children: [], text: '' };
  const stack: XmlNode[] = [root];
  for (const match of xml.matchAll(TOKEN)) {
    const [, cdata, closing, rawName, rawAttrs, selfClosing, text] = match;
    const top = stack[stack.length - 1];
    if (cdata !== undefined) {
      top.text += cdata;
    } else if (text !== undefined) {
      top.text += decode(text);
    } else if (rawName) {
      if (closing) {
        if (stack.length > 1 && top.name === localName(rawName)) stack.pop();
        else throw new XmlParseError(`Unexpected closing tag </${rawName}>`);
      } else {
        const attrs: Record<string, string> = {};
        for (const attr of (rawAttrs ?? '').matchAll(ATTRIBUTE)) attrs[localName(attr[1])] = decode(attr[2] ?? attr[3] ?? '');
        const node: XmlNode = { name: localName(rawName), attrs, children: [], text: '' };
        top.children.push(node);
        if (!selfClosing) stack.push(node);
      }
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
