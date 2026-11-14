/**
 * Frustration signals, worked out in the browser from what the page does
 * anyway: clicks, scrolling, navigation, errors. Each detector is a small
 * piece of state the client feeds; none of them adds listeners of its own
 * except the dead-click watch, which observes the DOM only for the second
 * after a click on something that looks clickable.
 */

import { maskText } from './autocapture';
import { MAX_ERROR_MESSAGE, MAX_STRING } from './wire';

export const RAGE_CLICKS = 3;
export const RAGE_WINDOW_MS = 700;
export const RAGE_RADIUS_PX = 30;
export const DEAD_CLICK_MS = 1000;
export const QUICK_BACK_MS = 7000;
export const SCROLL_WINDOW_MS = 20000;
export const SCROLL_TURNS = 4;
export const SCROLL_PAGES = 3;
/** Errors sent per page load at most, after de-duplication. */
export const MAX_EXCEPTIONS = 20;

/** What looks clickable, besides anything with `cursor: pointer`. */
export const CLICKABLE = 'a,button,[role=button],input[type=submit],input[type=button],[onclick]';
/**
 * Clicks that legitimately change nothing on the page: fields and labels
 * (focus, a checkbox's `checked`), downloads, and links that open another app.
 */
const NOT_DEAD =
  'input:not([type=submit]):not([type=button]),select,textarea,label,[contenteditable],' +
  'a[download],a[href^="mailto:"],a[href^="tel:"]';

/**
 * Rage clicks: feed every pointer click; true for the click that makes
 * {@link RAGE_CLICKS} within {@link RAGE_WINDOW_MS} and {@link RAGE_RADIUS_PX}
 * of each other. Once per burst: clicking on keeps it going without another.
 */
export function rageClicks(): (t: number, x: number, y: number) => boolean {
  let clicks: number[][] = [];
  return (t, x, y) => {
    clicks = clicks.filter(([ct, cx, cy]) => t - ct < RAGE_WINDOW_MS && (cx - x) ** 2 + (cy - y) ** 2 <= RAGE_RADIUS_PX ** 2);
    clicks.push([t, x, y]);
    return clicks.length === RAGE_CLICKS;
  };
}

/** The element a click on `target` counts as a possible dead click for, or null. */
export function deadClickCandidate(target: Element): Element | null {
  if (target.closest(NOT_DEAD)) return null;
  const el = target.closest(CLICKABLE);
  if (el) return el;
  try {
    return getComputedStyle(target).cursor === 'pointer' ? target : null;
  } catch {
    return null;
  }
}

/**
 * Excessive scrolling: feed the scroll position; true once direction has
 * changed {@link SCROLL_TURNS} times while scrolling past {@link SCROLL_PAGES}
 * window heights, all within {@link SCROLL_WINDOW_MS}. Then it starts over.
 */
export function excessiveScroll(): (t: number, y: number, windowHeight: number) => boolean {
  /** Runs in one direction: start time, distance. */
  let runs: number[][] = [];
  let lastY = -1;
  let dir = 0;
  return (t, y, windowHeight) => {
    const delta = lastY < 0 ? 0 : y - lastY;
    lastY = y;
    if (!delta) return false;
    if (Math.sign(delta) !== dir) {
      dir = Math.sign(delta);
      runs.push([t, 0]);
    }
    runs[runs.length - 1][1] += Math.abs(delta);
    runs = runs.filter((r) => t - r[0] <= SCROLL_WINDOW_MS);
    const distance = runs.reduce((sum, r) => sum + r[1], 0);
    // Each run after the first began with a turn.
    if (runs.length > SCROLL_TURNS && distance >= SCROLL_PAGES * windowHeight) {
      runs = [];
      dir = 0;
      return true;
    }
    return false;
  };
}

/** Where the visitor just was, for quick backs. Kept in sessionStorage with consent, so it survives a full page load. */
export interface NavRecord {
  /** The page's key (URL without a non-route hash). */
  k: string;
  /** Its path. */
  p: string;
  /** When it was shown. */
  t: number;
  /** The key of the page before it. */
  b?: string;
}

