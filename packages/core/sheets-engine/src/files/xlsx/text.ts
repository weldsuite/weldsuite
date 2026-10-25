/**
 * SpreadsheetML's own text conventions, on top of the generic XML in
 * @weldsuite/zip-xml: string items made of runs, and `_xHHHH_` escapes for
 * characters XML cannot hold.
 */

import { child, esc, isXmlUnsafe, type XmlElement } from '@weldsuite/zip-xml';

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
