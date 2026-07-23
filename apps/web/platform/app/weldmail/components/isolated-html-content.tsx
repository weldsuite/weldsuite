
import React, { useRef, useEffect, useState } from 'react';
import { cn } from '@/lib/utils';
import { useTranslations } from '@weldsuite/i18n/client';

/** Link schemes we're willing to open from email content. */
const SAFE_LINK_SCHEMES = new Set(['http:', 'https:', 'mailto:', 'tel:']);

/**
 * Whether an email link is safe to open. Blocks `javascript:`, `data:`,
 * `vbscript:`, `file:`, etc. — only well-known navigation schemes pass. Parsing
 * via `URL` normalises tab/newline obfuscation (e.g. `java\tscript:`), which the
 * browser would otherwise treat as `javascript:`. Relative hrefs resolve
 * against an https base, so they're treated as https.
 */
export function isSafeHref(href: string): boolean {
  if (!href) return false;
  try {
    const url = new URL(href.trim(), 'https://mail.invalid/');
    return SAFE_LINK_SCHEMES.has(url.protocol);
  } catch {
    return false;
  }
}

interface IsolatedHtmlContentProps {
  html: string;
  className?: string;
}

/**
 * Normalises email HTML before it is written into the (scripting-disabled)
 * iframe. Runs in the parent document, where scripting IS available, using
 * `DOMParser` — which builds an inert tree: it never executes `<script>`,
 * never loads images/resources, and never runs inline event handlers. So this
 * is safe to run on untrusted email HTML.
 *
 * Why this is needed: the iframe opens links purely via the native
 * `<base target="_blank">` we inject, because the sandbox omits `allow-scripts`
 * (our XSS guard). But an email button whose own anchor declares a target
 * (`_self`, `_top`, `_parent`, or a named frame) OVERRIDES that base target.
 * `_top`/`_parent`/named targets are then silently blocked by the sandbox — the
 * click does nothing at all. Marketing/transactional "button" links very often
 * carry such a target (or the email ships its own `<base target>`). Forcing
 * every safe anchor to `target="_blank"` here guarantees the click always opens
 * in a new tab, and dropping unsafe hrefs keeps `javascript:` etc. inert.
 */
interface NormalizedEmail {
  /** Sanitised `<head>` (styles) + `<body>` markup to write into the frame. */
  content: string;
  /** Attributes from the email's own `<html>` tag (e.g. `dir`, `lang`). */
  htmlAttributes: [string, string][];
  /** Attributes from the email's own `<body>` tag (e.g. `bgcolor`, `style`). */
  bodyAttributes: [string, string][];
}

function getAttributes(el: Element): [string, string][] {
  return Array.from(el.attributes).map((attr) => [attr.name, attr.value]);
}

function normalizeEmailHtml(html: string): NormalizedEmail {
  try {
    const parsed = new DOMParser().parseFromString(html, 'text/html');

    // The email must not redirect relative-URL resolution or the default link
    // target out from under us; our own <base target="_blank"> is injected in
    // the wrapper head instead.
    parsed.querySelectorAll('base, script').forEach((el) => el.remove());

    parsed.querySelectorAll('a').forEach((a) => {
      // Decide safety from the RAW attribute so relative/fragment hrefs aren't
      // silently rewritten to the app origin by the DOM's URL resolution.
      const rawHref = a.getAttribute('href');
      if (!rawHref || !isSafeHref(rawHref)) {
        a.removeAttribute('href');
        a.removeAttribute('target');
        return;
      }
      a.setAttribute('target', '_blank');
      a.setAttribute('rel', 'noopener noreferrer');
    });

    // Preserve the email's own <style>/<head> content (many emails style their
    // buttons there) followed by the body markup — matching the previous
    // behaviour of dumping the whole string into <body>, but with anchors and
    // <base> now normalised.
    //
    // NOTE: `innerHTML` serialises only an element's CHILDREN, so attributes on
    // the email's own <html>/<body> tags (e.g. `<body bgcolor="#f4f4f4"
    // style="background-color:#f4f4f4">`, `dir="rtl"`, `lang`) are NOT captured
    // here. They are returned separately and re-applied to the frame's real
    // <html>/<body> after write — the raw-string injection this replaced relied
    // on the HTML parser's attribute-merge to keep them, so dropping them would
    // regress the background/styling of ESP templates (Mailchimp/SendGrid etc.).
    return {
      content: parsed.head.innerHTML + parsed.body.innerHTML,
      htmlAttributes: getAttributes(parsed.documentElement),
      bodyAttributes: getAttributes(parsed.body),
    };
  } catch {
    // If parsing somehow fails, fall back to the original HTML rather than
    // rendering a blank message.
    return { content: html, htmlAttributes: [], bodyAttributes: [] };
  }
}

