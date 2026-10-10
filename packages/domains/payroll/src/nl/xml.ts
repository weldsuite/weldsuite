/**
 * Minimal XML writing for the Belastingdienst messages: element trees with
 * text escaping, written without insignificant whitespace between elements
 * other than optional indentation.
 *
 * Character set: the Berichtspecificatie aangifte loonheffingen 2026 (§
 * "Tekenset") allows a subset of ISO 8859-1 and says letters with diacritics
 * outside it are written without the diacritic. `toLatin1` does that by
 * Unicode decomposition; anything else outside Latin-1 becomes `?`.
 */

export type XmlNode = { name: string; attrs?: Record<string, string>; children?: XmlNode[]; text?: string | null };

export function el(name: string, content?: string | number | XmlNode[] | null, attrs?: Record<string, string>): XmlNode {
  if (Array.isArray(content)) return { name, attrs, children: content };
  return { name, attrs, text: content === undefined || content === null ? null : String(content) };
}

/** Escape text for element content and attribute values. */
export function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Keep Latin-1 characters; strip diacritics from others; replace what remains. */
export function toLatin1(text: string): string {
  let out = '';
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (cp <= 0xff) {
      out += ch;
      continue;
    }
    const base = ch.normalize('NFD').replace(/[̀-ͯ]/g, '');
    out += [...base].every((c) => c.codePointAt(0)! <= 0xff) ? base : '?';
  }
  // Control characters are not allowed in XML 1.0 text.
  return out.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
}

export function serialize(node: XmlNode, indent = '  ', depth = 0): string {
  const pad = indent ? indent.repeat(depth) : '';
  const attrs = node.attrs
    ? Object.entries(node.attrs)
        .map(([k, v]) => ` ${k}="${escapeXml(v)}"`)
        .join('')
    : '';
  if (node.children && node.children.length > 0) {
    const nl = indent ? '\n' : '';
    const inner = node.children.map((c) => serialize(c, indent, depth + 1)).join(nl);
    return `${pad}<${node.name}${attrs}>${nl}${inner}${nl}${pad}</${node.name}>`;
  }
  const text = node.text === null || node.text === undefined ? '' : escapeXml(toLatin1(node.text));
  return `${pad}<${node.name}${attrs}>${text}</${node.name}>`;
}
