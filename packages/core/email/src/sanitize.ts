/**
 * Server-side email-HTML sanitizer (Workers-compatible).
 *
 * Inbound/synced email HTML is untrusted. Before it's stored — and therefore
 * before any surface renders it — strip every script-execution vector so a
 * malicious message can't run JS in a victim's session (the platform/mobile
 * readers add a sandbox on top; this is the defense-in-depth layer so no single
 * control is the sole defense, and it also protects non-sandboxed consumers
 * like helpdesk threads and accounting docs).
 *
 * Built on `htmlparser2` + `dom-serializer` — both pure JS, so this runs in the
 * Cloudflare Workers runtime (no DOM/jsdom) and is unit-testable in Node. Unlike
 * regex stripping, a real tokenizer isn't fooled by malformed markup
 * (`<scr<script>ipt>`, split attributes, entity/whitespace obfuscation).
 *
 * Strategy: an allowlist. Unknown tags are unwrapped (children kept, tag
 * dropped); known-dangerous tags are dropped with their content; on every kept
 * element, event-handler attributes and dangerous-scheme URLs are removed and
 * inline CSS is scrubbed. `<style>`/`<head>` blocks are dropped — inline
 * `style=""` (the bulk of real email styling) is preserved.
 */

import { parseDocument } from 'htmlparser2';
import render from 'dom-serializer';
import type { ChildNode, Element } from 'domhandler';

/** Formatting/structural tags kept as-is (attributes still filtered). */
const ALLOWED_TAGS = new Set([
  'html', 'body',
  'a', 'abbr', 'address', 'area', 'b', 'bdi', 'bdo', 'blockquote', 'br', 'caption',
  'center', 'cite', 'code', 'col', 'colgroup', 'dd', 'del', 'details', 'dfn', 'div',
  'dl', 'dt', 'em', 'figcaption', 'figure', 'font', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'hr', 'i', 'img', 'ins', 'kbd', 'label', 'legend', 'li', 'map', 'mark', 'ol', 'p',
  'pre', 'q', 's', 'samp', 'small', 'span', 'strike', 'strong', 'sub', 'summary', 'sup',
  'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'time', 'tr', 'u', 'ul', 'var', 'wbr',
]);

/** Tags removed together with everything inside them. */
const DROP_WITH_CONTENT = new Set([
  'script', 'style', 'iframe', 'object', 'embed', 'applet', 'noscript', 'svg', 'math',
  'head', 'title', 'frame', 'frameset', 'template', 'link', 'meta', 'base', 'xml',
]);

/** Attributes that carry a URL — value scheme is validated. */
const URL_ATTRS = new Set([
  'href', 'src', 'action', 'formaction', 'xlink:href', 'background', 'poster', 'cite', 'longdesc',
]);

/** Schemes safe to keep in a stored email. `cid:` = inline attachment; `data:image/*` handled separately. */
const SAFE_SCHEMES = new Set(['http:', 'https:', 'mailto:', 'tel:', 'cid:']);

function isSafeUrl(value: string): boolean {
  const v = value.trim();
  // Inline images are common and inert.
  if (/^data:image\//i.test(v)) return true;
  try {
    const url = new URL(v, 'https://mail.invalid/');
    return SAFE_SCHEMES.has(url.protocol);
  } catch {
    // Unparseable → keep only if it's clearly a relative/fragment ref with no scheme.
    return !/^[a-z][a-z0-9+.-]*:/i.test(v);
  }
}

/** Strip CSS constructs that can execute or load script. */
function cleanCss(css: string): string {
  return css
    .replace(/expression\s*\(/gi, '')
    .replace(/javascript\s*:/gi, '')
    .replace(/vbscript\s*:/gi, '')
    .replace(/-moz-binding/gi, '')
    .replace(/behaviou?r\s*:/gi, '')
    .replace(/@import/gi, '');
}

function cleanAttribs(el: Element): void {
  const attribs = el.attribs ?? {};
  for (const name of Object.keys(attribs)) {
    const lower = name.toLowerCase();
    // Drop inline event handlers (onclick, onerror, onload, …) and bindings.
    if (lower.startsWith('on') || lower === 'srcdoc' || lower === 'xmlns' || lower === 'is') {
      delete attribs[name];
      continue;
    }
    if (lower === 'style') {
      attribs[name] = cleanCss(attribs[name] ?? '');
      continue;
    }
    if (lower === 'srcset') {
      // Each candidate is "url descriptor" — drop the whole attr if any url is unsafe.
      const urls = (attribs[name] ?? '')
        .split(',')
        .map((c) => c.trim().split(/\s+/)[0] ?? '')
        .filter(Boolean);
      if (urls.some((u) => !isSafeUrl(u))) delete attribs[name];
      continue;
    }
    if (URL_ATTRS.has(lower)) {
      if (!isSafeUrl(attribs[name] ?? '')) delete attribs[name];
    }
  }
}

function sanitizeNodes(nodes: ChildNode[]): ChildNode[] {
  const out: ChildNode[] = [];
  for (const node of nodes) {
    if (node.type === 'text') {
      out.push(node);
      continue;
    }
    // Drop comments (can hide IE conditional <script>), directives, CDATA.
    if (node.type === 'comment' || node.type === 'directive' || node.type === 'cdata') {
      continue;
    }
    // Everything else is an element (htmlparser2 types script/style specially too).
    const el = node as Element;
    const tag = (el.name ?? '').toLowerCase();

    if (node.type === 'script' || node.type === 'style' || DROP_WITH_CONTENT.has(tag)) {
      continue; // drop element AND its content
    }

    const children = sanitizeNodes((el.children ?? []) as ChildNode[]);

    if (!ALLOWED_TAGS.has(tag)) {
      // Unknown/disallowed tag (form, input, video, custom, …): unwrap — keep
      // the sanitized children, drop the tag itself.
      out.push(...children);
      continue;
    }

    cleanAttribs(el);
    el.children = children;
    out.push(el);
  }
  return out;
}

/**
 * Sanitize a stored email HTML body. Returns '' for empty input. The result is
 * safe to persist and to render (still render it sandboxed where possible).
 */
export function sanitizeEmailHtml(html: string | null | undefined): string {
  if (!html) return '';
  try {
    const doc = parseDocument(html);
    const cleaned = sanitizeNodes(doc.children as ChildNode[]);
    return render(cleaned);
  } catch {
    // Parsing/serialization should never throw on real input, but if it does,
    // fail closed: strip every tag rather than store unknown markup.
    return html.replace(/<[^>]*>/g, '');
  }
}
