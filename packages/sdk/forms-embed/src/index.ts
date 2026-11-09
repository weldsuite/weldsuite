/**
 * @weldsuite/forms-embed: show a WeldForms form on any website.
 *
 * ```ts
 * createWidget({ publicId: 'frm_abc', container: '#form' });          // inline
 * createPopup({ publicId: 'frm_abc', openOn: 'exit' });               // modal
 * createSlider({ publicId: 'frm_abc', position: 'right' });           // side panel
 * createPopover({ publicId: 'frm_abc', buttonText: 'Feedback' });     // floating button
 * createFullPage({ publicId: 'frm_abc' });                            // the whole page
 * ```
 *
 * Or without JavaScript: `<div data-wf="frm_abc" data-wf-mode="inline"></div>`
 * plus `<script src="https://forms.weldsuite.org/embed.js" async></script>`
 * (see ./auto.ts for the attributes).
 *
 * Everything is drawn with inline styles set from script (no <style> tag), so
 * a strict Content-Security-Policy on the host page does not break it.
 */

import {
  DEFAULT_BASE_URL,
  embedUrl,
  isPortalMessage,
  type EmbedMode,
  type PortalMessage,
} from './protocol';

export { DEFAULT_BASE_URL, EMBED_MODES, PROTOCOL_VERSION, embedUrl, isPortalMessage, parseHiddenAttribute } from './protocol';
export type { EmbedMode, PortalMessage } from './protocol';

export interface SubmitEvent {
  publicId: string;
  responseId: string;
}

export interface BaseOptions {
  /** The form's public id (the part after `/f/` in its link). */
  publicId: string;
  /** Where the form is served; default `https://forms.weldsuite.org`. */
  baseUrl?: string;
  /** Values for the form's hidden fields; only names the form declares are used. */
  hidden?: Record<string, string>;
  onReady?: () => void;
  onSubmit?: (event: SubmitEvent) => void;
  onClose?: () => void;
  /**
   * The form's ending redirects. Return `false` to handle it yourself;
   * otherwise the host page navigates to the URL (http and https only).
   */
  onRedirect?: (url: string) => boolean | void;
}

export type OpenTrigger = 'manual' | 'load' | 'exit' | 'scroll';

export interface LayerOptions extends BaseOptions {
  /** When to open by itself; default `manual`. */
  openOn?: OpenTrigger;
  /** With `openOn: 'scroll'`: the scroll depth in percent; default 50. */
  scrollPercent?: number;
  /** Wait this long (ms) after the trigger before opening. */
  openDelay?: number;
  /** Never open again (nor show the button) in this browser once the form was submitted. */
  hideAfterSubmit?: boolean;
  /** Close the layer this long (ms) after a submit; default: stays open until the visitor closes it. */
  closeAfterSubmit?: number;
}

export interface WidgetOptions extends BaseOptions {
  /** An element or a selector for the element that receives the form. */
  container: HTMLElement | string;
  /** Follow the form's content height; default true. */
  autoResize?: boolean;
  /** Height before the form reports its own, and the fixed height without `autoResize`; default `500px`. */
  height?: string | number;
}

export interface PopupOptions extends LayerOptions {
  width?: number;
  height?: number;
}

export interface SliderOptions extends LayerOptions {
  position?: 'left' | 'right';
  width?: number;
}

export interface PopoverOptions extends LayerOptions {
  position?: 'bottom-right' | 'bottom-left';
  buttonText?: string;
  buttonColor?: string;
  buttonTextColor?: string;
  width?: number;
  height?: number;
}

export interface FullPageOptions extends BaseOptions {
  /** The element the form fills; default the whole window. */
  container?: HTMLElement | string;
}

export interface EmbedHandle {
  readonly iframe: HTMLIFrameElement | null;
  readonly isOpen: boolean;
  open(): void;
  close(): void;
  toggle(): void;
  /** Removes everything the SDK added and stops listening. */
  destroy(): void;
}

const Z_INDEX = '2147483000';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function css(el: HTMLElement, style: Partial<CSSStyleDeclaration>): void {
  Object.assign(el.style, style);
}

function resolveElement(target: HTMLElement | string): HTMLElement {
  if (typeof target !== 'string') return target;
  const el = document.querySelector<HTMLElement>(target);
  if (!el) throw new Error(`WeldForms: no element matches "${target}"`);
  return el;
}

function px(value: string | number): string {
  return typeof value === 'number' ? `${value}px` : value;
}

const storageKey = (publicId: string) => `wf:submitted:${publicId}`;

