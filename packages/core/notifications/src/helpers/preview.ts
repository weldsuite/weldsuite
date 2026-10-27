/**
 * Plain-text previews for notification bodies.
 *
 * Agents answer in markdown ("I'm set up as **CRM QA Assistant**"); a
 * notification body shows its characters as they are, so the markers must go.
 */

/**
 * `text` without markdown syntax: emphasis, headings, list and quote markers,
 * code fences and spans, links (kept as their label) and images (kept as
 * their alt text). Line breaks stay; angle-bracket tokens such as `<@user>`
 * mentions are left alone.
 */
export function stripMarkdown(text: string): string {
  return (
    text
      // ```lang\ncode``` -> code
      .replace(/```[^\n]*\n?([\s\S]*?)```/g, '$1')
      .replace(/`([^`\n]+)`/g, '$1')
      // ![alt](url) -> alt, [label](url "title") -> label, <https://x> -> https://x
      .replace(/!\[([^\]]*)\]\([^)\s]*(?:\s+"[^"]*")?\)/g, '$1')
      .replace(/\[([^\]]+)\]\([^)\s]*(?:\s+"[^"]*")?\)/g, '$1')
      .replace(/<(https?:\/\/[^>\s]+)>/g, '$1')
      // Block markers at the start of a line.
      .replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, '')
      .replace(/^[ \t]{0,3}>[ \t]?/gm, '')
      .replace(/^[ \t]*(?:[-*_][ \t]*){3,}$/gm, '')
      .replace(/^[ \t]*(?:[-*+]|\d+[.)])[ \t]+/gm, '')
      // Emphasis: **bold**, __bold__, *italic*, _italic_ (not inside words: snake_case stays), ~~strike~~.
      .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, '$2')
      .replace(/(^|[^\w*])\*(?=\S)([^*\n]*?\S)\*(?!\w)/g, '$1$2')
      .replace(/(^|[^\w])_(?=\S)([^_\n]*?\S)_(?!\w)/g, '$1$2')
      .replace(/~~(?=\S)([\s\S]*?\S)~~/g, '$1')
  );
}

/** A one-line, plain-text preview of markdown `text`, cut at `max` characters. */
export function notificationPreview(text: string, max = 180): string {
  const clean = stripMarkdown(text).replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, max - 1)}…`;
}
