/**
 * Note bodies are HTML, written by the platform's rich-text editor: the title
 * is the first heading (`<h1>Title</h1>`), the rest is paragraphs. The app edits
 * a title and plain-text body and writes them back in that same shape, so a
 * note looks the same on the web whichever side wrote it.
 *
 * A note with formatting the app can't keep (lists, bold, links, …) is shown
 * as text but not edited here, so saving from the phone never strips it.
 */

/** Subject of a note with no text yet (the platform uses the same placeholder). */
export const DEFAULT_NOTE_SUBJECT = 'Note';

/** `crm_activities.subject` is capped at 255 characters. */
const MAX_SUBJECT_LENGTH = 255;

const HEADING = /<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/i;
const LINE_BREAKING_TAG = /<\/(?:p|div|h[1-6]|li|blockquote|pre)>|<br\s*\/?>/gi;
/** Tags the app writes itself; anything else is formatting it would lose. */
const PLAIN_TAG_NAMES = new Set(['p', 'br', 'h1', 'h2', 'h3', 'div', 'span']);

/** Every `<…>` tag in the HTML, in order (a linear scan, no backtracking). */
function tagsOf(html: string): string[] {
  const tags: string[] = [];
  let start = html.indexOf('<');
  while (start !== -1) {
    const end = html.indexOf('>', start);
    if (end === -1) break;
    tags.push(html.slice(start + 1, end));
    start = html.indexOf('<', end);
  }
  return tags;
}

/** The HTML with every tag removed. */
function stripTags(html: string): string {
  let text = '';
  let index = 0;
  let start = html.indexOf('<');
  while (start !== -1) {
    const end = html.indexOf('>', start);
    if (end === -1) break;
    text += html.slice(index, start);
    index = end + 1;
    start = html.indexOf('<', index);
  }
  return text + html.slice(index);
}

const ENTITIES: Record<string, string> = {
  '&nbsp;': ' ',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  // Last: decoding it first would turn "&amp;lt;" into "<".
  '&amp;': '&',
};

function decode(text: string): string {
  return text.replaceAll(/&(?:nbsp|lt|gt|quot|#39|amp);/g, (entity) => ENTITIES[entity] ?? entity);
}

function escape(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

/** HTML to text with one line per block; trims leading and trailing blank lines. */
export function htmlToText(html: string | null | undefined): string {
  if (!html) return '';
  return decode(stripTags(html.replaceAll(LINE_BREAKING_TAG, '\n')))
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .trim();
}

/** True when the HTML only uses headings, paragraphs and line breaks. */
export function isPlainNoteHtml(html: string | null | undefined): boolean {
  if (!html) return true;
  return tagsOf(html).every((tag) => {
    const name = tag.replace(/^\//, '').split(/[\s/]/)[0].toLowerCase();
    return PLAIN_TAG_NAMES.has(name);
  });
}

export interface NoteParts {
  title: string;
  body: string;
}

/** Split a note's HTML into its title (first heading) and the text after it. */
export function splitNote(html: string | null | undefined): NoteParts {
  if (!html) return { title: '', body: '' };
  const heading = HEADING.exec(html);
  if (!heading) return { title: '', body: htmlToText(html) };
  const title = htmlToText(heading[1]);
  const rest = html.slice(0, heading.index) + html.slice(heading.index + heading[0].length);
  return { title, body: htmlToText(rest) };
}

/** Title and text back to the editor's HTML: `<h1>` plus one `<p>` per line. */
export function buildNoteHtml({ title, body }: NoteParts): string {
  const parts: string[] = [];
  if (title.trim()) parts.push(`<h1>${escape(title.trim())}</h1>`);
  if (body.trim()) {
    for (const line of body.trim().split('\n')) {
      parts.push(line.trim() ? `<p>${escape(line.trim())}</p>` : '<p></p>');
    }
  }
  return parts.join('');
}

/** The activity subject for a note: its title, else its first line, else "Note". */
export function noteSubject({ title, body }: NoteParts): string {
  const first = title.trim() || body.split('\n').map((line) => line.trim()).find(Boolean) || '';
  return first ? first.slice(0, MAX_SUBJECT_LENGTH) : DEFAULT_NOTE_SUBJECT;
}
