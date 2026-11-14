/**
 * The browser client: pageviews, page leaves, autocapture and custom events,
 * identity and profiles, frustration signals, consent and opt-out, batching
 * and sending, and starting the recording plugin.
 *
 * Nothing in here may throw into the host page: every listener and patched
 * History method runs through `safe()`.
 */

import { clickPosition, clickTarget, describeElement, isBlocked } from './autocapture';
import { buildBatches } from './batch';
import { excludedMatcher, resolveConfig } from './config';
import { cleanProps, cleanUserId, isCustomEventName, LIB_VERSION, normalizeEvent, normalizePeopleOp, type EventInput, type PeopleOpInput } from './event';
import {
  deadClickCandidate,
  DEAD_CLICK_MS,
  excessiveScroll,
  exceptionInfo,
  exceptionKey,
  MAX_EXCEPTIONS,
  quickBackFrom,
  rageClicks,
  watchRequests,
  type NavRecord,
} from './frustration';
import { RECORDER_GLOBAL, type PanelRecorder, type RecorderFactory } from './recorder-api';
import {
  clearState,
  isOptedOut,
  newState,
  OPT_OUT_KEY,
  readJson,
  readState,
  sampleSession,
  setOptedOut,
  stateKey,
  touchSession,
  writeJson,
  writeState,
  type VisitorState,
} from './storage';
import { deviceClassFromViewport, MAX_PEOPLE_OPS_PER_BATCH, type ClientConfig, type Properties, type WireEvent, type WirePeopleOp } from './wire';

/** Send at least every 5 seconds while events are waiting… */
export const FLUSH_INTERVAL_MS = 5000;
/** …or as soon as this many are. */
export const FLUSH_AT = 20;
/** The one retry after a network failure waits this long. */
const RETRY_DELAY_MS = 1500;
/** A heatmap snapshot waits this long after the page is shown, so it has rendered. */
export const SNAPSHOT_DELAY_MS = 2000;
/** Profile operations kept waiting for the next batch of events, at most. */
const MAX_PENDING_PEOPLE = 500;

export interface ClientOptions {
  /** The project token, `wpk_…`. */
  token: string;
  /** The collector's origin, no trailing slash. */
  host: string;
  /** Warn in the console about dropped events and properties. */
  debug?: boolean;
  /** The recording plugin, when the app bundles it; otherwise it is loaded from `{host}/rec.js` when needed. */
  recorder?: RecorderFactory;
}

/** The public API: `window.weldpanel`, and what `init()` returns. */
export interface WeldPanel {
  readonly version: string;
  /** A custom event. Flat properties only: strings, finite numbers, booleans, null. */
  track(name: string, props?: Record<string, unknown>): void;
  /**
   * Who the visitor is (your user id): links this browser's anonymous id to
   * them and adds `user_id` to every event from now on. Needs consent.
   */
  identify(userId: string): void;
  /** Forget the user id and start a new anonymous id and session (call it on log out). */
  reset(): void;
  /** The identified user's profile. Needs consent and `identify()`; `email` and `name` are the profile's own. */
  people: {
    set(props: Record<string, unknown>): void;
    /** Only the properties the profile doesn't have yet. */
    set_once(props: Record<string, unknown>): void;
    unset(keys: string | string[]): void;
    /** `increment('logins')`, `increment('credits', -5)` or `increment({ logins: 1, credits: -5 })`. */
    increment(props: string | Record<string, number>, by?: number): void;
  };
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
  /** Remove listeners and restore `history`, `fetch` and XHR. */
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
  /** An `$excessivescroll` was sent for this page. */
  scrolled?: boolean;
}

/** This tab's record in sessionStorage (with consent only). */
interface TabRecord {
  /** The session `x` belongs to. */
  s?: string;
  /** Errors already sent this session (hashed keys). */
  x?: string[];
  /** The last page shown. */
  n?: NavRecord;
  /** Heatmap page groups already snapshotted. */
  g?: string[];
}

type Handler = (e: Event) => void;

/** A short hash, so the error keys kept in sessionStorage stay small. */
function shortHash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

