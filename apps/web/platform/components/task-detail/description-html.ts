import DOMPurify from 'dompurify';

// A description is written by far more than this editor: the external API
// (wsk_ keys), the MCP server, WeldAgent tools and user-created WeldApps can all
// set it, and it is rendered inside the reader's own session. So it is treated
// as untrusted HTML and reduced to an explicit allowlist before it reaches
// `innerHTML` / `dangerouslySetInnerHTML`.
//
// Tags: what the contentEditable editor produces (execCommand emits b/strong,
// i/em, strike/s and a div or p per line, depending on the browser) plus the
// basic block formatting that API-written descriptions use.
const ALLOWED_TAGS = [
  'a', 'b', 'blockquote', 'br', 'code', 'del', 'div', 'em', 'h1', 'h2', 'h3',
  'h4', 'h5', 'h6', 'hr', 'i', 'img', 'ins', 'li', 'mark', 'ol', 'p', 'pre',
  's', 'span', 'strike', 'strong', 'sub', 'sup', 'table', 'tbody', 'td', 'th',
  'thead', 'tr', 'u', 'ul',
];

// No `style`, `class` or `id`: the wrapper styles the allowed tags itself
// (`[&_code]:…`, `[&_img]:…`), and a description that could pick its own
// classes could draw over the rest of the app (`fixed inset-0 …`).
const ALLOWED_ATTR = ['href', 'src', 'alt', 'title', 'width', 'height', 'start', 'colspan', 'rowspan'];

// http(s), mailto, tel and relative URLs. `javascript:` and friends are out.
const ALLOWED_URI_REGEXP = /^(?:(?:https?|mailto|tel):|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i;

// Own instance, so the link hook below never leaks into another DOMPurify user.
const purifier = DOMPurify(window);

purifier.addHook('afterSanitizeAttributes', (node) => {
  if (node.nodeName === 'A' && node.hasAttribute('href')) {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }
});

export function sanitizeDescriptionHtml(html: string): string {
  return purifier.sanitize(html, {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    ALLOWED_URI_REGEXP,
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
  });
}

export function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Converts a stored description (which may be HTML or legacy markdown) into
// HTML suitable for a contentEditable editor. This normalizes `**bold**`,
// `*italic*`, `~~strike~~`, and `` `code` `` into their HTML equivalents so
// the editor never shows raw markdown delimiters to the user.
export function descriptionToHtml(input: string): string {
  if (!input) return '';
  // If it already looks like HTML (contains tags), keep the formatting but
  // never the markup as written: it goes through the allowlist first.
  if (/<[a-z][^>]*>/i.test(input)) return sanitizeDescriptionHtml(input);
  // Otherwise treat it as markdown — convert the inline markers we support.
  // Order matters: bold (**) before italic (*) so greedy matches don't swallow pairs.
  let html = input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/~~([^~\n]+)~~/g, '<s>$1</s>')
    .replace(/`([^`\n]+)`/g, '<code>$1</code>');
  // Preserve newlines as <br>
  html = html.replace(/\n/g, '<br>');
  return html;
}
