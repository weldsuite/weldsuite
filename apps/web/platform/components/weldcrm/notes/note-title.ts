import { stripTags } from '@/lib/utils';

/** The note's title: its first heading, else its first line of text. `'Untitled'` when it has neither. */
export function getNoteTitle(content: string): string {
  if (!content) return 'Untitled';
  const headingMatch = /<h[1-3][^>]*>(.*?)<\/h[1-3]>/i.exec(content);
  if (headingMatch?.[1]) {
    const title = stripTags(headingMatch[1]).trim();
    if (title) return title;
  }
  const firstLine = stripTags(content).trim().split('\n')[0]?.trim() || 'Untitled';
  return firstLine || 'Untitled';
}
