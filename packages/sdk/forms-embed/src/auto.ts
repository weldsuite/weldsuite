/**
 * Declarative embeds: elements with a `data-wf` attribute.
 *
 * ```html
 * <div data-wf="frm_abc"></div>                                   <!-- inline -->
 * <div data-wf="frm_abc" data-wf-mode="inline" data-wf-hidden="source=pricing,plan=pro"></div>
 * <button data-wf="frm_abc" data-wf-mode="popup">Contact us</button>   <!-- opens on click -->
 * <button data-wf="frm_abc" data-wf-mode="slider" data-wf-position="left">Feedback</button>
 * <div data-wf="frm_abc" data-wf-mode="popover" data-wf-button-text="Help"></div>
 * <div data-wf="frm_abc" data-wf-mode="fullpage"></div>
 * ```
 *
 * Attributes (all optional except `data-wf`):
 *
 * | attribute | applies to | meaning |
 * |---|---|---|
 * | `data-wf-mode` | all | `inline` (default; `widget` is accepted too), `popup`, `slider`, `popover`, `fullpage` |
 * | `data-wf-hidden` | all | `a=1,b=2`: hidden field values |
 * | `data-wf-base-url` | all | portal origin, default `https://forms.weldsuite.org` |
 * | `data-wf-size` | popup, slider | `small`, `medium` or `large` |
 * | `data-wf-auto-resize` | inline | `false` keeps a fixed height |
 * | `data-wf-height` | inline, popup, popover | `auto` (inline default) or pixels |
 * | `data-wf-width` | popup, slider, popover | pixels |
 * | `data-wf-open` | popup, slider, popover | `click` (default; `manual` too), `load`, `exit`, `scroll` or `scroll:N` |
 * | `data-wf-scroll-percent` | with `scroll` | default 50 |
 * | `data-wf-open-delay` | layers | ms |
 * | `data-wf-hide-after-submit` | layers | `true`: never show again after a submit |
 * | `data-wf-close-after-submit` | layers | ms |
 * | `data-wf-position` | slider (`left`/`right`), popover (`bottom-left`/`bottom-right`) | |
 * | `data-wf-button-text`, `data-wf-button-color`, `data-wf-button-text-color` | popover | |
 * | `data-wf-on-ready`, `data-wf-on-submit`, `data-wf-on-close` | all | name of a global function |
 */

import {
  createFullPage,
  createPopover,
  createPopup,
  createSlider,
  createWidget,
  type BaseOptions,
  type EmbedHandle,
  type LayerOptions,
  type OpenTrigger,
  type PopoverOptions,
  type PopupOptions,
  type SliderOptions,
} from './index';
import { isEmbedMode, parseHiddenAttribute, type EmbedMode } from './protocol';

const SIZES = { small: { width: 420, height: 520 }, medium: { width: 640, height: 700 }, large: { width: 860, height: 820 } } as const

const INIT_MARK = 'data-wf-init';

function bool(value: string | null | undefined): boolean | undefined {
  if (value === null) return undefined;
  return value !== 'false' && value !== '0';
}

