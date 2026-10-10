/**
 * XML Signature for SOAP messages we build ourselves, with WebCrypto only
 * (runs in Cloudflare Workers).
 *
 * Instead of parsing and canonicalising arbitrary XML, the message is built
 * as a tree of namespaced elements and written by `canonicalize`, which
 * produces Exclusive XML Canonicalization 1.0 output
 * (https://www.w3.org/TR/xml-exc-c14n/, without InclusiveNamespaces) for any
 * subtree taken as the apex of the canonicalized node-set:
 * - a namespace declaration is written on an element only when the element
 *   or one of its attributes visibly uses the prefix and no output ancestor
 *   already declared it with the same URI;
 * - namespace declarations first (default namespace first, then by prefix),
 *   then attributes sorted by namespace URI and local name (unqualified first);
 * - start and end tags for empty elements; text escaped as C14N prescribes
 *   (&amp; &lt; &gt; &#xD; in text; &amp; &lt; &quot; &#x9; &#xA; &#xD; in
 *   attributes); no XML declaration, no whitespace between elements.
 * The whole message is written the same way, so the bytes of each signed
 * subtree in the message canonicalize to exactly what was digested.
 */

export interface XNode {
  ns: string;
  prefix: string;
  name: string;
  attrs?: Array<{ ns?: string; prefix?: string; name: string; value: string }>;
  children?: Array<XNode | string>;
}

export function x(ns: string, prefix: string, name: string, children: Array<XNode | string> = [], attrs: XNode['attrs'] = []): XNode {
  return { ns, prefix, name, children, attrs };
}

function escText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\r/g, '&#xD;');
}

function escAttr(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/"/g, '&quot;')
    .replace(/\t/g, '&#x9;')
    .replace(/\n/g, '&#xA;')
    .replace(/\r/g, '&#xD;');
}

/** Exclusive C14N of `node` as apex; `inScope` are declarations already written by output ancestors. */
export function canonicalize(node: XNode, inScope: Map<string, string> = new Map()): string {
  const scope = new Map(inScope);
  // No default namespace in scope is the same as xmlns="" (no declaration needed for unqualified names).
  if (!scope.has('')) scope.set('', '');
  const decls: Array<[string, string]> = [];
  const need = (prefix: string, ns: string) => {
    if (scope.get(prefix) !== ns) {
      scope.set(prefix, ns);
      decls.push([prefix, ns]);
    }
  };
  need(node.prefix, node.ns);
  const attrs = [...(node.attrs ?? [])];
  for (const a of attrs) if (a.ns && a.prefix) need(a.prefix, a.ns);
  decls.sort((p, q) => (p[0] === q[0] ? 0 : p[0] === '' ? -1 : q[0] === '' ? 1 : p[0] < q[0] ? -1 : 1));
  attrs.sort((p, q) => {
    const pn = p.ns ?? '';
    const qn = q.ns ?? '';
    if (pn !== qn) return pn < qn ? -1 : 1;
    return p.name < q.name ? -1 : p.name > q.name ? 1 : 0;
  });
  const qname = node.prefix ? `${node.prefix}:${node.name}` : node.name;
  let out = `<${qname}`;
  for (const [prefix, ns] of decls) out += prefix ? ` xmlns:${prefix}="${escAttr(ns)}"` : ` xmlns="${escAttr(ns)}"`;
  for (const a of attrs) out += ` ${a.prefix ? `${a.prefix}:` : ''}${a.name}="${escAttr(a.value)}"`;
  out += '>';
  for (const c of node.children ?? []) out += typeof c === 'string' ? escText(c) : canonicalize(c, scope);
  return `${out}</${qname}>`;
}

export function base64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 1) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin);
}

export function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

export async function sha256Base64(s: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', utf8(s));
  return base64(new Uint8Array(digest));
}

/** RSASSA-PKCS1-v1_5 with SHA-256 (http://www.w3.org/2001/04/xmldsig-more#rsa-sha256). */
export async function rsaSha256Base64(key: CryptoKey, s: string): Promise<string> {
  const sig = await crypto.subtle.sign({ name: 'RSASSA-PKCS1-v1_5' }, key, utf8(s));
  return base64(new Uint8Array(sig));
}

export const NS = {
  ds: 'http://www.w3.org/2000/09/xmldsig#',
  excC14n: 'http://www.w3.org/2001/10/xml-exc-c14n#',
  rsaSha256: 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256',
  sha256: 'http://www.w3.org/2001/04/xmlenc#sha256',
  wsse: 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd',
  wsu: 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd',
  x509v3: 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-x509-token-profile-1.0#X509v3',
  base64Binary: 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0#Base64Binary',
} as const;

/**
 * A ds:Signature over the given elements (each must carry a wsu:Id), keyed to
 * a BinarySecurityToken by reference. Returns the Signature element.
 */
export async function signElements(args: {
  key: CryptoKey;
  references: Array<{ id: string; node: XNode }>;
  tokenId: string;
}): Promise<XNode> {
  const { ds } = NS;
  const refs: XNode[] = [];
  for (const r of args.references) {
    const digest = await sha256Base64(canonicalize(r.node));
    refs.push(
      x(ds, 'ds', 'Reference', [
        x(ds, 'ds', 'Transforms', [x(ds, 'ds', 'Transform', [], [{ name: 'Algorithm', value: NS.excC14n }])]),
        x(ds, 'ds', 'DigestMethod', [], [{ name: 'Algorithm', value: NS.sha256 }]),
        x(ds, 'ds', 'DigestValue', [digest]),
      ], [{ name: 'URI', value: `#${r.id}` }]),
    );
  }
  const signedInfo = x(ds, 'ds', 'SignedInfo', [
    x(ds, 'ds', 'CanonicalizationMethod', [], [{ name: 'Algorithm', value: NS.excC14n }]),
    x(ds, 'ds', 'SignatureMethod', [], [{ name: 'Algorithm', value: NS.rsaSha256 }]),
    ...refs,
  ]);
  const signatureValue = await rsaSha256Base64(args.key, canonicalize(signedInfo));
  return x(ds, 'ds', 'Signature', [
    signedInfo,
    x(ds, 'ds', 'SignatureValue', [signatureValue]),
    x(ds, 'ds', 'KeyInfo', [
      x(NS.wsse, 'wsse', 'SecurityTokenReference', [
        x(NS.wsse, 'wsse', 'Reference', [], [{ name: 'URI', value: `#${args.tokenId}` }, { name: 'ValueType', value: NS.x509v3 }]),
      ]),
    ]),
  ]);
}
