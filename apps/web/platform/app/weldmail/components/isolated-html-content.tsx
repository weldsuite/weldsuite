
import React, { useRef, useEffect, useState } from 'react';
import { Moon, Sun } from 'lucide-react';
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

interface Rgba { r: number; g: number; b: number; a: number }
interface Hsla { h: number; s: number; l: number; a: number }

let colorProbe: CanvasRenderingContext2D | null = null;

/**
 * Parses a computed CSS color. Computed colors are almost always `rgb()`/`rgba()`;
 * anything else (e.g. the app's own `oklch()` theme tokens) is resolved by
 * painting one pixel on a canvas.
 */
function parseColor(value: string): Rgba | null {
  const m = value.match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+)(%?))?\s*\)$/);
  if (m) {
    const alpha = m[4] === undefined ? 1 : Number(m[4]) / (m[5] ? 100 : 1);
    return { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]), a: alpha };
  }
  try {
    colorProbe ??= document.createElement('canvas').getContext('2d', { willReadFrequently: true });
    if (!colorProbe) return null;
    colorProbe.clearRect(0, 0, 1, 1);
    colorProbe.fillStyle = value;
    colorProbe.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = colorProbe.getImageData(0, 0, 1, 1).data;
    return { r, g, b, a: a / 255 };
  } catch {
    return null;
  }
}

function toHsla({ r, g, b, a }: Rgba): Hsla {
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l, a };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === rn) h = (gn - bn) / d + (gn < bn ? 6 : 0);
  else if (max === gn) h = (bn - rn) / d + 2;
  else h = (rn - gn) / d + 4;
  return { h: h * 60, s, l, a };
}

function hslaString({ h, s, l, a }: Hsla): string {
  const clamp = (n: number) => Math.min(1, Math.max(0, n));
  return `hsl(${h.toFixed(1)} ${(clamp(s) * 100).toFixed(1)}% ${(clamp(l) * 100).toFixed(1)}% / ${a})`;
}

/** Backgrounds at or above this lightness are "the light canvas" the email was written against. */
const LIGHT_BACKGROUND = 0.75;
/** Text below this lightness would be unreadable on a dark canvas. */
const DARK_TEXT = 0.6;

/**
 * Adapts an already-rendered email to dark mode, the way Outlook and Apple Mail
 * do: light backgrounds become dark (white maps exactly onto the app's own
 * surface so the message blends in), and dark text on those backgrounds becomes
 * light. Hue is preserved, so a red warning stays red and a link stays blue.
 *
 * Anything the sender deliberately colored — a dark or saturated block, a
 * button, a background image — is left exactly as authored, along with the text
 * inside it, because those colors were chosen for that block rather than for
 * the page. Runs from the parent window (the iframe has no scripting), reading
 * every computed style before writing so the walk doesn't thrash layout.
 */
function adaptEmailToDarkMode(doc: Document, surface: Hsla) {
  const view = doc.defaultView;
  if (!view || !doc.body) return;

  const neutral = (hsla: Hsla) => hsla.s < 0.15;
  const darkBackground = (bg: Hsla): Hsla => {
    // Keep the distance from white: white → the app surface, a light grey
    // wrapper → a step above it, so nested "cards" stay distinguishable.
    const l = Math.min(surface.l + (1 - bg.l) * 0.9, 0.35);
    return neutral(bg)
      ? { h: surface.h, s: surface.s, l, a: bg.a }
      : { h: bg.h, s: bg.s * 0.5, l, a: bg.a };
  };
  const lightText = (fg: Hsla): Hsla => ({
    h: fg.h,
    s: fg.s,
    l: Math.min(Math.max(1 - fg.l, 0.7), 0.9),
    a: fg.a,
  });
  const dimBorder = (border: Hsla): Hsla =>
    neutral(border)
      ? { h: surface.h, s: surface.s, l: surface.l + 0.14, a: border.a }
      : { h: border.h, s: border.s * 0.6, l: border.l >= LIGHT_BACKGROUND ? surface.l + 0.2 : 0.45, a: border.a };

  const elements: Element[] = [doc.documentElement, doc.body, ...Array.from(doc.body.querySelectorAll('*'))];
  const onDarkCanvas = new Map<Element, boolean>();
  const writes: Array<[ElementCSSInlineStyle, string, string]> = [];
  const sides = ['top', 'right', 'bottom', 'left'] as const;

  for (const el of elements) {
    const cs = view.getComputedStyle(el);
    let dark = el.parentElement ? onDarkCanvas.get(el.parentElement) ?? true : true;

    if (cs.backgroundImage && cs.backgroundImage !== 'none') {
      dark = false;
    } else {
      const bg = parseColor(cs.backgroundColor);
      if (bg && bg.a > 0.5) {
        const hsla = toHsla(bg);
        dark = hsla.l >= LIGHT_BACKGROUND;
        if (dark) writes.push([el as unknown as ElementCSSInlineStyle, 'background-color', hslaString(darkBackground(hsla))]);
      }
    }
    onDarkCanvas.set(el, dark);
    if (!dark || !('style' in el)) continue;

    const target = el as unknown as ElementCSSInlineStyle;
    const fg = parseColor(cs.color);
    if (fg) {
      const hsla = toHsla(fg);
      if (hsla.l < DARK_TEXT) writes.push([target, 'color', hslaString(lightText(hsla))]);
    }

    for (const side of sides) {
      if (cs.getPropertyValue(`border-${side}-style`) === 'none') continue;
      if (parseFloat(cs.getPropertyValue(`border-${side}-width`)) <= 0) continue;
      const border = parseColor(cs.getPropertyValue(`border-${side}-color`));
      if (!border || border.a === 0) continue;
      const hsla = toHsla(border);
      if (hsla.l >= LIGHT_BACKGROUND || hsla.l < 0.3) {
        writes.push([target, `border-${side}-color`, hslaString(dimBorder(hsla))]);
      }
    }
  }

  // Inline !important beats the email's own stylesheet rules, even !important ones.
  for (const [target, property, value] of writes) {
    target.style.setProperty(property, value, 'important');
  }
}

