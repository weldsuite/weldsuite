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
/** ```lang\ncode``` -> code. Split, not a regex: a lazy match across lines backtracks on long text. */
function stripCodeFences(text: string): string {
  const parts = text.split('```');
  // An odd count of fences leaves the last one unclosed: keep it as written.
  const closed = parts.length % 2 === 1 ? parts.length : parts.length - 1;
  let out = parts[0] ?? '';
  for (let i = 1; i < parts.length; i++) {
    const part = parts[i] ?? '';
    if (i >= closed) {
      out += '```' + part;
      continue;
    }
    // Inside a fence the first line is its language tag, when a line break follows it.
    const newline = part.indexOf('\n');
    out += i % 2 === 1 && newline !== -1 ? part.slice(newline + 1) : part;
  }
  return out;
}

export function stripMarkdown(text: string): string {
  return (
    stripCodeFences(text)
      .replace(/`([^`\n]+)`/g, '$1')
      // ![alt](url) and [label](url "title") -> alt / label (an image without alt text goes), <https://x> -> https://x.
      // The classes leave out `[` and `(` so match attempts never overlap (no backtracking on long text).
      .replace(/!?\[([^[\]\n]*)\]\([^()\n]*\)/g, '$1')
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
