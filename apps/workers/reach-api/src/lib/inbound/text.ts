/**
 * Text extraction for replies: HTML to text, cutting the quoted conversation
 * off the end of a reply, snippets and subject normalisation.
 *
 * Replies quote the whole thread below the new text, in whatever style the
 * sender's client uses ("On ... wrote:", Outlook's From/Sent block, `>` lines,
 * in English, Dutch, German or French). Only the new text is stored as the
 * snippet, shown in the inbox and given to the classifier.
 *
 * The input is written by strangers: everything here scans linearly (no
 * regular expression that can backtrack on crafted text, see `strings.ts`).
 */

import { trimEdges, trimEnd } from './strings';

const NAMED_ENTITIES: Record<string, string> = {
  nbsp: ' ',
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  ndash: '-',
  mdash: '-',
  hellip: '...',
  rsquo: "'",
  lsquo: "'",
  rdquo: '"',
  ldquo: '"',
  euro: 'EUR',
};

function decodeEntities(input: string): string {
  return input.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8});/gi, (match, body: string) => {
    const lower = body.toLowerCase();
    if (lower.startsWith('#')) {
      const code = lower.startsWith('#x') ? Number.parseInt(lower.slice(2), 16) : Number.parseInt(lower.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : match;
    }
    return NAMED_ENTITIES[lower] ?? match;
  });
}

/** Markers where an HTML reply starts quoting the conversation it answers (lower-cased). */
const HTML_QUOTE_MARKERS = [
  'class="gmail_quote',
  "class='gmail_quote",
  'class="gmail_attr',
  'id="divrplyfwdmsg"',
  'id="appendonsend"',
  '<blockquote',
];

/** Drop `<...>` tags in one pass. A `<` that never closes is kept as text. */
function stripTags(html: string): string {
  let out = '';
  let index = 0;
  while (index < html.length) {
    const open = html.indexOf('<', index);
    if (open === -1) {
      out += html.slice(index);
      break;
    }
    const close = html.indexOf('>', open + 1);
    if (close === -1) {
      out += html.slice(index);
      break;
    }
    out += html.slice(index, open);
    index = close + 1;
  }
  return out;
}

/** Remove `<name ...> ... </name>` blocks (style, script, head). */
function removeBlocks(html: string, name: string): string {
  const lower = html.toLowerCase();
  let out = '';
  let index = 0;
  let search = 0;
  for (;;) {
    const open = lower.indexOf(`<${name}`, search);
    if (open === -1) return out + html.slice(index);
    // `<head` must not match `<header>`: the tag name ends at whitespace, `>` or `/`.
    const next = lower.charAt(open + name.length + 1);
    if (next !== '>' && next !== '/' && next.trim() !== '') {
      search = open + 1;
      continue;
    }
    const close = lower.indexOf(`</${name}>`, open);
    out += html.slice(index, open);
    if (close === -1) return out;
    index = close + name.length + 3;
    search = index;
  }
}