export function createClient(options: ClientOptions): Client {
  const { token, host } = options;
  const endpoint = `${host}/e`;
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
  let people: WirePeopleOp[] = [];
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

  /** Consent is gone: nothing more is kept, recorded or sent with ids. */
  function forget(): void {
    state = null;
    people = [];
    if (recorder) recorder.stop();
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
    syncRecording();
    maybeSnapshot();
  }

  function revoke(): void {
    if (!config) return;
    if (state) void flush();
    forget();
    clearState(token);
  }

  function optOut(): void {
    optedOut = true;
    queue = [];
    clearTimeout(timer);
    timer = undefined;
    forget();
    clearState(token);
    setOptedOut(true);
  }

  function optIn(): void {
    if (!optedOut) return;
    optedOut = false;
    setOptedOut(false);
    initialConsent();
    syncRecording();
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
      forget();
    } else if ((key === stateKey(token) || key === null) && newValue === null && state) {
      void flush();
      forget();
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
      // Another tab may have moved the session on, or identified the visitor, since this one last looked.
      const stored = readState(token);
      if (stored && stored.a === state.a && stored.t > state.t) state = { ...stored, g: state.g || stored.g };
      state = touchSession(state, now);
      writeState(token, state);
      input.anon_id = state.a;
      input.session_id = state.s;
      if (state.u) input.user_id = state.u;
    }
    const event = normalizeEvent(input);
    if (!event) return warn(`event "${name}" dropped: not a valid event`);
    queue.push(event);
    if (queue.length >= FLUSH_AT) void flush();
    else if (!timer) timer = setTimeout(() => void flush(), FLUSH_INTERVAL_MS);
    // The session may have rolled over.
    if (state) syncRecording();
  }

  function track(rawName: string, props?: Record<string, unknown>): void {
    const name = typeof rawName === 'string' ? rawName.trim() : rawName;
    if (!isCustomEventName(name)) {
      return warn(`event "${String(name)}" dropped: names start with a letter or digit and use letters, digits, space and _ . : / -`);
    }
    const clean = cleanProps(props, (key, why) => warn(`"${name}": property "${key}" dropped: ${why}`));
    emit(name, clean ? { props: clean } : {});
  }

  // ── Identity and profiles ───────────────────────────────────────────

  function identify(raw: unknown): void {
    if (!config || optedOut) return;
    const id = cleanUserId(raw);
    if (!id) return warn('identify() dropped: a user id is 1 to 255 characters, without control characters');
    if (!state) return warn('identify() dropped: no consent');
    // Nothing is sent from an excluded page; the next identify() elsewhere links the visitor.
    if (excluded(location.pathname) || state.u === id) return;
    // Someone else was logged in on this browser: don't join their history to this user.
    if (state.u) reset();
    state = { ...state, u: id };
    writeState(token, state);
    emit('$identify', {});
  }

  function reset(): void {
    if (!config || !state) return;
    // What the old identity queued leaves under it.
    void flush();
    state = newState(state.g === 1, Date.now());
    writeState(token, state);
    syncRecording();
  }

  function profile(input: PeopleOpInput): void {
    if (!config || optedOut) return;
    const op = input.op;
    if (!state) return warn(`people.${op}() dropped: no consent`);
    if (!state.u) return warn(`people.${op}() dropped: call identify() first`);
    if (excluded(location.pathname)) return;
    const clean = normalizePeopleOp({ ...input, user_id: state.u }, (key, why) => warn(`people.${op}(): "${key}" dropped: ${why}`));
    if (!clean) return warn(`people.${op}() dropped: nothing valid to send`);
    if (people.length >= MAX_PENDING_PEOPLE) people.shift();
    people.push(clean);
    // Profile operations travel with events: they leave with the next batch.
    if (queue.length && !timer) timer = setTimeout(() => void flush(), FLUSH_INTERVAL_MS);
  }

  function increment(props: string | Record<string, number>, by?: number): void {
    const values: Record<string, unknown> = typeof props === 'string' ? { [props]: by === undefined ? 1 : by } : props;
    profile({ op: 'increment', user_id: '', props: values });
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

  /** The last page shown: this tab's own memory, or the session record a full page load left behind. */
  let nav: NavRecord | null = null;

  function readTab(): TabRecord {
    return (state && readJson<TabRecord>(stateKey(token), true)) || {};
  }

  function writeTab(tab: TabRecord): void {
    if (state) writeJson(stateKey(token), tab, true);
  }

  function onLocation(): void {
    activity();
    const key = pageKey();
    if (page && page.key === key && !page.left) return;
    leave(false);
    const now = Date.now();
    page = { key, url: location.href, title: document.title, path: location.pathname, depth: depthNow(), left: false };
    const tab = readTab();
    const last = tab.n && (!nav || tab.n.t > nav.t) ? tab.n : nav;
    const from = quickBackFrom(last, key, now);
    nav = { k: key, p: page.path, t: now, b: last ? last.k : undefined };
    writeTab({ ...tab, n: nav });
    emit('$pageview', referrer ? { referrer } : {}, page);
    referrer = undefined;
    if (from) emit('$quickback', { props: { $from: from } }, page);
    syncRecording();
    maybeSnapshot();
  }

  const tooMuchScrolling = excessiveScroll();

  function onScroll(): void {
    activity();
    if (!page || page.left) return;
    page.depth = Math.max(page.depth, depthNow());
    if (!page.scrolled && tooMuchScrolling(Date.now(), window.scrollY || 0, window.innerHeight)) {
      page.scrolled = true;
      emit('$excessivescroll', { scroll_depth: depthNow() }, page);
    }
  }

  // ── Autocapture and frustration ─────────────────────────────────────

  const rage = rageClicks();
  /** Last time the page reacted: DOM change, navigation, request, focus, scroll. */
  let lastActivity = 0;
  /** Elements waiting to see whether their click did anything. */
  let deadWatch: Element[] = [];
  let observer: MutationObserver | null = null;

  function activity(): void {
    lastActivity = Date.now();
  }

  /** A click on something clickable: a `$deadclick` if nothing reacts within {@link DEAD_CLICK_MS}. */
  function watchDeadClick(el: Element, m: MouseEvent): void {
    if (!config || deadWatch.indexOf(el) >= 0) return;
    const at = Date.now();
    // Described now: the element may be gone by the time we know.
    const extra: Partial<EventInput> = { el: describeElement(el, 'click', config.maskingLevel), ...clickPosition(el, m) };
    deadWatch.push(el);
    if (!observer && typeof MutationObserver === 'function') {
      observer = new MutationObserver(activity);
      observer.observe(document, { childList: true, subtree: true, attributes: true, characterData: true });
    }
    // After destroy() the watch list is empty, so a late timer does nothing.
    setTimeout(
      safe(() => {
        const i = deadWatch.indexOf(el);
        if (i < 0) return;
        deadWatch.splice(i, 1);
        if (!deadWatch.length && observer) {
          observer.disconnect();
          observer = null;
        }
        if (lastActivity < at) emit('$deadclick', extra);
      }),
      DEAD_CLICK_MS,
    );
  }

  function onClick(e: Event): void {
    if (!config) return;
    const m = e as MouseEvent;
    const target = e.target instanceof Element ? e.target : null;
    if (!target || isBlocked(target)) return;
    const el = clickTarget(target);
    if (el) emit('$autocapture', { el: describeElement(el, 'click', config.maskingLevel), ...clickPosition(el, m) });
    // Frustration needs a pointer: a keyboard "click" has no position.
    if (!m.clientX && !m.clientY) return;
    const hit = el || target;
    if (rage(Date.now(), m.clientX, m.clientY)) {
      emit('$rageclick', { el: describeElement(hit, 'click', config.maskingLevel), ...clickPosition(hit, m) });
    }
    if (m.ctrlKey || m.metaKey || m.shiftKey || m.altKey) return;
    const candidate = deadClickCandidate(target);
    if (candidate) watchDeadClick(candidate, m);
  }

  function onSubmit(e: Event): void {
    activity();
    const form = e.target;
    if (!(form instanceof Element) || form.tagName !== 'FORM' || isBlocked(form) || !config) return;
    // The text is the submit button's, never the form's: a form's text is mostly what was filled in around it.
    const submitter = (e as SubmitEvent).submitter || null;
    emit('$autocapture', { el: describeElement(form, 'submit', config.maskingLevel, submitter) });
  }

  /** Errors already sent from this page load, and how many were sent. */
  const errorKeys: string[] = [];

  function onError(e: Event): void {
    if (!config || errorKeys.length >= MAX_EXCEPTIONS) return;
    const info = exceptionInfo(e);
    if (!info) return;
    const key = shortHash(exceptionKey(info));
    if (errorKeys.indexOf(key) >= 0) return;
    errorKeys.push(key);
    if (state) {
      // Once per session, across its pages.
      const tab = readTab();
      const seen = tab.s === state.s && tab.x ? tab.x : [];
      if (seen.indexOf(key) >= 0) return;
      writeTab({ ...tab, s: state.s, x: seen.concat(key).slice(-50) });
    }
    const props: Properties = {};
    if (info.source) props.$source = info.source;
    if (info.line) props.$line = info.line;
    if (info.col) props.$col = info.col;
    emit('$exception', { error_message: info.message, props });
  }

  // ── Recording and heatmap snapshots ─────────────────────────────────

  let recorder: PanelRecorder | null = null;
  let recorderLoad: Promise<RecorderFactory | null> | null = null;
  /** Whether the session is recorded, as decided for it: `[session id, recorded]`. */
  let sampled: [string, boolean] | null = null;
  let snapshotTimer: ReturnType<typeof setTimeout> | undefined;

  const canCompress = (): boolean => typeof CompressionStream === 'function';

  function wantRecording(): boolean {
    if (!config || !state || config.recordingBlocked || config.recordingSampleRate <= 0 || !canCompress()) return false;
    if (excluded(location.pathname)) return false;
    if (!sampled || sampled[0] !== state.s) sampled = [state.s, sampleSession(token, state.s, config.recordingSampleRate)];
    return sampled[1];
  }

  /** The recorder factory: passed in, already on the page, or loaded from `{host}/rec.js`. */
  function loadRecorder(): Promise<RecorderFactory | null> {
    const w = window as unknown as Record<string, RecorderFactory | undefined>;
    const ready = options.recorder || w[RECORDER_GLOBAL];
    if (ready) return Promise.resolve(ready);
    return new Promise((resolve) => {
      const script = document.createElement('script');
      script.async = true;
      script.src = `${host}/rec.js`;
      script.onload = () => resolve(w[RECORDER_GLOBAL] || null);
      script.onerror = () => resolve(null);
      (document.head || document.documentElement).appendChild(script);
    });
  }

  function withRecorder(run?: (r: PanelRecorder) => void): void {
    if (recorder) {
      if (run) safe(run)(recorder);
      return;
    }
    if (!recorderLoad) recorderLoad = loadRecorder();
    void recorderLoad.then(
      safe((factory: RecorderFactory | null) => {
        if (!factory || !config) return warn('recording plugin not available');
        if (!recorder) {
          recorder = factory({ host, token, maskingLevel: config.maskingLevel, debug: options.debug });
          syncRecording();
        }
        if (run) run(recorder);
      }),
    );
  }

  /** Start, move on or stop the recording to match consent, sampling, quota and the page. */
  function syncRecording(): void {
    if (wantRecording()) {
      if (recorder && state) recorder.start(state.s);
      else withRecorder();
    } else if (recorder) recorder.stop();
  }

  /** The project asked for a heatmap background of this page group and device class: send one, once per tab session. */
  function maybeSnapshot(): void {
    const request = config && config.snapshot;
    if (!request || !state || !page || !canCompress()) return;
    const matches = (): boolean =>
      !!page &&
      !page.left &&
      !excluded(location.pathname) &&
      excludedMatcher([request.urlPattern])(location.pathname) &&
      deviceClassFromViewport(window.innerWidth) === request.deviceClass;
    if (!matches()) return;
    const key = page.key;
    clearTimeout(snapshotTimer);
    snapshotTimer = setTimeout(
      safe(() => {
        if (!config || !state || !page || page.key !== key || !matches()) return;
        const tab = readTab();
        const done = tab.g || [];
        if (done.indexOf(request.pageGroupId) >= 0) return;
        writeTab({ ...tab, g: done.concat(request.pageGroupId) });
        withRecorder((r) => void r.snapshot(request.pageGroupId, request.deviceClass).catch(warn));
      }),
      SNAPSHOT_DELAY_MS,
    );
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

  /** Send the queue; `beacon` when the page may be going away. Profile operations ride along. */
  function flush(beacon = false): Promise<void> {
    clearTimeout(timer);
    timer = undefined;
    if (!queue.length) return Promise.resolve();
    const ops = state ? people.splice(0, MAX_PEOPLE_OPS_PER_BATCH) : [];
    const batches = buildBatches({ token, consent: state !== null, events: queue, people: ops });
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
      activity();
      if (document.visibilityState === 'hidden') void flush(true);
    });
    on(window, 'pagehide', () => {
      activity();
      leave(true);
      void flush(true);
    });
    // Back from the back/forward cache: the visitor is on the page again.
    on(window, 'pageshow', (e) => {
      if ((e as PageTransitionEvent).persisted) onLocation();
    });
    on(window, 'error', onError);
    on(window, 'unhandledrejection', onError);
    if (config.autocapture) {
      // Capture phase, so a handler that stops propagation doesn't hide the click.
      on(document, 'click', onClick, true);
      on(document, 'submit', onSubmit, true);
      // What counts as the page reacting to a click, besides DOM changes (observed only while a click waits).
      for (const type of ['focusin', 'change']) on(document, type, activity, true);
      on(window, 'beforeunload', activity);
      on(window, 'blur', activity);
      // The SDK's own requests are not the page reacting.
      cleanup.push(watchRequests((url) => (url.indexOf(host) === 0 ? undefined : activity())));
      cleanup.push(() => {
        if (observer) observer.disconnect();
        observer = null;
        deadWatch = [];
      });
    }

    // Consent, opt-out and identity calls made before load apply to the first
    // pageview; events and profile calls follow it.
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
    identify: (userId) => call(true, () => identify(userId)),
    reset: () => call(true, reset),
    people: {
      set: (props) => call(false, () => profile({ op: 'set', user_id: '', props })),
      set_once: (props) => call(false, () => profile({ op: 'set_once', user_id: '', props })),
      unset: (keys) => call(false, () => profile({ op: 'unset', user_id: '', keys: typeof keys === 'string' ? [keys] : keys })),
      increment: (props, by) => call(false, () => increment(props, by)),
    },
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
      clearTimeout(snapshotTimer);
      timer = undefined;
      if (recorder) recorder.stop();
      config = null;
      pending = null;
    },
  };
}
