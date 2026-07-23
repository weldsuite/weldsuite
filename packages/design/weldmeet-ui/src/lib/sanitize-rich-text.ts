/**
 * Rich-text sanitizer for meeting chat.
 *
 * The chat composer applies formatting via `document.execCommand` (bold,
 * italic, underline, strike, lists), producing HTML. That HTML is sent and
 * persisted as `htmlContent` and rendered with `dangerouslySetInnerHTML`, so it
 * MUST be sanitized before it touches the DOM — a meeting guest can POST
 * arbitrary `htmlContent` to the portal API, so render-time sanitization is the
 * real security boundary (do NOT remove it). See the WeldMail email-HTML XSS
 * incident: never render untrusted HTML unsanitized.
 *
 * Strategy: parse with the browser DOMParser and re-serialize, keeping ONLY an
 * allowlist of formatting tags and stripping ALL attributes (no `style`,
 * `href`, `src`, `on*`, …). Disallowed elements are dropped but their text is
 * kept. On the server (no DOM) we fall back to stripping every tag and
 * returning escaped plain text — safe, just unformatted.
 */

const ALLOWED_TAGS = new Set([
  'B', 'STRONG', 'I', 'EM', 'U', 'S', 'STRIKE', 'DEL',
  'UL', 'OL', 'LI', 'BR', 'P', 'DIV', 'SPAN',
]);

function escapeText(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Tags that actually represent user-applied formatting (vs. layout from typing). */
const FORMATTING_TAG_RE = /<\s*(b|strong|i|em|u|s|strike|del|ul|ol|li)\b/i;

/** True when the HTML contains at least one real formatting tag worth keeping. */
export function hasRichFormatting(html: string | null | undefined): boolean {
  return !!html && FORMATTING_TAG_RE.test(html);
}

export function sanitizeRichText(html: string | null | undefined): string {
  if (!html) return '';

  // Non-browser (SSR / worker): strip all tags, return escaped text.
  if (typeof window === 'undefined' || typeof DOMParser === 'undefined') {
    return escapeText(html.replace(/<[^>]*>/g, ''));
  }

  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');

  const clean = (node: Node): string => {
    let out = '';
    node.childNodes.forEach((child) => {
      if (child.nodeType === 3 /* TEXT_NODE */) {
        out += escapeText(child.textContent ?? '');
        return;
      }
      if (child.nodeType !== 1 /* ELEMENT_NODE */) return;

      const el = child as Element;
      const tag = el.tagName.toUpperCase();
      const inner = clean(el);

      if (!ALLOWED_TAGS.has(tag)) {
        // Drop the element, keep its (already-sanitized) text content.
        out += inner;
        return;
      }
      if (tag === 'BR') {
        out += '<br>';
        return;
      }
      const lower = tag.toLowerCase();
      // Emit WITHOUT any attributes — this is what neutralises XSS vectors.
      out += `<${lower}>${inner}</${lower}>`;
    });
    return out;
  };

  return clean(doc.body);
}
