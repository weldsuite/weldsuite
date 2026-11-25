/**
 * What the content script draws on a page (ADR PASS-009):
 *
 * - the icon in a login field: a button, no data;
 * - the inline menu and the save bar: extension pages in iframes, so the page
 *   can't read the list of logins or the bar's text.
 *
 * Each sits in a closed shadow root on an element of its own, shown as a
 * popover: the top layer, above the page's own stacking contexts. Inline
 * `!important` styles keep page CSS off the host element. A frame's size is
 * fixed per kind and never depends on its content, so a page measuring it
 * learns nothing about the logins inside.
 */

import { logoSvg } from '../lib/logo';
import type { FieldKind } from '../lib/protocol';

const HOST_STYLE = [
  'all: initial',
  'position: fixed',
  'inset: auto',
  'margin: 0',
  'padding: 0',
  'border: 0',
  'background: transparent',
  'overflow: visible',
  'display: block',
  'opacity: 1',
  'visibility: visible',
  'transform: none',
  'filter: none',
  'pointer-events: auto',
  'z-index: 2147483647',
  'width: 0',
  'height: 0',
]
  .map((rule) => `${rule} !important`)
  .join('; ');

/** A fixed-position, top-layer element with a closed shadow root. */
class Layer {
  readonly host: HTMLElement;
  protected readonly root: ShadowRoot;

  constructor(name: string) {
    // An undefined custom element name: no page rule for `div` or `iframe` reaches it.
    this.host = document.createElement(`weldpass-${name}`);
    this.host.setAttribute('popover', 'manual');
    this.host.style.cssText = HOST_STYLE;
    this.root = this.host.attachShadow({ mode: 'closed' });
  }

  protected place(left: number, top: number, width: number, height: number): void {
    const style = this.host.style;
    style.setProperty('left', `${Math.round(left)}px`, 'important');
    style.setProperty('top', `${Math.round(top)}px`, 'important');
    style.setProperty('width', `${Math.round(width)}px`, 'important');
    style.setProperty('height', `${Math.round(height)}px`, 'important');
  }

  protected attach(): void {
    if (!this.host.isConnected) document.documentElement.append(this.host);
    try {
      if (!this.host.matches(':popover-open')) this.host.showPopover();
    } catch {
      // Older engines: a fixed element with the highest z-index is the fallback.
    }
  }

  contains(node: EventTarget | null): boolean {
    return node === this.host;
  }

  remove(): void {
    try {
      if (this.host.matches(':popover-open')) this.host.hidePopover();
    } catch {
      // Not shown.
    }
    this.host.remove();
  }
}

const ICON_SIZE = 22;

const ICON_SVG = logoSvg(12);

/** The WeldPass icon at the end of a field. Opens the menu; holds nothing. */
export class FieldIcon extends Layer {
  private readonly button: HTMLButtonElement;
  field: HTMLInputElement | null = null;

  constructor(label: string, onActivate: (keyboard: boolean) => void) {
    super('icon');
    const style = document.createElement('style');
    style.textContent = `
      button {
        all: initial; box-sizing: border-box; width: ${ICON_SIZE}px; height: ${ICON_SIZE}px;
        display: grid; place-items: center; border-radius: 6px; cursor: pointer;
        color: #fff; background: oklch(0.51 0.23 277); box-shadow: 0 1px 2px rgb(0 0 0 / 0.25);
      }
      button:hover { background: oklch(0.45 0.23 277); }
      button:focus-visible { outline: 2px solid oklch(0.6 0.2 277); outline-offset: 2px; }
    `;
    this.button = document.createElement('button');
    this.button.type = 'button';
    this.button.title = label;
    this.button.setAttribute('aria-label', label);
    this.button.innerHTML = ICON_SVG;
    // Keep the field focused: a click on the icon is not a reason to blur it.
    this.button.addEventListener('mousedown', (event) => event.preventDefault());
    this.button.addEventListener('click', (event) => {
      if (event.isTrusted) onActivate(event.detail === 0);
    });
    this.root.append(style, this.button);
  }

  show(field: HTMLInputElement): void {
    this.field = field;
    this.attach();
    this.reposition();
  }

  reposition(): void {
    const field = this.field;
    if (!field?.isConnected) {
      this.hide();
      return;
    }
    const rect = field.getBoundingClientRect();
    if (rect.width < 40 || rect.height < 16 || rect.bottom < 0 || rect.top > window.innerHeight) {
      this.host.style.setProperty('display', 'none', 'important');
      return;
    }
    this.host.style.setProperty('display', 'block', 'important');
    const inset = Math.max(4, (rect.height - ICON_SIZE) / 2);
    this.place(rect.right - ICON_SIZE - Math.min(inset, 8), rect.top + (rect.height - ICON_SIZE) / 2, ICON_SIZE, ICON_SIZE);
  }

  hide(): void {
    this.field = null;
    this.remove();
  }
}

/** Fixed sizes per kind: the frame's size never says how many logins it lists. */
const MENU_SIZE: Record<FieldKind, { width: number; height: number }> = {
  login: { width: 320, height: 268 },
  'one-time-code': { width: 320, height: 208 },
  'new-password': { width: 340, height: 196 },
};

function frame(src: string, title: string): HTMLIFrameElement {
  const iframe = document.createElement('iframe');
  iframe.src = src;
  iframe.title = title;
  iframe.setAttribute('allow', '');
  iframe.setAttribute('referrerpolicy', 'no-referrer');
  iframe.style.cssText = [
    'all: initial',
    'display: block',
    'width: 100%',
    'height: 100%',
    'border: 0',
    'border-radius: 10px',
    'box-shadow: 0 8px 28px rgb(0 0 0 / 0.22), 0 0 0 1px rgb(0 0 0 / 0.08)',
    'color-scheme: normal',
    'background: transparent',
  ]
    .map((rule) => `${rule} !important`)
    .join('; ');
  return iframe;
}

/** The inline menu: `menu.html` framed under (or over) the field. */
export class MenuFrame extends Layer {
  private readonly iframe: HTMLIFrameElement;

  constructor(
    readonly nonce: string,
    readonly kind: FieldKind,
    readonly field: HTMLInputElement,
    keyboard: boolean,
    title: string,
  ) {
    super('menu');
    const params = new URLSearchParams({ n: nonce, k: keyboard ? '1' : '0' });
    this.iframe = frame(`${chrome.runtime.getURL('menu.html')}#${params}`, title);
    this.root.append(this.iframe);
    this.attach();
    this.reposition();
    if (keyboard) this.iframe.focus();
  }

  reposition(): boolean {
    if (!this.field.isConnected) return false;
    const rect = this.field.getBoundingClientRect();
    const { width, height } = MENU_SIZE[this.kind];
    const gap = 4;
    const below = rect.bottom + gap;
    const top = below + height <= window.innerHeight || rect.top - gap - height < 0 ? below : rect.top - gap - height;
    const left = Math.min(Math.max(8, rect.left), Math.max(8, window.innerWidth - width - 8));
    this.place(left, top, width, height);
    return true;
  }
}

/** The save bar: `prompt.html` framed in the top right corner of the top frame. */
export class PromptFrame extends Layer {
  constructor(
    readonly nonce: string,
    title: string,
  ) {
    super('prompt');
    const params = new URLSearchParams({ n: nonce });
    this.root.append(frame(`${chrome.runtime.getURL('prompt.html')}#${params}`, title));
    this.attach();
    this.reposition();
  }

  reposition(): void {
    const width = Math.min(380, window.innerWidth - 24);
    this.place(window.innerWidth - width - 12, 12, width, 196);
  }
}
