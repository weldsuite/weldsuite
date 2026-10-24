/**
 * The characters of a story that are not plain text.
 *
 * A story is one linear sequence of UTF-16 code units, the model Google Docs
 * uses: structure is a handful of control characters in the text, so every
 * position in a story is one integer and ops stay small. Everything bigger
 * than a character (an image, a table, a footnote, a section break) is one
 * object character whose data hangs off that position.
 */

/** Ends a paragraph. Its paragraph properties hang off this position. */
export const PARA = '\n';
/** A line break inside a paragraph (Shift+Enter), as in Word. */
export const LINE_BREAK = '\u000b';
export const TAB = '\t';
/** An object (image, table, break, footnote, field, chip). Its data hangs off this position. */
export const OBJECT = '￼';

/** Characters a story may hold besides printable text. */
const ALLOWED_CONTROLS = new Set([PARA, LINE_BREAK, TAB]);

/**
 * True when `text` holds only characters a story may contain: no control
 * characters besides the paragraph mark, line break and tab, and no lone
 * surrogates (a position could otherwise split a character in two).
 */
export function isStoryText(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x20 || (code >= 0x7f && code < 0xa0)) {
      if (!ALLOWED_CONTROLS.has(text[i]!)) return false;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      i++;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    } else if (code === 0xfffe || code === 0xffff) {
      return false;
    }
  }
  return true;
}

/** Strips what `isStoryText` refuses (for text arriving from outside: paste, import). */
export function cleanStoryText(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    const code = text.charCodeAt(i);
    if (code === 0x0d) {
      // CRLF and lone CR both end a paragraph.
      if (text[i + 1] !== '\n') out += PARA;
    } else if (code < 0x20 || (code >= 0x7f && code < 0xa0)) {
      if (ALLOWED_CONTROLS.has(ch)) out += ch;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        out += ch + text[i + 1];
        i++;
      }
    } else if (!(code >= 0xdc00 && code <= 0xdfff) && code !== 0xfffe && code !== 0xffff && ch !== OBJECT) {
      out += ch;
    }
  }
  return out;
}

/** True when `pos` falls between the two halves of a surrogate pair. */
export function splitsSurrogate(text: string, pos: number): boolean {
  if (pos <= 0 || pos >= text.length) return false;
  const before = text.charCodeAt(pos - 1);
  const after = text.charCodeAt(pos);
  return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff;
}