function wasSubmitted(publicId: string): boolean {
  try {
    return window.localStorage.getItem(storageKey(publicId)) === '1';
  } catch {
    return false;
  }
}

function rememberSubmitted(publicId: string): void {
  try {
    window.localStorage.setItem(storageKey(publicId), '1');
  } catch {
    // Storage can be blocked; the form still works.
  }
}

function isSafeRedirect(url: string): boolean {
  try {
    const u = new URL(url, window.location.href);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
}

/** The iframe plus the message listener that is tied to it. */
function createFrame(
  options: BaseOptions,
  mode: EmbedMode,
  handlers: { onHeight?: (height: number) => void; onClose?: () => void; onSubmitted?: () => void },
): { iframe: HTMLIFrameElement; destroy: () => void } {
  const src = embedUrl({ baseUrl: options.baseUrl, publicId: options.publicId, mode, hidden: options.hidden });
  const origin = new URL(src).origin;
  const iframe = document.createElement('iframe');
  iframe.src = src;
  iframe.title = 'WeldForms';
  iframe.setAttribute('allow', 'clipboard-write; fullscreen');
  iframe.setAttribute('loading', mode === 'inline' ? 'lazy' : 'eager');
  css(iframe, { border: '0', width: '100%', height: '100%', display: 'block', background: 'transparent' });

  function onMessage(event: MessageEvent): void {
    // Only our own iframe, from the portal's origin, speaking our protocol.
    if (event.source !== iframe.contentWindow || event.origin !== origin) return;
    const data: unknown = event.data;
    if (!isPortalMessage(data) || data.publicId !== options.publicId) return;
    handle(data);
  }

  function handle(message: PortalMessage): void {
    switch (message.type) {
      case 'ready':
        options.onReady?.();
        break;
      case 'height':
        handlers.onHeight?.(message.height);
        break;
      case 'submitted':
        options.onSubmit?.({ publicId: options.publicId, responseId: message.responseId });
        handlers.onSubmitted?.();
        break;
      case 'close':
        handlers.onClose?.();
        break;
      case 'redirect':
        if (options.onRedirect?.(message.url) === false) break;
        if (isSafeRedirect(message.url)) window.location.assign(message.url);
        break;
    }
  }

  window.addEventListener('message', onMessage);
  return {
    iframe,
    destroy: () => {
      window.removeEventListener('message', onMessage);
      iframe.remove();
    },
  };
}

/** Wires `openOn` for a layer; returns the cleanup. */
function armTrigger(options: LayerOptions, open: () => void): () => void {
  const trigger = options.openOn ?? 'manual';
  if (trigger === 'manual') return () => undefined;
  let done = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const fire = () => {
    if (done) return;
    done = true;
    cleanup();
    const run = () => {
      if (options.hideAfterSubmit && wasSubmitted(options.publicId)) return;
      open();
    };
    if (options.openDelay && options.openDelay > 0) timer = setTimeout(run, options.openDelay);
    else run();
  };
  const onLeave = (e: MouseEvent) => {
    if (e.clientY <= 0) fire();
  };
  const onScroll = () => {
    const doc = document.documentElement;
    const scrollable = doc.scrollHeight - window.innerHeight;
    const percent = scrollable <= 0 ? 100 : (window.scrollY / scrollable) * 100;
    if (percent >= (options.scrollPercent ?? 50)) fire();
  };
  function cleanup() {
    document.removeEventListener('mouseleave', onLeave);
    window.removeEventListener('scroll', onScroll);
  }
  if (trigger === 'load') {
    // After the current task, so the caller can keep the handle first.
    timer = setTimeout(fire, 0);
  } else if (trigger === 'exit') {
    document.addEventListener('mouseleave', onLeave);
  } else {
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
  }
  return () => {
    done = true;
    cleanup();
    if (timer) clearTimeout(timer);
  };
}

// ---------------------------------------------------------------------------
// Widget (inline)
// ---------------------------------------------------------------------------

export function createWidget(options: WidgetOptions): EmbedHandle {
  const container = resolveElement(options.container);
  const autoResize = options.autoResize !== false;
  const frame = createFrame(options, 'inline', {
    onHeight: (height) => {
      if (autoResize) frame.iframe.style.height = `${Math.ceil(height)}px`;
    },
  });
  css(frame.iframe, { height: px(options.height ?? '500px') });
  container.appendChild(frame.iframe);
  return {
    iframe: frame.iframe,
    isOpen: true,
    open: () => undefined,
    close: () => undefined,
    toggle: () => undefined,
    destroy: frame.destroy,
  };
}

// ---------------------------------------------------------------------------
// Layers: popup, slider, popover share open/close, focus and storage
// ---------------------------------------------------------------------------

interface LayerParts {
  /** The element that shows and hides. */
  root: HTMLElement;
  /** Where the iframe goes. */
  host: HTMLElement;
  show(): void;
  hide(): void;
  destroy?(): void;
}

function createLayer(options: LayerOptions, mode: EmbedMode, build: (close: () => void, toggle: () => void) => LayerParts): EmbedHandle {
  let open = false;
  let frame: ReturnType<typeof createFrame> | null = null;
  let previousFocus: Element | null = null;
  let previousOverflow: string | null = null;
  let closeTimer: ReturnType<typeof setTimeout> | null = null;
  const lockScroll = mode === 'popup' || mode === 'slider';

  const handle: EmbedHandle = {
    get iframe() {
      return frame?.iframe ?? null;
    },
    get isOpen() {
      return open;
    },
    open: doOpen,
    close: doClose,
    toggle: () => (open ? doClose() : doOpen()),
    destroy,
  };

  const parts = build(doClose, () => handle.toggle());
  const disarm = armTrigger(options, doOpen);

  function onKey(e: KeyboardEvent) {
    if (e.key === 'Escape' && open) doClose();
  }

  function doOpen() {
    if (open) return;
    if (options.hideAfterSubmit && wasSubmitted(options.publicId)) return;
    open = true;
    if (!frame) {
      frame = createFrame(options, mode, {
        onClose: doClose,
        onSubmitted: () => {
          if (options.hideAfterSubmit) rememberSubmitted(options.publicId);
          if (options.closeAfterSubmit !== undefined) closeTimer = setTimeout(doClose, options.closeAfterSubmit);
        },
      });
      parts.host.appendChild(frame.iframe);
    }
    previousFocus = document.activeElement;
    if (lockScroll) {
      previousOverflow = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
    }
    parts.show();
    document.addEventListener('keydown', onKey);
    frame.iframe.focus();
  }

  function doClose() {
    if (!open) return;
    open = false;
    if (closeTimer) clearTimeout(closeTimer);
    parts.hide();
    document.removeEventListener('keydown', onKey);
    if (lockScroll && previousOverflow !== null) document.body.style.overflow = previousOverflow;
    if (previousFocus instanceof HTMLElement) previousFocus.focus();
    options.onClose?.();
  }

  function destroy() {
    disarm();
    if (closeTimer) clearTimeout(closeTimer);
    document.removeEventListener('keydown', onKey);
    if (open && lockScroll && previousOverflow !== null) document.body.style.overflow = previousOverflow;
    open = false;
    frame?.destroy();
    parts.destroy?.();
    parts.root.remove();
  }

  return handle;
}

function closeButton(onClick: () => void, style: Partial<CSSStyleDeclaration>): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.setAttribute('aria-label', 'Close');
  button.textContent = '×';
  css(button, {
    position: 'absolute',
    zIndex: '2',
    width: '32px',
    height: '32px',
    border: '0',
    borderRadius: '16px',
    background: 'rgba(255,255,255,0.9)',
    color: '#111827',
    font: '22px/32px system-ui, sans-serif',
    cursor: 'pointer',
    padding: '0',
    boxShadow: '0 1px 4px rgba(0,0,0,0.25)',
    ...style,
  });
  button.addEventListener('click', onClick);
  return button;
}

