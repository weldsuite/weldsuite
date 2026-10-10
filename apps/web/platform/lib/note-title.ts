/**
 * Note titles for the activity `subject`.
 *
 * A note is a `crm_activities` row of type `note`. The editor keeps its title
 * inside the HTML body (`<h1>Title</h1>…`), so the row's `subject` was only ever
 * the placeholder "Note" it was created with, and anything reading the subject
 * (activity feeds, search, exports, the API) saw "Note" for every note. The note
 * hooks write the title as the subject whenever they save the body.
 */

import { stripTags } from '@/lib/utils';

/** Subject of a note with no text yet; also what the row is created with. */
export const DEFAULT_NOTE_SUBJECT = 'Note';

/** `crm_activities.subject` is capped at 255 characters (createActivitySchema). */
const MAX_SUBJECT_LENGTH = 255;

const HEADING = /<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/i;
const LINE_BREAKING_TAG = /<\/(?:p|div|h[1-6]|li|blockquote|pre)>|<br\s*\/?>/gi;

const ENTITIES: Record<string, string> = {
  '&nbsp;': ' ',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  // Last: decoding it first would turn "&amp;lt;" into "<".
  '&amp;': '&',
};

function toPlainText(html: string): string {
  const text = stripTags(html);
  return text.replaceAll(/&(?:nbsp|lt|gt|quot|#39|amp);/g, (entity) => ENTITIES[entity] ?? entity).trim();
}

/**
 * The note's title: its first heading, else the first line of text. `null`
 * when the note has no text at all.
 */
export function getNoteTitleText(content: string | null | undefined): string | null {
  if (!content) return null;
  const heading = HEADING.exec(content);
  if (heading?.[1]) {
    const title = toPlainText(heading[1]);
    if (title) return title;
  }
  // Break at block ends first, so two paragraphs don't run together into one "line".
  const firstLine = toPlainText(content.replaceAll(LINE_BREAKING_TAG, '\n'))
    .split('\n')
    .map((line) => line.trim())
    .find(Boolean);
  return firstLine ?? null;
}

/** The activity subject for a note body: its title, or "Note" while it has none. */
export function noteSubjectFromContent(content: string | null | undefined): string {
  const title = getNoteTitleText(content);
  return title ? title.slice(0, MAX_SUBJECT_LENGTH) : DEFAULT_NOTE_SUBJECT;
}
