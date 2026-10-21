import { sanitizeArticleHtml } from '@/lib/sanitize-article-html';

/**
 * Inline markdown (`**bold**`, `*italic*`, `` `code` ``) for one line of a knowledge
 * article or news item, as sanitized HTML.
 *
 * The line is not escaped first: stored bodies are mostly HTML written by the
 * WeldDesk editor, so escaping would show its tags as text. Instead the whole
 * result goes through the article allowlist, which is what makes it safe to hand to
 * `dangerouslySetInnerHTML` (the line is attacker-controllable: members, the
 * external API, MCP and WeldAgent can all write article bodies).
 *
 * The generated `<code>` carries no class (the allowlist drops them); the caller
 * styles it from the wrapper with `[&_code]:…`.
 */
export function renderInlineMarkdown(line: string): string {
  const html = line
    .replaceAll(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replaceAll(/\*(.*?)\*/g, '<em>$1</em>')
    .replaceAll(/`(.*?)`/g, '<code>$1</code>');
  return sanitizeArticleHtml(html);
}

/** Tailwind classes that give the `<code>` produced by {@link renderInlineMarkdown} its look. */
export const INLINE_CODE_CLASSES = '[&_code]:bg-muted [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:rounded [&_code]:text-sm [&_code]:font-mono';