export function createPopup(options: PopupOptions): EmbedHandle {
  return createLayer(options, 'popup', (close) => {
    const overlay = document.createElement('div');
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    css(overlay, {
      position: 'fixed',
      inset: '0',
      zIndex: Z_INDEX,
      display: 'none',
      alignItems: 'center',
      justifyContent: 'center',
      background: 'rgba(0,0,0,0.55)',
      opacity: '0',
      transition: 'opacity 0.2s ease',
    });
    const panel = document.createElement('div');
    css(panel, {
      position: 'relative',
      width: `min(${options.width ?? 720}px, 96vw)`,
      height: `min(${options.height ?? 760}px, 92vh)`,
      overflow: 'hidden',
      borderRadius: '12px',
      background: '#ffffff',
      boxShadow: '0 20px 60px rgba(0,0,0,0.35)',
    });
    overlay.addEventListener('mousedown', (e) => {
      if (e.target === overlay) close();
    });
    panel.appendChild(closeButton(close, { top: '10px', right: '10px' }));
    overlay.appendChild(panel);
    document.body.appendChild(overlay);
    return {
      root: overlay,
      host: panel,
      show: () => {
        overlay.style.display = 'flex';
        requestAnimationFrame(() => {
          overlay.style.opacity = '1';
        });
      },
      hide: () => {
        overlay.style.opacity = '0';
        overlay.style.display = 'none';
      },
    };
  });
}

