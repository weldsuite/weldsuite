/**
 * URLs in a plain-text message body as links: the inbox timeline, the chat
 * widget and the help center's request thread. No zod here, so the embedded
 * widget can import it without pulling the schemas into its bundle.
 */

export type LinkifiedPart = { type: 'text'; text: string } | { type: 'link'; text: string; href: string };

/** `https://…`, `http://…` or `www.…`, up to whitespace or a `<`. */
const URL_PATTERN = /\b(?:https?:\/\/|www\.)[^\s<]+/gi;
/** Punctuation that usually ends a sentence rather than the URL. */
const TRAILING = new Set(['.', ',', ';', ':', '!', '?', "'", '"']);
/**
 * Longest link made. Message bodies are written by customers, so the trimming
 * below must stay cheap on any input; anything after this is left as text.
 */
const MAX_URL_LENGTH = 2048;

const BRACKETS = [
  ['(', ')'],
  ['[', ']'],
] as const;

function count(text: string, char: string): number {
  let n = 0;
  for (const c of text) if (c === char) n++;
  return n;
}

/** Drop sentence punctuation and an unopened closing bracket off the end. */
function trimUrl(raw: string): string {
  let url = raw.length > MAX_URL_LENGTH ? raw.slice(0, MAX_URL_LENGTH) : raw;
  for (;;) {
    let end = url.length;
    while (end > 0 && TRAILING.has(url[end - 1]!)) end--;
    url = url.slice(0, end);
    const bracket = BRACKETS.find(([, close]) => url.endsWith(close));
    if (!bracket || count(url, bracket[0]) >= count(url, bracket[1])) return url;
    url = url.slice(0, -1);
  }
}

/**
 * Split a plain-text message into text and links, for rendering URLs as
 * anchors (never as HTML: callers render each part as text or an `<a>`).
 * A closing bracket at the end is left out unless the URL opened one.
 */
export function linkifyText(text: string): LinkifiedPart[] {
  const parts: LinkifiedPart[] = [];
  let last = 0;
  for (const match of text.matchAll(URL_PATTERN)) {
    const start = match.index ?? 0;
    const url = trimUrl(match[0]);
    if (!url || /^www\.?$/i.test(url)) continue;
    if (start > last) parts.push({ type: 'text', text: text.slice(last, start) });
    parts.push({ type: 'link', text: url, href: /^www\./i.test(url) ? `https://${url}` : url });
    last = start + url.length;
  }
  if (last < text.length) parts.push({ type: 'text', text: text.slice(last) });
  return parts;
}