/**
 * Renders email HTML inside an iframe, isolating its styles from the app.
 *
 * Rendering model mirrors Outlook.com / Gmail on the web:
 *   - The message always renders on a WHITE background with the sender's own
 *     styling intact — even when the app is in dark mode. Web mail clients
 *     deliberately do NOT invert email colors, because emails are authored for
 *     a light background and forcing a dark palette breaks their design (colored
 *     text on colored backgrounds, logos, buttons, etc.). In dark mode the frame
 *     reads as a light "card" sitting on the dark UI.
 *   - Fixed-width emails (the ubiquitous ~600px table layout) that are wider
 *     than the reading pane SCROLL horizontally inside the frame instead of
 *     being clipped, again matching Outlook's reading pane.
 *   - `width=device-width` lets responsive emails (media queries) reflow to the
 *     pane width, so the frame is responsive on mobile and narrow panes.
 */
export function IsolatedHtmlContent({ html, className }: IsolatedHtmlContentProps) {
  const t = useTranslations();
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(40);

  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;

    const doc = iframe.contentDocument || iframe.contentWindow?.document;
    if (!doc) return;

    // Neutral defaults only — the email's own inline styles win over these, so
    // we never override the sender's intended colors. Kept light because that's
    // the canvas every HTML email is designed against.
    const baseStyles = `
      <style>
        * { box-sizing: border-box; }
        /* Root scrolls horizontally so wide, fixed-width emails aren't clipped
           (Outlook reading-pane behavior). Vertical size is driven by the host
           iframe height, so the root itself never scrolls vertically.
           height:auto is forced so a sender's own \`html/body { height:100% }\`
           (or 100vh) can't resolve against the iframe's viewport and inflate the
           measured content — that's what left a tall white gap under the email. */
        html {
          overflow-x: auto;
          overflow-y: hidden;
          height: auto !important;
          min-height: 0 !important;
          background: #ffffff;
          -webkit-text-size-adjust: 100%;
          text-size-adjust: 100%;
        }
        body {
          height: auto !important;
          min-height: 0 !important;
          margin: 0;
          padding: 0;
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
          font-size: 14px;
          line-height: 1.5;
          color: #1a1a1a;
          background: #ffffff;
          /* Break only genuinely unbreakable strings (long URLs) so text emails
             wrap; real fixed-width layouts still scroll instead. */
          overflow-wrap: break-word;
        }
        p { margin: 0 0 1em; }
        p:last-child { margin-bottom: 0; }
        img { max-width: 100%; height: auto; border: 0; }
        a { color: #2563eb; text-decoration: none; }
        a:hover { text-decoration: underline; }
        table { border-collapse: collapse; }
        pre, code {
          white-space: pre-wrap;
          word-wrap: break-word;
          background: #f3f4f6;
          padding: 2px 4px;
          border-radius: 4px;
          font-size: 13px;
        }
        pre { padding: 8px 12px; }
        blockquote {
          margin: 8px 0;
          padding-left: 12px;
          border-left: 3px solid #d1d5db;
          color: #6b7280;
        }
        /* Gmail quote styling */
        .gmail_quote {
          margin: 16px 0 0 0;
          padding: 12px 0 0 12px;
          border-left: 3px solid #d1d5db;
          color: #6b7280;
        }
        /* Outlook quote styling */
        .OutlookMessageHeader, .MsoNormal { margin: 0; }
        /* Hide tracking pixels */
        img[width="1"], img[height="1"] { display: none !important; }
      </style>
    `;

    const normalized = normalizeEmailHtml(html);

    // Write the HTML content to the iframe
    doc.open();
    doc.write(`
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1">
          <!--
            Open every link in a NEW browser tab, like Gmail/Outlook. Using a
            native <base target="_blank"> (rather than a scripted window.open)
            means the click is a real user-gesture navigation, so it is never
            swallowed by popup blockers and never falls back to navigating the
            iframe in place (which made the linked page render "inside" the
            email). noopener/noreferrer is added per-anchor by the click guard
            below so the opened tab can't reach back into this window.
          -->
          <base target="_blank">
          ${baseStyles}
        </head>
        <body>
          ${normalized.content}
        </body>
      </html>
    `);
    doc.close();

    // Re-apply the email's own <html>/<body> attributes (e.g. `bgcolor`,
    // `style="background-color:…"`, `dir`, `lang`) that `innerHTML` couldn't
    // carry. Only set attributes the wrapper doesn't already define, mirroring
    // the HTML parser's attribute-merge that the previous raw-string injection
    // relied on — without this, ESP templates that colour their canvas via
    // <body> lose it and fall back to the wrapper's white background.
    const applyAttributes = (el: Element | null, attributes: [string, string][]) => {
      if (!el) return;
      attributes.forEach(([name, value]) => {
        if (!el.hasAttribute(name)) el.setAttribute(name, value);
      });
    };
    applyAttributes(doc.documentElement, normalized.htmlAttributes);
    applyAttributes(doc.body, normalized.bodyAttributes);

    // Size the frame to its content. When the email overflows horizontally the
    // root shows a scrollbar; add its thickness so the last row isn't clipped.
    const adjustHeight = () => {
      const de = doc.documentElement;
      const body = doc.body;
      if (!de || !body) return;
      const contentHeight = Math.max(body.scrollHeight, body.offsetHeight, de.scrollHeight);
      if (contentHeight <= 0) return;
      const hasHScroll = de.scrollWidth > de.clientWidth + 1;
      setHeight(Math.max(contentHeight + (hasHScroll ? 16 : 0), 24));
    };

    // Content settles across several ticks: the initial write, then images
    // decoding, web fonts loading, and any late reflow. Measuring only once
    // captured an intermediate (too-short or too-tall) height for some emails,
    // leaving the frame the wrong size with white space below. Re-measure at
    // each of these points and on a few fallback timers.
    adjustHeight();
    requestAnimationFrame(adjustHeight);
    const timers = [50, 150, 400, 1000].map((ms) => setTimeout(adjustHeight, ms));

    // Re-measure once web fonts finish loading (they change line heights).
    doc.fonts?.ready.then(adjustHeight).catch(() => {});

    // Observe for content changes (reflow on resize, collapsing/expanding, etc.).
    // Observing the body (whose box tracks real content) rather than the
    // documentElement (whose box tracks the iframe's own viewport height) avoids
    // a feedback loop where setting the height would re-trigger the observer.
    const resizeObserver = new ResizeObserver(adjustHeight);
    if (doc.body) {
      resizeObserver.observe(doc.body);
    }

    // Also adjust as each image loads (or fails) — images without intrinsic
    // dimensions grow the layout only once their bytes arrive.
    const images = doc.querySelectorAll('img');
    images.forEach((img) => {
      if (!img.complete) {
        img.addEventListener('load', adjustHeight);
        img.addEventListener('error', adjustHeight);
      }
    });

    // Belt-and-suspenders link opening. Anchors are already normalised to
    // `target="_blank"` (see normalizeEmailHtml) so the native path via
    // <base target="_blank"> works on its own. This guard adds a second,
    // fully-reliable path: open the link from THIS (top-level, un-sandboxed)
    // window via window.open. Because the parent window is not sandboxed, the
    // popup is never blocked by the iframe's sandbox flags, and the click is a
    // real user gesture so popup blockers allow it. We only cancel the iframe's
    // own navigation when the popup actually opened, so a blocked popup still
    // falls through to the native <base> navigation — never a dead click, never
    // a duplicate tab. (This listener may not fire in browsers that disable
    // scripting for the sandboxed context; the native path covers that case.)
    doc.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      const link = target.closest('a');
      if (!link || !link.href) return;
      if (!isSafeHref(link.href)) {
        e.preventDefault();
        return;
      }
      const opened = window.open(link.href, '_blank', 'noopener,noreferrer');
      if (opened) {
        e.preventDefault();
      }
    });

    return () => {
      resizeObserver.disconnect();
      timers.forEach(clearTimeout);
    };
  }, [html]);

  // In dark mode the white email sits on a dark UI; the rounded border makes it
  // read as an intentional "card" (like Outlook/Gmail) rather than a glitch. In
  // light mode the white-on-white frame is seamless.
  return (
    <div className={cn('overflow-hidden rounded-lg dark:border dark:border-border', className)}>
      {/*
        SECURITY: the email HTML is NOT sanitized — the iframe sandbox below is
        the only thing stopping script execution, so `allow-scripts` MUST NOT be
        added to it. Combined with `allow-same-origin` it would give
        attacker-controlled email HTML full script access to this origin (the
        user's session). Adding scripts here requires sanitizing the HTML first
        (e.g. DOMPurify).
      */}
      <iframe
        ref={iframeRef}
        style={{
          width: '100%',
          height: `${height}px`,
          border: 'none',
          display: 'block',
          background: '#ffffff',
        }}
        sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
        title={t('sweep.weldmail.messageDetail.emailContentFrameTitle')}
      />
    </div>
  );
}
