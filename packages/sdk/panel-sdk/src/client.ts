/**
 * The browser client: pageviews, page leaves, autocapture and custom events,
 * consent and opt-out, batching and sending.
 *
 * Nothing in here may throw into the host page: every listener and patched
 * History method runs through `safe()`.
 */

import { clickTarget, describeElement, isBlocked } from './autocapture';
import { buildBatches } from './batch';
import { excludedMatcher, resolveConfig } from './config';
import { cleanProps, isCustomEventName, LIB_VERSION, normalizeEvent, type EventInput } from './event';
import {
  clearState,
  isOptedOut,
  newState,
  OPT_OUT_KEY,
  readState,
  setOptedOut,
  stateKey,
  touchSession,
  writeState,
  type VisitorState,
} from './storage';
import type { ClientConfig, WireEvent } from './wire';

/** Send at least every 5 seconds while events are waiting… */
export const FLUSH_INTERVAL_MS = 5000;
/** …or as soon as this many are. */
export const FLUSH_AT = 20;
/** The one retry after a network failure waits this long. */
const RETRY_DELAY_MS = 1500;

export interface ClientOptions {
  /** The project token, `wpk_…`. */
  token: string;
  /** The collector's origin, no trailing slash. */
  host: string;
  /** Warn in the console about dropped events and properties. */
  debug?: boolean;
}

/** The public API: `window.weldpanel`, and what `init()` returns. */
export interface WeldPanel {
  readonly version: string;
  /** A custom event. Flat properties only: strings, finite numbers, booleans, null. */
  track(name: string, props?: Record<string, unknown>): void;
  consent: {
    /** The visitor agreed: keep an anonymous id and a session id from now on. */
    grant(): void;
    /** The visitor withdrew: delete what is stored and go back to cookieless counting. */
    revoke(): void;
  };
  /** Send nothing at all, now and on later visits, until `optIn()`. */
  optOut(): void;
  optIn(): void;
  /** Send waiting events now. */
  flush(): Promise<void>;
}

export interface Client {
  api: WeldPanel;
  /** Begin collecting with the project's config; calls made before this run now. */
  start(config: Partial<ClientConfig>): void;
  /** The config could not be loaded: collect nothing on this page. */
  fail(reason: unknown): void;
  /** Remove listeners and restore `history`. */
  destroy(): void;
}

interface Page {
  /** The URL without its hash (unless the hash is a route, `#/…` or `#!…`): one pageview per key. */
  key: string;
  url: string;
  title: string;
  path: string;
  /** Furthest scroll reached, percent. */
  depth: number;
  left: boolean;
}

type Handler = (e: Event) => void;

