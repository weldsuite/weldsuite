/**
 * Describing a clicked or submitted element for `$autocapture`, without
 * collecting what visitors type.
 */

import { MAX_ELEMENT_TEXT, type ClientConfig, type WireElement } from './wire';

/**
 * What counts as a click worth recording: things people click to do
 * something. Options, checkboxes and the like are left out: what someone
 * picks is a value, like what they type.
 */
export const INTERACTIVE =
  'a,button,input[type=submit],input[type=button],input[type=reset],input[type=image],summary,' +
  '[role=button],[role=link],[role=menuitem],[role=tab]';

const BLOCK = '[data-panel-block]';
const MASK = '[data-panel-mask]';
/** Elements whose text is (or may be) a value someone typed or picked. */
const NO_TEXT_TAGS = /^(INPUT|TEXTAREA|SELECT|OPTION|SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/;
const SAFE_IDENT = /^-?[A-Za-z_][A-Za-z0-9_-]*$/;

/** The interactive element a click landed on, or null when it should not be captured. */
export function clickTarget(target: EventTarget | null): Element | null {
  const el = target instanceof Element ? target.closest(INTERACTIVE) : null;
  return el && !el.closest(BLOCK) ? el : null;
}

/** Whether an element is inside a `data-panel-block` subtree. */
export function isBlocked(el: Element): boolean {
  return !!el.closest(BLOCK);
}

function part(el: Element): string {
  let s = el.tagName.toLowerCase();
  if (el.id && SAFE_IDENT.test(el.id)) return `${s}#${el.id}`;
  // Utility classes with `:` or `/` (Tailwind) would need escaping and say little; three plain ones are enough.
  const classes = (el.getAttribute('class') || '').split(/\s+/).filter((c) => SAFE_IDENT.test(c));
  for (let i = 0; i < classes.length && i < 3; i++) s += `.${classes[i]}`;
  return s;
}

/** `div.card > a#buy` style: the element and up to two ancestors, stopping at an id. */
export function cssSelector(el: Element): string {
  const parts: string[] = [];
  let cur: Element | null = el;
  while (cur && parts.length < 3 && cur.tagName !== 'BODY' && cur.tagName !== 'HTML') {
    const p = part(cur);
    parts.unshift(p);
    if (p.indexOf('#') >= 0) break;
    cur = cur.parentElement;
  }
  return parts.join(' > ').slice(0, 512);
}

/** `a@b.c`: one `@` with something before it and a dot with something after it. */
function looksLikeEmail(word: string): boolean {
  const at = word.indexOf('@');
  const dot = word.lastIndexOf('.');
  return at > 0 && at === word.lastIndexOf('@') && dot > at + 1 && dot < word.length - 1;
}

/**
 * Email addresses and runs of 4 or more digits (cards, phones, ids, codes)
 * become `*`. A word that holds an address is masked whole, punctuation and all.
 */
export function maskText(text: string): string {
  return text
    .replace(/\S+/g, (word) => (looksLikeEmail(word) ? '*' : word))
    .replace(/\d{4,}/g, '*');
}

function collectText(node: Node, out: string[], budget: { left: number }): void {
  for (let c = node.firstChild; c && budget.left > 0; c = c.nextSibling) {
    if (c.nodeType === 3) {
      const t = c.nodeValue || '';
      out.push(t);
      budget.left -= t.length;
    } else if (c.nodeType === 1) {
      const e = c as Element;
      if (NO_TEXT_TAGS.test(e.tagName) || e.hasAttribute('data-panel-mask') || e.hasAttribute('data-panel-block')) continue;
      collectText(e, out, budget);
    }
  }
}

/**
 * The element's visible text for the masking level: none in `strict`, else
 * trimmed, masked and cut to 255 characters. Never the value of an input,
 * not even a submit button's label (it is the input's value).
 */
export function elementText(el: Element, masking: ClientConfig['maskingLevel']): string | undefined {
  if (masking !== 'balanced' && masking !== 'relaxed') return undefined;
  if (NO_TEXT_TAGS.test(el.tagName) || el.closest(MASK)) return undefined;
  const out: string[] = [];
  collectText(el, out, { left: 4 * MAX_ELEMENT_TEXT });
  let text = out.join('').replace(/\s+/g, ' ').trim();
  // Icon buttons: the label the author gave them.
  if (!text) text = (el.getAttribute('aria-label') || el.getAttribute('title') || '').trim();
  text = maskText(text).slice(0, MAX_ELEMENT_TEXT).trim();
  return text || undefined;
}

export function describeElement(
  el: Element,
  action: WireElement['action'],
  masking: ClientConfig['maskingLevel'],
  textFrom: Element | null = el,
): WireElement {
  const out: WireElement = { tag: el.tagName.toLowerCase(), selector: cssSelector(el), action };
  const text = textFrom ? elementText(textFrom, masking) : undefined;
  if (text) out.text = text;
  return out;
}
