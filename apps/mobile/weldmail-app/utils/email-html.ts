/**
 * Helpers for safely rendering received (attacker-controlled) email HTML.
 *
 * SECURITY MODEL — the hard guarantees come from the WebView config in
 * `components/EmailHtmlView.tsx` (javaScriptEnabled=false, blocked navigation,
 * restrictive originWhitelist) plus the Content-Security-Policy injected here.
 * `sanitizeEmailHtml` is defense-in-depth: it strips the obvious dangerous nodes
 * so a future regression (e.g. re-enabling JS) can't trivially reintroduce XSS,
 * and it removes auto-loading tracking/script vectors. It is intentionally
 * conservative and must NOT be relied on as the sole control.
 */

// No `script-src` directive ⇒ it falls back to `default-src 'none'`, so inline
// <script>, inline event handlers and javascript: URIs are all blocked by the
// engine even if JS were enabled. Images/fonts/media are limited to https/data
// (no cleartext-http auto-loads); inline styles are allowed for email layout.
const EMAIL_CSP =
  "default-src 'none'; img-src https: data:; style-src 'unsafe-inline'; font-src https: data:; media-src https: data:;";

/**
 * Strip the dangerous parts of an HTML email body. Regex-based and deliberately
 * conservative — see the security note above; this is a secondary layer, not the
 * primary defense.
 */
export function sanitizeEmailHtml(html: string): string {
  if (!html) return '';
  return (
    html
      // Remove whole scripting/embedding elements including their content.
      .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '')
      .replace(/<iframe\b[^>]*>[\s\S]*?<\/iframe\s*>/gi, '')
      .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript\s*>/gi, '')
      .replace(/<svg\b[^>]*>[\s\S]*?<\/svg\s*>/gi, '')
      // Remove dangerous standalone / void elements (forms, frames, meta-refresh, etc.).
      .replace(/<\/?(?:object|embed|frame|frameset|base|form|input|button|meta|link|applet)\b[^>]*>/gi, '')
      // Drop inline event-handler attributes: onclick=, onerror=, onload=, …
      .replace(/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
      // Neutralise javascript:/vbscript: and data:text/html URIs in href/src/etc.
      .replace(/((?:href|src|xlink:href|action|formaction)\s*=\s*["']?)\s*(?:javascript|vbscript)\s*:/gi, '$1#')
      .replace(/((?:href|src|xlink:href)\s*=\s*["']?)\s*data\s*:\s*text\/html/gi, '$1#')
  );
}

/**
 * Strip trailing empty/whitespace nodes from an email body.
 *
 * Reply chains and Outlook/Word signatures routinely end with runs of empty
 * blocks (`<br>`, `<div></div>`, `<o:p></o:p>`, `&nbsp;`, raw whitespace). They
 * render as blank space but still add to the document height, which — because
 * the body WebView is auto-sized to its measured content height — shows up as a
 * dead gap below the visible text (e.g. above the reply/forward action bar).
 * Trimming them makes the measured height hug the real content.
 *
 * Runs iteratively so nested trailers collapse (e.g. `<div><br></div>` → gone).
 * Only *empty* trailing tags are removed; tags with content are left intact.
 */
export function trimTrailingEmptyHtml(html: string): string {
  if (!html) return '';
  // A trailing run of: whitespace, &nbsp;, <br>, or a block (p/div/span/o:p)
  // whose only content is more of the same. Iterating collapses one level of
  // nesting per pass (e.g. `<div><br></div>` → gone).
  const trailing =
    /(?:\s|&nbsp;|&#160;|<br\s*\/?>|<(p|div|span|o:p)\b[^>]*>(?:\s|&nbsp;|&#160;|<br\s*\/?>)*<\/\1\s*>)+$/i;
  let out = html;
  let prev: string;
  do {
    prev = out;
    out = out.replace(trailing, '');
  } while (out !== prev);
  return out;
}

export interface EmailDocumentOptions {
  /** Body text color (themed). */
  textColor: string;
  fontSize?: number;
  lineHeight?: number;
  /** Hide quoted/previous-message blocks (gmail_quote / blockquote). */
  hideQuotes?: boolean;
}

/**
 * Build the full, sanitized, CSP-protected HTML document string fed to the
 * read-only email WebView. Pure (no React Native deps) so it is unit-testable.
 */
export function buildEmailDocument(html: string, opts: EmailDocumentOptions): string {
  const { textColor, fontSize = 15, lineHeight = 1.6, hideQuotes = false } = opts;
  const quoteCss = hideQuotes
    ? '.gmail_quote,.yahoo_quoted{display:none;}blockquote{display:none;}'
    : '';
  const style =
    `body{font-family:system-ui,-apple-system,sans-serif;font-size:${fontSize}px;` +
    `line-height:${lineHeight};color:${textColor};margin:0;padding:0;word-wrap:break-word;}` +
    `img{max-width:100%;height:auto;}a{color:#3B82F6;}pre,code{white-space:pre-wrap;}${quoteCss}`;
  return (
    `<!DOCTYPE html><html><head>` +
    `<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0">` +
    `<meta http-equiv="Content-Security-Policy" content="${EMAIL_CSP}">` +
    `<style>${style}</style>` +
    `</head><body>${trimTrailingEmptyHtml(sanitizeEmailHtml(html))}</body></html>`
  );
}
