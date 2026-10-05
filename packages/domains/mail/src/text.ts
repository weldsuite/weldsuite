/**
 * Text helpers for outbound mail: the text/plain alternative, the list
 * preview and the quoted headers of a forward.
 *
 * Compose clients have sent the editor's HTML in `body` (the field meant for
 * plain text), which put raw markup in the text/plain part of delivered mail
 * and in the Sent list preview. The send path therefore never trusts `body`
 * to be plain: it goes through `plainTextBody` first.
 */

const BLOCK_BREAK = /<\/(?:p|div|h[1-6]|li|tr|blockquote|pre|table|ul|ol)\s*>/gi;
const LINE_BREAK = /<br\s*\/?>/gi;
const LIST_ITEM = /<li\b[^>]*>/gi;
const DROPPED_BLOCKS = /<(style|script|head|title)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
const ANY_TAG = /<[^>]+>/g;

/** A tag an editor or mail client emits; `a < b` and `<3` are not markup. */
const HTML_TAG =
  /<\/?(?:div|p|br|span|b|i|u|s|strong|em|ul|ol|li|a|h[1-6]|table|tbody|tr|td|th|blockquote|img|font|pre|code|hr|html|body)\b[^>]*>/i;

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    if (entity[0] === '#') {
      const code =
        entity[1] === 'x' || entity[1] === 'X'
          ? Number.parseInt(entity.slice(2), 16)
          : Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return NAMED_ENTITIES[entity.toLowerCase()] ?? match;
  });
}

export function looksLikeHtml(text: string): boolean {
  return HTML_TAG.test(text);
}

/** Readable plain text for an HTML fragment: block ends become line breaks, tags go, entities are decoded. */
export function htmlToText(html: string): string {
  const text = html
    .replace(DROPPED_BLOCKS, '')
    .replace(LINE_BREAK, '\n')
    .replace(LIST_ITEM, '- ')
    .replace(BLOCK_BREAK, '\n')
    // An opening block tag right after text starts a new line too: editors
    // write `first line<div>second line</div>`.
    .replace(/([^\n>])<(?:div|p)\b[^>]*>/gi, '$1\n')
    .replace(ANY_TAG, '');
  return decodeEntities(text)
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * The text/plain body to send and store: `body` when it is plain text, its
 * tag-free form when a client put HTML there, and otherwise the text of the
 * HTML body.
 */
export function plainTextBody(body: string | undefined, htmlBody: string | undefined): string | undefined {
  if (body && body.trim()) return looksLikeHtml(body) ? htmlToText(body) : body;
  if (htmlBody) return htmlToText(htmlBody) || undefined;
  return body;
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