export function createSlider(options: SliderOptions): EmbedHandle {
  const side = options.position === 'left' ? 'left' : 'right';
  return createLayer(options, 'slider', (close) => {
    const overlay = document.createElement('div');
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    css(overlay, { position: 'fixed', inset: '0', zIndex: Z_INDEX, display: 'none', background: 'rgba(0,0,0,0.35)' });
    const panel = document.createElement('div');
    const offscreen = side === 'right' ? 'translateX(100%)' : 'translateX(-100%)';
    css(panel, {
      position: 'absolute',
      top: '0',
      bottom: '0',
      [side]: '0',
      width: `min(${options.width ?? 480}px, 100vw)`,
      background: '#ffffff',
      boxShadow: '0 0 40px rgba(0,0,0,0.3)',
      transform: offscreen,
      transition: 'transform 0.3s ease',
    } as Partial<CSSStyleDeclaration>);
    overlay.addEventListener('mousedown', (e) => {
      if (e.target === overlay) close();
    });
    panel.appendChild(closeButton(close, { top: '10px', [side === 'right' ? 'left' : 'right']: '10px' } as Partial<CSSStyleDeclaration>));
    overlay.appendChild(panel);
    document.body.appendChild(overlay);
    return {
      root: overlay,
      host: panel,
      show: () => {
        overlay.style.display = 'block';
        requestAnimationFrame(() => {
          panel.style.transform = 'translateX(0)';
        });
      },
      hide: () => {
        panel.style.transform = offscreen;
        overlay.style.display = 'none';
      },
    };
  });
}

export function createPopover(options: PopoverOptions): EmbedHandle {
  const left = options.position === 'bottom-left';
  return createLayer(options, 'popover', (_close, toggle) => {
    const root = document.createElement('div');
    css(root, { position: 'fixed', bottom: '20px', [left ? 'left' : 'right']: '20px', zIndex: Z_INDEX } as Partial<CSSStyleDeclaration>);
    const panel = document.createElement('div');
    css(panel, {
      display: 'none',
      position: 'absolute',
      bottom: '68px',
      [left ? 'left' : 'right']: '0',
      width: `min(${options.width ?? 380}px, calc(100vw - 40px))`,
      height: `min(${options.height ?? 600}px, calc(100vh - 110px))`,
      overflow: 'hidden',
      borderRadius: '12px',
      background: '#ffffff',
      boxShadow: '0 10px 40px rgba(0,0,0,0.3)',
    } as Partial<CSSStyleDeclaration>);
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = options.buttonText ?? 'Open form';
    button.setAttribute('aria-expanded', 'false');
    css(button, {
      height: '52px',
      padding: '0 22px',
      border: '0',
      borderRadius: '26px',
      background: options.buttonColor ?? '#2563eb',
      color: options.buttonTextColor ?? '#ffffff',
      font: '600 15px/1 system-ui, sans-serif',
      cursor: 'pointer',
      boxShadow: '0 4px 14px rgba(0,0,0,0.3)',
    });
    button.addEventListener('click', toggle);
    root.append(panel, button);
    document.body.appendChild(root);
    if (options.hideAfterSubmit && wasSubmitted(options.publicId)) root.style.display = 'none';
    return {
      root,
      host: panel,
      show: () => {
        panel.style.display = 'block';
        button.setAttribute('aria-expanded', 'true');
      },
      hide: () => {
        panel.style.display = 'none';
        button.setAttribute('aria-expanded', 'false');
      },
    };
  });
}

export function createFullPage(options: FullPageOptions): EmbedHandle {
  const container = options.container ? resolveElement(options.container) : document.body;
  const frame = createFrame(options, 'fullpage', {});
  const whole = container === document.body;
  css(frame.iframe, {
    position: whole ? 'fixed' : 'absolute',
    inset: '0',
    width: '100%',
    height: '100%',
    zIndex: whole ? Z_INDEX : '1',
  });
  if (!whole && getComputedStyle(container).position === 'static') container.style.position = 'relative';
  const previousOverflow = whole ? document.body.style.overflow : null;
  if (whole) document.body.style.overflow = 'hidden';
  container.appendChild(frame.iframe);
  return {
    iframe: frame.iframe,
    isOpen: true,
    open: () => undefined,
    close: () => undefined,
    toggle: () => undefined,
    destroy: () => {
      if (previousOverflow !== null) document.body.style.overflow = previousOverflow;
      frame.destroy();
    },
  };
}

export const version = '0.1.0';