export function createClient(options: ClientOptions): Client {
  const { token } = options;
  const endpoint = `${options.host}/e`;
  const warn = (...args: unknown[]): void => {
    if (options.debug) console.warn('[weldpanel]', ...args);
  };
  const safe =
    <A extends unknown[]>(fn: (...a: A) => void) =>
    (...a: A): void => {
      try {
        fn(...a);
      } catch (err) {
        warn(err);
      }
    };

  let config: ClientConfig | null = null;
  // Until the config arrives no path is excluded (and nothing is sent anyway).
  let excluded: (path: string) => boolean = excludedMatcher([]);
  /** Calls made before the config arrived: `[changes state, run]`. Null once started. */
  let pending: Array<[boolean, () => void]> | null = [];
  /** The visitor's ids. Non-null exactly when there is consent (or none is needed). */
  let state: VisitorState | null = null;
  let optedOut = isOptedOut();
  let queue: WireEvent[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let page: Page | null = null;
  /** `document.referrer` belongs to the first pageview of the page load only. */
  let referrer: string | undefined = document.referrer || undefined;
  const cleanup: Array<() => void> = [];

  // ── Consent ──────────────────────────────────────────────────────────

  const gpc = (): boolean => (navigator as Navigator & { globalPrivacyControl?: boolean }).globalPrivacyControl === true;

  /** Consent as the page starts, or after `optIn()`: stored grant, else the project's mode. */
  function initialConsent(): void {
    if (!config) return;
    const stored = readState(token);
    // A Global Privacy Control signal counts as no consent until the site calls grant(), in either mode.
    const noneNeeded = config.consentMode === 'none' && !gpc();
    if (optedOut) state = null;
    else if (stored && (stored.g === 1 || noneNeeded)) state = stored;
    else state = noneNeeded ? newState(false, Date.now()) : null;
    // Ids kept under settings that no longer allow them (consent mode changed, GPC, opt-out) go.
    if (stored && state !== stored) clearState(token);
    if (state && state !== stored) writeState(token, state);
  }

  function grant(): void {
    if (!config) return;
    if (optedOut) return warn('opted out: consent.grant() ignored until optIn()');
    if (state && state.g === 1) return;
    // Events so far leave under the consent they were collected with.
    void flush();
    const shared = state || readState(token);
    state = shared ? { ...shared, g: 1 } : newState(true, Date.now());
    writeState(token, state);
  }

  function revoke(): void {
    if (!config) return;
    if (state) void flush();
    state = null;
    clearState(token);
  }

  function optOut(): void {
    optedOut = true;
    queue = [];
    clearTimeout(timer);
    timer = undefined;
    state = null;
    clearState(token);
    setOptedOut(true);
  }

  function optIn(): void {
    if (!optedOut) return;
    optedOut = false;
    setOptedOut(false);
    initialConsent();
  }

  /**
   * An opt-out or revoke in another tab holds here too; otherwise this tab
   * would write its ids back with its next event. (A grant or opt-in elsewhere
   * waits for this tab's next page load.)
   */
  function onStorage(e: Event): void {
    const { key, newValue } = e as StorageEvent;
    if ((key === OPT_OUT_KEY || key === null) && isOptedOut()) {
      optedOut = true;
      queue = [];
      clearTimeout(timer);
      timer = undefined;
      state = null;
    } else if ((key === stateKey(token) || key === null) && newValue === null && state) {
      void flush();
      state = null;
    }
  }

  // ── Events ───────────────────────────────────────────────────────────

  /** Queue an event about `at` (default: the current page) unless the visitor opted out or the page is excluded. */
  function emit(name: string, extra: Partial<EventInput>, at?: Page): void {
    if (!config || optedOut) return;
    if (excluded(at ? at.path : location.pathname)) return;
    const now = Date.now();
    const input: EventInput = {
      name,
      ts: now,
      url: at ? at.url : location.href,
      title: at ? at.title : document.title,
      viewport_w: window.innerWidth,
      ...extra,
    };
    if (state) {
      // Another tab may have moved the session on since this one last looked.
      const stored = readState(token);
      if (stored && stored.a === state.a && stored.t > state.t) state = { ...stored, g: state.g || stored.g };
      state = touchSession(state, now);
      writeState(token, state);
      input.anon_id = state.a;
      input.session_id = state.s;
    }
    const event = normalizeEvent(input);
    if (!event) return warn(`event "${name}" dropped: not a valid event`);
    queue.push(event);
    if (queue.length >= FLUSH_AT) void flush();
    else if (!timer) timer = setTimeout(() => void flush(), FLUSH_INTERVAL_MS);
  }

  function track(rawName: string, props?: Record<string, unknown>): void {
    const name = typeof rawName === 'string' ? rawName.trim() : rawName;
    if (!isCustomEventName(name)) {
      return warn(`event "${String(name)}" dropped: names start with a letter or digit and use letters, digits, space and _ . : / -`);
    }
    const clean = cleanProps(props, (key, why) => warn(`"${name}": property "${key}" dropped: ${why}`));
    emit(name, clean ? { props: clean } : {});
  }

  // ── Pages ────────────────────────────────────────────────────────────

  function pageKey(): string {
    const hash = location.hash;
    return location.href.split('#')[0] + (/^#[/!]/.test(hash) ? hash : '');
  }

  function depthNow(): number {
    const de = document.documentElement;
    const height = Math.max(de ? de.scrollHeight : 0, document.body ? document.body.scrollHeight : 0);
    const seen = (window.scrollY || (de ? de.scrollTop : 0) || 0) + window.innerHeight;
    return height > 0 && seen < height ? Math.round((seen / height) * 100) : 100;
  }

  /**
   * `$pageleave` for the current page. On a SPA navigation the new route may
   * already be scrolled or rendered, so only depth seen on the page counts;
   * on `pagehide` the page is still its own and its position counts too.
   */
  function leave(final: boolean): void {
    if (!page || page.left) return;
    page.left = true;
    emit('$pageleave', { scroll_depth: final ? Math.max(page.depth, depthNow()) : page.depth }, page);
  }

  function onLocation(): void {
    const key = pageKey();
    if (page && page.key === key && !page.left) return;
    leave(false);
    page = { key, url: location.href, title: document.title, path: location.pathname, depth: depthNow(), left: false };
    emit('$pageview', referrer ? { referrer } : {}, page);
    referrer = undefined;
  }

  function onScroll(): void {
    if (page && !page.left) page.depth = Math.max(page.depth, depthNow());
  }

  // ── Autocapture ──────────────────────────────────────────────────────

  function onClick(e: Event): void {
    const el = clickTarget(e.target);
    if (!el || !config) return;
    const m = e as MouseEvent;
    // A keyboard "click" has no position worth plotting.
    const pos = m.clientX || m.clientY ? { x: m.clientX + window.scrollX, y: m.clientY + window.scrollY } : {};
    emit('$autocapture', { el: describeElement(el, 'click', config.maskingLevel), ...pos });
  }

  function onSubmit(e: Event): void {
    const form = e.target;
    if (!(form instanceof Element) || form.tagName !== 'FORM' || isBlocked(form) || !config) return;
    // The text is the submit button's, never the form's: a form's text is mostly what was filled in around it.
    const submitter = (e as SubmitEvent).submitter || null;
    emit('$autocapture', { el: describeElement(form, 'submit', config.maskingLevel, submitter) });
  }

  // ── Transport ────────────────────────────────────────────────────────

  function post(body: string, retry: boolean): Promise<void> {
    if (typeof fetch !== 'function') return Promise.resolve();
    return fetch(endpoint, {
      method: 'POST',
      body,
      keepalive: true,
      credentials: 'omit',
      headers: { 'Content-Type': 'text/plain' },
    }).then(
      () => undefined,
      // A network failure (offline, or keepalive's in-flight quota) gets one more go; a 4xx/5xx answer does not.
      () =>
        retry
          ? new Promise<void>((resolve) => setTimeout(resolve, RETRY_DELAY_MS)).then(() => post(body, false))
          : warn('batch not sent'),
    );
  }

  function send(body: string, beacon: boolean): Promise<void> {
    if (beacon && typeof navigator.sendBeacon === 'function') {
      try {
        if (navigator.sendBeacon(endpoint, new Blob([body], { type: 'text/plain' }))) return Promise.resolve();
      } catch {
        // Fall through to fetch.
      }
    }
    return post(body, true);
  }

  /** Send the queue; `beacon` when the page may be going away. */
  function flush(beacon = false): Promise<void> {
    clearTimeout(timer);
    timer = undefined;
    if (!queue.length) return Promise.resolve();
    const batches = buildBatches({ token, consent: state !== null, events: queue });
    queue = [];
    return Promise.all(batches.map((b) => send(JSON.stringify(b), beacon))).then(() => undefined);
  }

  // ── Lifecycle ────────────────────────────────────────────────────────

  function on(target: EventTarget, type: string, fn: Handler, opts?: AddEventListenerOptions | boolean): void {
    const handler = safe(fn);
    target.addEventListener(type, handler, opts);
    cleanup.push(() => target.removeEventListener(type, handler, opts));
  }

  function patchHistory(method: 'pushState' | 'replaceState'): void {
    const original = history[method];
    const after = safe(onLocation);
    const patched = function (this: History, ...args: Parameters<History['pushState']>): void {
      original.apply(this, args);
      after();
    };
    history[method] = patched;
    cleanup.push(() => {
      if (history[method] === patched) history[method] = original;
    });
  }

  function start(raw: Partial<ClientConfig>): void {
    if (config || !pending) return;
    config = resolveConfig(raw);
    excluded = excludedMatcher(config.excludedUrls);
    initialConsent();

    patchHistory('pushState');
    patchHistory('replaceState');
    on(window, 'popstate', onLocation);
    on(window, 'hashchange', onLocation);
    on(window, 'scroll', onScroll, { passive: true });
    on(window, 'storage', onStorage);
    on(document, 'visibilitychange', () => {
      if (document.visibilityState === 'hidden') void flush(true);
    });
    on(window, 'pagehide', () => {
      leave(true);
      void flush(true);
    });
    // Back from the back/forward cache: the visitor is on the page again.
    on(window, 'pageshow', (e) => {
      if ((e as PageTransitionEvent).persisted) onLocation();
    });
    if (config.autocapture) {
      // Capture phase, so a handler that stops propagation doesn't hide the click.
      on(document, 'click', onClick, true);
      on(document, 'submit', onSubmit, true);
    }

    // Consent and opt-out calls made before load apply to the first pageview;
    // events tracked before load follow it.
    const calls = pending;
    pending = null;
    for (const [changesState, run] of calls) if (changesState) safe(run)();
    safe(onLocation)();
    for (const [changesState, run] of calls) if (!changesState) safe(run)();
  }

  function call(changesState: boolean, run: () => void): void {
    if (pending) {
      if (pending.length < 1000) pending.push([changesState, run]);
    } else safe(run)();
  }

  const api: WeldPanel = {
    version: LIB_VERSION,
    track: (name, props) => call(false, () => track(name, props)),
    consent: {
      grant: () => call(true, grant),
      revoke: () => call(true, revoke),
    },
    optOut: () => call(true, optOut),
    optIn: () => call(true, optIn),
    flush: () => {
      if (pending) {
        call(false, () => void flush());
        return Promise.resolve();
      }
      return flush();
    },
  };

  return {
    api,
    start,
    fail(reason) {
      warn('not collecting: the project config could not be loaded', reason);
      pending = null;
    },
    destroy() {
      for (const undo of cleanup.splice(0)) undo();
      clearTimeout(timer);
      timer = undefined;
      config = null;
      pending = null;
    },
  };
}
