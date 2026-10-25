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

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff;
/** C0 and C1 control characters (the paragraph mark, line break and tab among them). */
const isControl = (code: number) => code < 0x20 || (code >= 0x7f && code < 0xa0);
const isNonCharacter = (code: number) => code === 0xfffe || code === 0xffff;

/**
 * True when `text` holds only characters a story may contain: no control
 * characters besides the paragraph mark, line break and tab, and no lone
 * surrogates (a position could otherwise split a character in two).
 */
export function isStoryText(text: string): boolean {
  let i = 0;
  while (i < text.length) {
    const width = validWidth(text, i);
    if (width === 0) return false;
    i += width;
  }
  return true;
}

/** How many code units the character at `i` covers (2 for a surrogate pair), or 0 when a story may not hold it. */
function validWidth(text: string, i: number): number {
  const code = text.charCodeAt(i);
  if (isControl(code)) return ALLOWED_CONTROLS.has(text[i]!) ? 1 : 0;
  if (isHighSurrogate(code)) return isLowSurrogate(text.charCodeAt(i + 1)) ? 2 : 0;
  return isLowSurrogate(code) || isNonCharacter(code) ? 0 : 1;
}

/** Strips what `isStoryText` refuses (for text arriving from outside: paste, import). */
export function cleanStoryText(text: string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const [kept, width] = cleanAt(text, i);
    out += kept;
    i += width;
  }
  return out;
}

/** What `cleanStoryText` keeps of the character at `i`, and how many code units that covers. */
function cleanAt(text: string, i: number): [kept: string, width: number] {
  const ch = text[i]!;
  const code = text.charCodeAt(i);
  // CRLF and lone CR both end a paragraph.
  if (code === 0x0d) return [text[i + 1] === '\n' ? '' : PARA, 1];
  if (isControl(code)) return [ALLOWED_CONTROLS.has(ch) ? ch : '', 1];
  // A lone high surrogate is dropped; whatever follows it is read on its own.
  if (isHighSurrogate(code)) return isLowSurrogate(text.charCodeAt(i + 1)) ? [ch + text[i + 1], 2] : ['', 1];
  const keep = !isLowSurrogate(code) && !isNonCharacter(code) && ch !== OBJECT;
  return [keep ? ch : '', 1];
}

/** True when `pos` falls between the two halves of a surrogate pair. */
export function splitsSurrogate(text: string, pos: number): boolean {
  if (pos <= 0 || pos >= text.length) return false;
  const before = text.charCodeAt(pos - 1);
  const after = text.charCodeAt(pos);
  return isHighSurrogate(before) && isLowSurrogate(after);
}