/** Plain text of an HTML body, without the quoted conversation. */
export function htmlToText(html: string): string {
  const lower = html.toLowerCase();
  const bodyStart = lower.indexOf('<body');
  const bodyEnd = bodyStart === -1 ? -1 : lower.indexOf('>', bodyStart);
  let body = bodyEnd === -1 ? html : html.slice(bodyEnd + 1);

  const bodyLower = body.toLowerCase();
  const cut = Math.min(body.length, ...HTML_QUOTE_MARKERS.map((marker) => (bodyLower.indexOf(marker) === -1 ? body.length : bodyLower.indexOf(marker))));
  // A quote marker sits inside its opening tag: cut back to that tag's `<`.
  const tagStart = cut < body.length ? body.lastIndexOf('<', cut) : cut;
  body = body.slice(0, tagStart === -1 ? cut : tagStart);

  for (const name of ['head', 'style', 'script']) body = removeBlocks(body, name);
  const withBreaks = body
    .replace(/<br\s{0,4}\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6]|table|ul|ol)>/gi, '\n');
  return decodeEntities(stripTags(withBreaks))
    .replace(/[ \t ]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const ATTRIBUTION_STARTS = ['on ', 'op ', 'am ', 'le ', 'el ', 'il '];
/** Verbs that end an attribution line ("... wrote:"), lower-cased. */
const ATTRIBUTION_VERBS = ['wrote', 'a écrit', 'a ecrit', 'escribió', 'escribio', 'ha scritto'];
/** Dutch and German put the sender after the verb: "schreef Sam <sam@x.com>:". */
const ATTRIBUTION_MID_VERBS = [' schreef ', ' schrieb '];

/** Phrases (between the dashes) of a "forwarded / original message" separator line. */
const SEPARATOR_PHRASES = new Set([
  'original message',
  'oorspronkelijk bericht',
  'ursprüngliche nachricht',
  'ursprungliche nachricht',
  "message d'origine",
  'mensaje original',
  'forwarded message',
  'doorgestuurd bericht',
  'weitergeleitete nachricht',
]);

const HEADER_START_KEYS = new Set(['from', 'van', 'von', 'de', 'da']);
const HEADER_FOLLOW_KEYS = new Set([
  'sent', 'verzonden', 'gesendet', 'date', 'datum', 'envoyé', 'envoye', 'enviado', 'inviato',
  'to', 'aan', 'an', 'subject', 'onderwerp', 'betreff', 'objet', 'cc',
]);

const TRAILING_NOISE_PREFIXES = [
  'sent from my ',
  'sent from outlook',
  'sent from mail',
  'sent from yahoo mail',
  'sent from gmail',
  'get outlook for ',
  'verzonden vanaf mijn ',
  'verzonden vanuit ',
  'envoyé de mon ',
  'envoye de mon ',
];

/** The key of a `Key: value` header-looking line, lower-cased; null when the line is not one. */
function headerKey(line: string): string | null {
  const colon = line.indexOf(':');
  if (colon <= 0 || colon > 20) return null;
  const key = line.slice(0, colon).trim().toLowerCase();
  return key.includes(' ') ? null : key;
}

function endsWithAttribution(text: string): boolean {
  const lower = text.toLowerCase().trimEnd();
  const withoutColon = lower.endsWith(':') ? trimEnd(lower.slice(0, -1), ' ') : lower;
  if (ATTRIBUTION_VERBS.some((verb) => withoutColon.endsWith(verb))) return true;
  return lower.endsWith(':') && ATTRIBUTION_MID_VERBS.some((verb) => lower.includes(verb));
}

/** A header like "On Mon, 12 Oct 2026 at 09:14, Sam <sam@x.com> wrote:", possibly wrapped over up to three lines. */
function startsAttributionLine(lines: string[], index: number): boolean {
  const first = lines[index]!.trim();
  const lower = first.toLowerCase();
  if (first.length < 8 || !ATTRIBUTION_STARTS.some((start) => lower.startsWith(start))) return false;
  let joined = first;
  for (let extra = 0; extra < 4; extra++) {
    if (endsWithAttribution(joined)) return true;
    const next = lines[index + 1 + extra];
    if (next === undefined) return false;
    joined = `${joined} ${next.trim()}`;
    if (joined.length > 400) return false;
  }
  return false;
}

/** Outlook's pasted header block: "From: ..." followed by Sent/To/Subject lines. */
function startsHeaderBlock(lines: string[], index: number): boolean {
  const start = lines[index]!.trim();
  const key = headerKey(start);
  if (!key || !HEADER_START_KEYS.has(key) || start.slice(start.indexOf(':') + 1).trim() === '') return false;
  let follow = 0;
  for (let i = index + 1; i <= index + 6 && i < lines.length; i++) {
    const followKey = headerKey(lines[i]!.trim());
    if (followKey && HEADER_FOLLOW_KEYS.has(followKey)) follow += 1;
  }
  return follow >= 2;
}

/** `-----Original Message-----`, `---------- Forwarded message ---------` or Outlook's row of underscores. */
export function isQuoteSeparator(line: string): boolean {
  if (line.length >= 8 && trimEdges(line, '_') === '') return true;
  if (!line.startsWith('--') || !line.endsWith('--')) return false;
  return SEPARATOR_PHRASES.has(trimEdges(line, '- \t').toLowerCase());
}

function isTrailingNoise(line: string): boolean {
  const lower = line.trim().toLowerCase();
  if (lower === '') return true;
  if (lower.startsWith('von meinem ') && lower.includes(' gesendet')) return true;
  return TRAILING_NOISE_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

function quoteStart(lines: string[]): number {
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] === '-- ') return i;
    if (startsAttributionLine(lines, i) || startsHeaderBlock(lines, i) || isQuoteSeparator(lines[i]!.trim())) return i;
  }
  return lines.length;
}

/** The reply's own text: everything above the quoted conversation, without `>` lines and mobile footers. */
export function stripQuotedHistory(text: string): string {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const kept = lines.slice(0, quoteStart(lines)).filter((line) => !line.trimStart().startsWith('>'));
  while (kept.length > 0 && isTrailingNoise(kept[kept.length - 1]!)) kept.pop();
  return kept.join('\n').trim();
}

/** Up to 500 characters of text on one line, for the inbox list. */
export function makeSnippet(text: string, max = 500): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, max);
}

/** `Re`, `Fwd` and their Dutch / German / Scandinavian / French equivalents. */
const SUBJECT_PREFIXES = new Set(['re', 'aw', 'antw', 'antwoord', 'sv', 'vs', 'wg', 'fw', 'fwd', 'doorgestuurd', 'ref', 'tr']);

/** The text after one leading `Re:` style prefix, or null when the subject does not start with one. */
function withoutPrefix(subject: string): string | null {
  const colon = subject.indexOf(':');
  if (colon <= 0 || colon > 20) return null;
  // `Re[2]:` counters count as part of the prefix.
  const bracket = subject.indexOf('[');
  const prefix = (bracket > 0 && bracket < colon ? subject.slice(0, bracket) : subject.slice(0, colon)).trim().toLowerCase();
  return SUBJECT_PREFIXES.has(prefix) ? subject.slice(colon + 1) : null;
}

/** The subject without `Re:` / `Fwd:` style prefixes. */
export function normalizeSubject(subject: string): string {
  let out = subject.trim();
  for (let i = 0; i < 10; i++) {
    const next = withoutPrefix(out);
    if (next === null) break;
    out = next.trim();
  }
  return out;
}

/** The subject for an answer: `Re: <subject>` without stacking prefixes. */
export function replySubject(subject: string | null | undefined): string {
  const base = normalizeSubject(subject ?? '');
  return base === '' ? 'Re:' : `Re: ${base}`;
}