/** The first opaque background behind `el` in the app, i.e. the surface the email sits on. */
function readSurfaceColor(el: Element | null): Hsla {
  const fallback: Hsla = { h: 0, s: 0, l: 0.09, a: 1 };
  for (let node = el; node; node = node.parentElement) {
    const bg = parseColor(getComputedStyle(node).backgroundColor);
    if (bg && bg.a > 0.9) {
      const hsla = toHsla(bg);
      return hsla.l < 0.5 ? { ...hsla, a: 1 } : fallback;
    }
  }
  return fallback;
}

/** Tracks the app theme (the `dark` class on <html>), including live switches. */
function useAppDarkMode(): boolean {
  const [isDark, setIsDark] = useState(
    () => typeof document !== 'undefined' && document.documentElement.classList.contains('dark'),
  );
  useEffect(() => {
    const root = document.documentElement;
    const update = () => setIsDark(root.classList.contains('dark'));
    update();
    const observer = new MutationObserver(update);
    observer.observe(root, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);
  return isDark;
}

/**
 * Renders email HTML inside an iframe, isolating its styles from the app.
 *
 * Rendering model:
 *   - Light mode: the message renders on white with the sender's styling intact.
 *   - Dark mode: the email is adapted to the dark UI (see adaptEmailToDarkMode),
 *     so plain emails no longer show up as a glaring white slab. Deliberately
 *     colored blocks keep their design. A per-message toggle switches back to
 *     the original colors for the rare email the adaptation doesn't suit
 *     (e.g. a dark logo on a transparent background).
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
  const isDark = useAppDarkMode();
  const [showOriginalColors, setShowOriginalColors] = useState(false);
  const adaptToDark = isDark && !showOriginalColors;

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

    if (adaptToDark) {
      adaptEmailToDarkMode(doc, readSurfaceColor(iframe.parentElement));
    }

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
  }, [html, adaptToDark]);

  // When the original (light) colors are shown in dark mode, the rounded border
  // makes the white email read as an intentional "card" rather than a glitch.
  return (
    <div
      className={cn(
        'group/email-frame relative overflow-hidden rounded-lg',
        isDark && !adaptToDark && 'border border-border',
        className,
      )}
    >
      {isDark && (
        <button
          type="button"
          onClick={() => setShowOriginalColors((value) => !value)}
          title={
            adaptToDark
              ? t('sweep.weldmail.messageDetail.showOriginalColors')
              : t('sweep.weldmail.messageDetail.showDarkColors')
          }
          aria-label={
            adaptToDark
              ? t('sweep.weldmail.messageDetail.showOriginalColors')
              : t('sweep.weldmail.messageDetail.showDarkColors')
          }
          className="absolute right-1.5 top-1.5 z-10 inline-flex h-6 w-6 items-center justify-center rounded-md border border-border bg-background/90 text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover/email-frame:opacity-100"
        >
          {adaptToDark ? <Sun className="h-3.5 w-3.5" /> : <Moon className="h-3.5 w-3.5" />}
        </button>
      )}
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
          // Transparent while adapting, so the frame never flashes white before
          // the adapted content (painted in the app's surface color) is written.
          background: adaptToDark ? 'transparent' : '#ffffff',
        }}
        sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
        title={t('sweep.weldmail.messageDetail.emailContentFrameTitle')}
      />
    </div>
  );
}
