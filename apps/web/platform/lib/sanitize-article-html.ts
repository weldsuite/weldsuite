import DOMPurify from 'dompurify';

// Help-center articles, knowledge articles, news, changelog entries and
// announcements are written by far more than the WeldDesk editor: any member with
// `articles:create|update`, the external API (wsk_ keys), the MCP server, WeldAgent
// tools and user-created WeldApps can all set their HTML body, and the platform
// then renders (or loads into a contentEditable editor) that body inside an
// ADMIN/OWNER session. So the body is untrusted and is reduced to an explicit
// allowlist before it reaches `innerHTML` / `dangerouslySetInnerHTML`.
//
// The allowlist mirrors the public help center (`apps/web/helpcenter/components/
// ArticleContent.tsx`): the formatting the WeldSuite editor produces (bold,
// italic, underline, alignment, colours, highlight, font family/size, lists,
// tables, images, links) and nothing that can run script or restyle the app.

const ALLOWED_TAGS = [
  'a', 'abbr', 'address', 'article', 'aside', 'b', 'bdi', 'bdo', 'big', 'blockquote',
  'br', 'caption', 'center', 'cite', 'code', 'col', 'colgroup', 'data', 'dd', 'del',
  'details', 'dfn', 'div', 'dl', 'dt', 'em', 'figcaption', 'figure', 'font', 'footer',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hgroup', 'hr', 'i', 'img', 'ins', 'kbd',
  'li', 'main', 'mark', 'nav', 'ol', 'p', 'pre', 'q', 'rp', 'rt', 'ruby', 's', 'samp',
  'section', 'small', 'span', 'strike', 'strong', 'sub', 'summary', 'sup', 'table',
  'tbody', 'td', 'tfoot', 'th', 'thead', 'time', 'tr', 'tt', 'u', 'ul', 'var', 'wbr',
];

// `style` is allowed but reduced to a handful of properties (see SAFE_STYLES), and
// `class` to the three link classes in ALLOWED_CLASSES: a body that could pick its
// own classes could draw over the rest of the app with `fixed inset-0 …`. `id` is
// not allowed at all (it invites DOM clobbering). `target` and `rel` are not
// author-controlled either: the hook below sets them on every link.
const ALLOWED_ATTR = [
  'href', 'src', 'alt', 'title', 'width', 'height', 'loading', 'align', 'dir', 'style',
  'start', 'type', 'colspan', 'rowspan', 'scope', 'color', 'face', 'size', 'class',
];

// http(s), mailto, tel and relative URLs. `javascript:` and friends are out;
// `data:` is only let through for <img src> by DOMPurify's own data-URI rule.
const ALLOWED_URI_REGEXP = /^(?:(?:https?|mailto|tel):|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i;

// The only classes that survive. The WeldDesk editors give every link they create
// these (`link.className = 'text-primary underline hover:text-primary/80'`), and a
// stored article must keep looking like a link when it is shown or edited again.
// Each one only paints text, none positions anything.
const ALLOWED_CLASSES = new Set(['text-primary', 'underline', 'hover:text-primary/80']);

// Safe value patterns for the few CSS properties the editor emits. None can
// contain `url(`, `;`, a backslash escape or parens (except rgb/hsl), so the
// CSS-exfiltration / expression() vectors stay closed while real formatting renders.
const HEX = /^#[0-9a-f]{3,8}$/i;
const RGB = /^rgba?\([\d.,\s%]+\)$/i;
const HSL = /^hsla?\([\d.,\s%]+\)$/i;
const NAMED = /^[a-z]+$/i;
const COLORS = [HEX, RGB, HSL, NAMED];
// Non-negative lengths only: no negative margin can pull content over the UI,
// and no viewport units (`100vw`) can size it past its container.
const LENGTH = /^\d+(?:\.\d+)?(?:px|em|rem|pt|%)?$/i;
const SIZE = /^(?:auto|none|\d+(?:\.\d+)?(?:px|em|rem|%))$/i;

const SAFE_STYLES: Record<string, RegExp[]> = {
  'text-align': [/^(?:left|right|center|justify|start|end)$/i],
  direction: [/^(?:ltr|rtl)$/i],
  color: COLORS,
  'background-color': COLORS,
  'font-weight': [/^(?:bold|bolder|lighter|normal|[1-9]00)$/i],
  'font-style': [/^(?:italic|normal|oblique)$/i],
  'text-decoration': [/^(?:underline|line-through|overline|none)(?:\s+[a-z]+)*$/i],
  'font-family': [/^[\w\s,"'-]+$/],
  'font-size': [
    /^\d+(?:\.\d+)?(?:px|em|rem|pt|%)$/i,
    /^(?:xx-small|x-small|small|medium|large|x-large|xx-large|xxx-large|smaller|larger)$/i,
  ],
  'line-height': [/^(?:normal|\d+(?:\.\d+)?(?:px|em|rem|pt|%)?)$/i],
  'list-style-position': [/^(?:inside|outside)$/i],
  'list-style-type': [/^(?:disc|circle|square|decimal|lower-alpha|upper-alpha|lower-roman|upper-roman|none)$/i],
  'margin-left': [LENGTH],
  width: [SIZE],
  height: [SIZE],
  'max-width': [SIZE],
  'max-height': [SIZE],
};

/**
 * Reduce an inline `style` attribute to the declarations in SAFE_STYLES. Returns an
 * empty string when nothing is left. Exported for tests.
 */
export function filterInlineStyle(css: string): string {
  const kept: string[] = [];
  for (const declaration of css.split(';')) {
    const colon = declaration.indexOf(':');
    if (colon < 1) continue;
    const property = declaration.slice(0, colon).trim().toLowerCase();
    const value = declaration.slice(colon + 1).trim();
    const patterns = Object.hasOwn(SAFE_STYLES, property) ? SAFE_STYLES[property] : undefined;
    if (patterns?.some((pattern) => pattern.test(value))) kept.push(`${property}: ${value}`);
  }
  return kept.join('; ');
}

// Own instance, so the hook below never leaks into another DOMPurify user.
const purifier = DOMPurify(window);

purifier.addHook('afterSanitizeAttributes', (node) => {
  if (node.hasAttribute('style')) {
    const safe = filterInlineStyle(node.getAttribute('style') ?? '');
    if (safe) node.setAttribute('style', safe);
    else node.removeAttribute('style');
  }

  if (node.hasAttribute('class')) {
    const kept = (node.getAttribute('class') ?? '')
      .split(/\s+/)
      .filter((token) => node.nodeName === 'A' && ALLOWED_CLASSES.has(token));
    if (kept.length > 0) node.setAttribute('class', kept.join(' '));
    else node.removeAttribute('class');
  }

  if (node.nodeName === 'A' && node.hasAttribute('href')) {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }

  // An image is fetched with the admin's IP and, by default, this page's URL as
  // the referrer: a body can use that to see who opened it and from where.
  if (node.nodeName === 'IMG') {
    node.setAttribute('referrerpolicy', 'no-referrer');
  }
});

/** Sanitize stored article/news/changelog/announcement HTML for rendering or editing. */
export function sanitizeArticleHtml(html: string | null | undefined): string {
  if (!html) return '';
  return purifier.sanitize(html, {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    ALLOWED_URI_REGEXP,
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
  });
}