function num(value: string | null | undefined): number | undefined {
  if (value === null || value === undefined || value.trim() === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function trigger(value: string | null): { openOn: OpenTrigger; scrollPercent?: number } | undefined {
  if (!value) return undefined;
  // `scroll:60` is the same as `scroll` with a percentage.
  const [name, percent] = value.split(':');
  if (name === 'click') return { openOn: 'manual' }
  if (name !== 'manual' && name !== 'load' && name !== 'exit' && name !== 'scroll') return undefined;
  const scrollPercent = percent !== undefined ? num(percent) : undefined;
  return scrollPercent === undefined ? { openOn: name } : { openOn: name, scrollPercent };
}

/** A global function named in an attribute, or nothing. */
function callback<A extends unknown[]>(name: string | null): ((...args: A) => void) | undefined {
  if (!name) return undefined;
  return (...args: A) => {
    const fn = (window as unknown as Record<string, unknown>)[name];
    if (typeof fn === 'function') (fn as (...a: A) => void)(...args);
  };
}

/** Reads one `data-wf-<name>` attribute. */
type ReadAttribute = (name: string) => string | null;

/** The attributes that only some modes use, as written (`data-wf-position` is `position`). */
type RawAttributes = Record<string, string | null>;

/** `data-wf-mode`: `widget` is another name for `inline`, and a missing or unknown mode is `inline` too. */
function readMode(value: string | null): EmbedMode {
  if (value === 'widget') return 'inline';
  return isEmbedMode(value) ? value : 'inline';
}

/** The options every mode takes: base URL, hidden fields and the callbacks. */
function readBaseOptions(publicId: string, get: ReadAttribute): BaseOptions {
  const base: BaseOptions = { publicId };
  const baseUrl = get('base-url');
  if (baseUrl) base.baseUrl = baseUrl;
  const hidden = parseHiddenAttribute(get('hidden'));
  if (Object.keys(hidden).length > 0) base.hidden = hidden;
  const onReady = callback<[]>(get('on-ready'));
  if (onReady) base.onReady = onReady;
  const onSubmit = callback<[{ publicId: string; responseId: string }]>(get('on-submit'));
  if (onSubmit) base.onSubmit = onSubmit;
  const onClose = callback<[]>(get('on-close'));
  if (onClose) base.onClose = onClose;
  return base;
}

/** The options of the layers (popup, slider, popover): when to open, and what happens after a submit. */
function readLayerOptions(get: ReadAttribute): Omit<LayerOptions, keyof BaseOptions> {
  const layer: Omit<LayerOptions, keyof BaseOptions> = {};
  const open = trigger(get('open'));
  if (open) {
    layer.openOn = open.openOn;
    if (open.scrollPercent !== undefined) layer.scrollPercent = open.scrollPercent;
  }
  const scrollPercent = num(get('scroll-percent'));
  if (scrollPercent !== undefined) layer.scrollPercent = scrollPercent;
  const openDelay = num(get('open-delay'));
  if (openDelay !== undefined) layer.openDelay = openDelay;
  const hide = bool(get('hide-after-submit'));
  if (hide !== undefined) layer.hideAfterSubmit = hide;
  const closeAfter = num(get('close-after-submit'));
  if (closeAfter !== undefined) layer.closeAfterSubmit = closeAfter;
  return layer;
}

/** The options an element's attributes describe. Exported for tests. */
export function readElementOptions(el: HTMLElement): { mode: EmbedMode; base: BaseOptions; layer: Omit<LayerOptions, keyof BaseOptions>; raw: RawAttributes } | null {
  const publicId = el.getAttribute('data-wf');
  if (!publicId) return null;
  const mode = readMode(el.getAttribute('data-wf-mode'));
  const get: ReadAttribute = (name) => el.getAttribute(`data-wf-${name}`);
  const base = readBaseOptions(publicId, get);
  const layer = readLayerOptions(get);
  const raw: RawAttributes = {
    position: get('position'),
    buttonText: get('button-text'),
    buttonColor: get('button-color'),
    buttonTextColor: get('button-text-color'),
    height: get('height'),
    width: get('width'),
    autoResize: get('auto-resize'),
    size: get('size'),
  };
  return { mode, base, layer, raw };
}

/** `inline`: the form in the element; a set height turns `autoResize` off. */
function startInline(el: HTMLElement, base: BaseOptions, raw: RawAttributes, height: number | undefined): EmbedHandle {
  const fixed = height !== undefined;
  return createWidget({
    ...base,
    container: el,
    autoResize: fixed ? false : bool(raw.autoResize) !== false,
    ...(fixed ? { height } : {}),
  });
}

/** `popover`: a floating button; its label is `data-wf-button-text`, else the element's own text. */
function startPopover(el: HTMLElement, options: LayerOptions, raw: RawAttributes, width: number | undefined, height: number | undefined): EmbedHandle {
  const popover: PopoverOptions = { ...options };
  if (raw.position === 'bottom-left' || raw.position === 'bottom-right') popover.position = raw.position;
  const buttonText = raw.buttonText || el.textContent?.trim();
  if (buttonText) popover.buttonText = buttonText;
  if (raw.buttonColor) popover.buttonColor = raw.buttonColor;
  if (raw.buttonTextColor) popover.buttonTextColor = raw.buttonTextColor;
  if (width !== undefined) popover.width = width;
  if (height !== undefined) popover.height = height;
  return createPopover(popover);
}

/** `popup`: a modal. */
function startPopup(options: LayerOptions, width: number | undefined, height: number | undefined): EmbedHandle {
  const popup: PopupOptions = { ...options };
  if (width !== undefined) popup.width = width;
  if (height !== undefined) popup.height = height;
  return createPopup(popup);
}

/** `slider`: a side panel, `left` or `right`. */
function startSlider(options: LayerOptions, raw: RawAttributes, width: number | undefined): EmbedHandle {
  const slider: SliderOptions = { ...options };
  if (raw.position === 'left' || raw.position === 'right') slider.position = raw.position;
  if (width !== undefined) slider.width = width;
  return createSlider(slider);
}

/** A popup or slider opens when its element is clicked: the element is the trigger. */
function openOnClick(el: HTMLElement, handle: EmbedHandle): EmbedHandle {
  el.addEventListener('click', (event) => {
    event.preventDefault();
    handle.open();
  });
  return handle;
}

/** Starts the embed an element describes; null when it has no `data-wf` or already runs. */
export function initElement(el: HTMLElement): EmbedHandle | null {
  if (el.hasAttribute(INIT_MARK)) return null;
  const parsed = readElementOptions(el);
  if (!parsed) return null;
  el.setAttribute(INIT_MARK, '');
  const { mode, base, layer, raw } = parsed;
  const size = raw.size === 'small' || raw.size === 'large' ? raw.size : 'medium';
  const dims = SIZES[size];
  const width = num(raw.width) ?? (mode === 'popup' || mode === 'slider' ? dims.width : undefined);
  const heightPx = num(raw.height) ?? (mode === 'popup' ? dims.height : undefined);
  const options: LayerOptions = { ...base, ...layer };

  switch (mode) {
    case 'inline':
      return startInline(el, base, raw, heightPx);
    case 'fullpage':
      return createFullPage({ ...base, container: el });
    case 'popover':
      return startPopover(el, options, raw, width, heightPx);
    case 'popup':
      return openOnClick(el, startPopup(options, width, heightPx));
    case 'slider':
      return openOnClick(el, startSlider(options, raw, width));
  }
}

/** Starts every not yet started `[data-wf]` element under `root`. */
export function autoInit(root: ParentNode = document): EmbedHandle[] {
  const handles: EmbedHandle[] = [];
  for (const el of Array.from(root.querySelectorAll<HTMLElement>('[data-wf]'))) {
    try {
      const handle = initElement(el);
      if (handle) handles.push(handle);
    } catch {
      // One broken embed must not stop the others (and never the host page).
    }
  }
  return handles;
}

/** Starts embeds for `[data-wf]` elements added later (single page apps). Returns the stop function. */
export function watch(root: Node = document.documentElement): () => void {
  if (typeof MutationObserver === 'undefined') return () => undefined;
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of Array.from(record.addedNodes)) {
        if (!(node instanceof HTMLElement)) continue;
        if (node.hasAttribute('data-wf')) initElement(node);
        autoInit(node);
      }
    }
  });
  observer.observe(root, { childList: true, subtree: true });
  return () => observer.disconnect();
}
