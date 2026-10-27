import { messagePreviewText } from './render-message-content';

/** A markdown block marker at the start of a line: heading, quote, bullet, number. */
const LINE_MARKER = /^\s{0,3}(?:#{1,6}\s+|>\s?|[-*+•]\s+|\d{1,4}[.)]\s+)/;
const FENCE_LINE = /^\s{0,3}(?:`{3,}|~{3,})/;

/**
 * An agent run's summary as one line of plain text, for lists that have no room
 * for formatting: `**bold**` and `` `code` `` markers, list bullets, headings
 * and fences are dropped, mentions read `@Name`, and line breaks become spaces.
 * Agents write summaries in markdown, so showing them raw leaves the asterisks in.
 */
export function runSummaryText(summary: string | null | undefined): string {
  if (!summary) return '';
  const lines = summary
    .replaceAll('\r\n', '\n')
    .split('\n')
    .filter((line) => !FENCE_LINE.test(line))
    .map((line) => line.replace(LINE_MARKER, ''));
  return messagePreviewText(lines.join('\n'));
}
