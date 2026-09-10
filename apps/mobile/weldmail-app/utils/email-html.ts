/**
 * Helpers for safely rendering received (attacker-controlled) email HTML.
 *
 * SECURITY MODEL — the hard guarantees come from the WebView config in
 * `components/EmailHtmlView.tsx` (blocked navigation, restrictive
 * originWhitelist, CSP with no script-src) plus the Content-Security-Policy
 * injected here. The engine is enabled only so the host-injected layout probe
 * can measure height / clamp fixed widths; the email's own scripts stay blocked
 * by CSP. `sanitizeEmailHtml` is defense-in-depth: it strips the obvious
 * dangerous nodes so a future regression can't trivially reintroduce XSS, and
 * it removes auto-loading tracking/script vectors. It is intentionally
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
 * CSS that forces common fixed-width email layouts (tables with width="600",
 * inline min-width, wide images) to reflow inside a phone-sized WebView.
 * Kept as a named export so unit tests can assert the responsive rules ship.
 */
export function buildResponsiveEmailCss(opts: {
  textColor: string;
  fontSize: number;
  lineHeight: number;
  hideQuotes: boolean;
}): string {
  const { textColor, fontSize, lineHeight, hideQuotes } = opts;
  const quoteCss = hideQuotes
    ? '.gmail_quote,.yahoo_quoted{display:none;}blockquote{display:none;}'
    : '';
  return (
    // Root: never wider than the WebView; long tokens wrap instead of expanding.
    // Use overflow-x:auto (not hidden) so a layout glitch cannot clip the entire
    // body to an empty pane — the native wrapper still clips horizontal pan.
    `html,body{width:100% !important;max-width:100% !important;overflow-x:auto !important;` +
    `margin:0;padding:0;-webkit-text-size-adjust:100%;text-size-adjust:100%;}` +
    `body{font-family:system-ui,-apple-system,sans-serif;font-size:${fontSize}px;` +
    `line-height:${lineHeight};color:${textColor};word-wrap:break-word;` +
    `overflow-wrap:anywhere;}` +
    // Marketing/transactional mail is almost always table-based with a fixed
    // ~600px outer table (often via width="600" AND style="min-width:600px").
    // Cap max-width and zero min-width so inline min-width cannot force a
    // horizontal pan. Do NOT force width:100% / table-layout:fixed on every
    // table — that collapses many nested ESP layouts to an empty body.
    `table,td,th,div,center,section,article{max-width:100% !important;min-width:0 !important;}` +
    `table{border-collapse:collapse;}` +
    `td,th{word-wrap:break-word !important;overflow-wrap:anywhere !important;}` +
    `img,video{max-width:100% !important;height:auto !important;}` +
    `pre,code{white-space:pre-wrap !important;word-wrap:break-word !important;}` +
    `a{color:#3B82F6;}` +
    // Hide 1×1 tracking pixels that some ESPs size via attributes.
    `img[width="1"],img[height="1"]{display:none !important;}` +
    `${quoteCss}`
  );
}

/**
 * Host-injected script for the read-only email WebView.
 *
 * Runs as a react-native-webview user script (exempt from the page CSP) and:
 *  1. Rewrites HTML `width` attrs / inline px widths & min-widths that exceed
 *     the viewport so fixed ~600px ESP tables reflow on phones.
 *  2. Posts the resulting content height back to React Native so the WebView
 *     can size itself without an inner scrollbar.
 *
 * Deliberately does NOT apply `transform: scale(...)`. Scaling from a premature
 * (near-zero) viewport measurement collapsed the body to a few pixels and made
 * the whole message look empty. CSS max-width/min-width clamps plus width-attr
 * rewriting are enough for phone fit.
 *
 * Re-runs on load, resize, image load/error, ResizeObserver, and delayed ticks
 * — late images/fonts are the usual cause of an initially-wrong height.
 */
export const EMAIL_LAYOUT_PROBE = `
(function(){
  function viewportWidth(){
    try{
      return document.documentElement.clientWidth || window.innerWidth || 0;
    }catch(_){ return 0; }
  }
  function fitToViewport(){
    try{
      var max = viewportWidth();
      // Wait until the WebView has a real layout width. Rewriting against a
      // tiny/zero viewport turns 600px tables into 100%-of-nothing and the
      // height probe then locks the native WebView at a few pixels.
      if(!(max >= 120) || !document.body) return;
      var nodes = document.body.querySelectorAll('table,td,th,div,center,img,section,article');
      for(var i=0;i<nodes.length;i++){
        var el = nodes[i];
        if(!el || el.nodeType !== 1) continue;
        if(el.hasAttribute('width')){
          var aw = el.getAttribute('width');
          if(aw && aw.indexOf('%') === -1){
            var n = parseInt(aw, 10);
            if(n > max) el.setAttribute('width', '100%');
          }
        }
        try{
          if(el.style){
            if(el.style.width && /px/i.test(el.style.width) && parseFloat(el.style.width) > max){
              el.style.setProperty('width', '100%', 'important');
            }
            if(el.style.minWidth && /px/i.test(el.style.minWidth) && parseFloat(el.style.minWidth) > max){
              el.style.setProperty('min-width', '0px', 'important');
            }
          }
        }catch(_){}
      }
    }catch(_){}
  }
  function report(){
    try{
      fitToViewport();
      var b=document.body, e=document.documentElement;
      var h=Math.max(
        b?b.scrollHeight:0, b?b.offsetHeight:0,
        e?e.scrollHeight:0, e?e.offsetHeight:0
      );
      if(h>0 && window.ReactNativeWebView){ window.ReactNativeWebView.postMessage(String(Math.ceil(h))); }
    }catch(_){}
  }
  report();
  window.addEventListener('load', report);
  window.addEventListener('resize', report);
  var imgs=document.images||[];
  for(var i=0;i<imgs.length;i++){
    var im=imgs[i];
    if(im && !im.complete){ im.addEventListener('load', report); im.addEventListener('error', report); }
  }
  try{ if(window.ResizeObserver && document.body){ new ResizeObserver(report).observe(document.body); } }catch(_){}
  setTimeout(report, 300);
  setTimeout(report, 1000);
})();
true;
`;

/**
 * Build the full, sanitized, CSP-protected HTML document string fed to the
 * read-only email WebView. Pure (no React Native deps) so it is unit-testable.
 */
export function buildEmailDocument(html: string, opts: EmailDocumentOptions): string {
  const { textColor, fontSize = 15, lineHeight = 1.6, hideQuotes = false } = opts;
  const style = buildResponsiveEmailCss({ textColor, fontSize, lineHeight, hideQuotes });
  return (
    `<!DOCTYPE html><html><head>` +
    `<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">` +
    `<meta http-equiv="Content-Security-Policy" content="${EMAIL_CSP}">` +
    `<style>${style}</style>` +
    `</head><body>${trimTrailingEmptyHtml(sanitizeEmailHtml(html))}</body></html>`
  );
}