/**
 * The page left in a quick back: arriving at `key` at `t`, when the last page
 * (`last`) was shown less than {@link QUICK_BACK_MS} ago and came from `key`.
 */
export function quickBackFrom(last: NavRecord | null | undefined, key: string, t: number): string | null {
  return last && last.b === key && last.k !== key && t - last.t < QUICK_BACK_MS ? last.p : null;
}

export interface ExceptionInfo {
  message: string;
  source?: string;
  line?: number;
  col?: number;
}

/** A script URL without its query or hash (they can hold tokens), at most 2048 characters. */
function scriptUrl(url: unknown): string | undefined {
  return typeof url === 'string' && url ? url.split(/[?#]/)[0].slice(0, MAX_STRING) : undefined;
}

/**
 * The error behind an `error` or `unhandledrejection` event: message (with
 * email addresses and long numbers masked, like element text), script, line
 * and column. Null for an event that carries no error.
 */
export function exceptionInfo(e: Event): ExceptionInfo | null {
  let message: string;
  let source: string | undefined;
  let line: number | undefined;
  let col: number | undefined;
  if (e.type === 'unhandledrejection') {
    const reason = (e as PromiseRejectionEvent).reason as unknown;
    if (reason instanceof Error) {
      message = `${reason.name}: ${reason.message}`;
      // The first frame with a URL: `at f (https://x/app.js:12:34)` or `f@https://x/app.js:12:34`.
      const frame = /(https?:\/\/[^\s)]+?):(\d+):(\d+)/.exec(reason.stack || '');
      if (frame) {
        source = frame[1];
        line = +frame[2];
        col = +frame[3];
      }
    } else message = `Unhandled rejection: ${typeof reason === 'string' ? reason : String(reason)}`;
  } else {
    const err = e as ErrorEvent;
    message = err.message || (err.error instanceof Error ? `${err.error.name}: ${err.error.message}` : '');
    source = err.filename;
    line = err.lineno;
    col = err.colno;
  }
  message = maskText(message.replace(/\s+/g, ' ').trim()).slice(0, MAX_ERROR_MESSAGE);
  if (!message) return null;
  const info: ExceptionInfo = { message };
  const src = scriptUrl(source);
  if (src) info.source = src;
  if (typeof line === 'number' && line > 0) info.line = line;
  if (typeof col === 'number' && col > 0) info.col = col;
  return info;
}

/** The de-duplication key: one `$exception` per message, script and line per session. */
export function exceptionKey(info: ExceptionInfo): string {
  return `${info.message}|${info.source || ''}|${info.line || 0}`;
}

/**
 * Calls `onRequest` with the URL (`''` for an XHR) whenever the page starts a
 * `fetch` or an XHR, for the dead-click check. Returns the undo. The wrappers
 * only look and hand over: what the page gets back is unchanged.
 */
export function watchRequests(onRequest: (url: string) => void): () => void {
  const undo: Array<() => void> = [];
  const w = window as Window & typeof globalThis;
  const originalFetch = w.fetch;
  if (typeof originalFetch === 'function') {
    const wrapped = function (this: unknown, ...args: Parameters<typeof fetch>) {
      try {
        const input = args[0];
        onRequest(typeof input === 'string' ? input : input instanceof URL ? input.href : String((input && input.url) || ''));
      } catch {
        // Never in the way of the page's request.
      }
      return originalFetch.apply(this, args);
    };
    w.fetch = wrapped;
    undo.push(() => {
      if (w.fetch === wrapped) w.fetch = originalFetch;
    });
  }
  const proto = typeof XMLHttpRequest === 'function' ? XMLHttpRequest.prototype : null;
  if (proto) {
    const originalSend = proto.send;
    const wrappedSend = function (this: XMLHttpRequest, ...args: Parameters<XMLHttpRequest['send']>) {
      try {
        onRequest('');
      } catch {
        // As above.
      }
      return originalSend.apply(this, args);
    };
    proto.send = wrappedSend;
    undo.push(() => {
      if (proto.send === wrappedSend) proto.send = originalSend;
    });
  }
  return () => {
    for (const u of undo) u();
  };
}
