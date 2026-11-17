/**
 * The browser client: pageviews, page leaves, autocapture and custom events,
 * identity and profiles, frustration signals, consent and opt-out, batching
 * and sending, and starting the recording plugin.
 *
 * Nothing in here may throw into the host page: every listener and patched
 * History method runs through `safe()`.
 */

import { clickPosition, clickTarget, cssSelector, describeElement, isBlocked } from './autocapture';
import { buildBatches } from './batch';
import { excludedMatcher, resolveConfig } from './config';
import {
  cleanGroupKey,
  cleanProps,
  cleanUserId,
  isCustomEventName,
  LIB_VERSION,
  normalizeEvent,
  normalizeGroupOp,
  normalizePeopleOp,
  type EventInput,
  type GroupOpInput,
  type PeopleOpInput,
} from './event';
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
import { VITALS_GLOBAL, type Vitals, type VitalsFactory } from './vitals-api';
import {
  deviceClassFromViewport,
  GROUP_TYPE,
  MAX_GROUP_OPS_PER_BATCH,
  MAX_PEOPLE_OPS_PER_BATCH,
  type ClientConfig,
  type Properties,
  type WireEvent,
  type WireGroupOp,
  type WirePeopleOp,
} from './wire';

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
  /** The collector's origin, no trailing slash: where the recording plugin is loaded from. */
  host: string;
  /** Where events, the config and recordings go (a reverse proxy on the site's own domain); defaults to `host`. */
  apiHost?: string;
  /** Warn in the console about dropped events and properties. */
  debug?: boolean;
  /** The recording plugin, when the app bundles it; otherwise it is loaded from `{host}/rec.js` when needed. */
  recorder?: RecorderFactory;
  /** `false`: no `$webvitals` events. */
  webVitals?: boolean;
  /** The web vitals plugin, when the app bundles it; otherwise it is loaded from `{host}/v.js`. */
  vitals?: VitalsFactory;
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
  /**
   * Super properties: added to every later event (the event's own properties win). Keys like
   * `track()`'s, no `$`. Kept in the browser only with consent, in memory before it.
   */
  register(props: Record<string, unknown>): void;
  /** Only the super properties not set yet. */
  registerOnce(props: Record<string, unknown>): void;
  unregister(key: string): void;
  /**
   * The visitor belongs to this group (`group('company', 'acme')`): every later event carries
   * `$group_company: 'acme'`. `props` update the group's profile.
   */
  group(type: string, key: string | number, props?: Record<string, unknown>): void;
  /** A group's profile; works for any group, not only the visitor's. */
  groups: {
    set(type: string, key: string | number, props: Record<string, unknown>): void;
    set_once(type: string, key: string | number, props: Record<string, unknown>): void;
    unset(type: string, key: string | number, keys: string | string[]): void;
  };
  /** Leave every group: later events carry no `$group_` properties. */
  resetGroups(): void;
  /** The user id, else the anonymous id; null without consent (the visitor is counted cookieless). */
  getDistinctId(): string | null;
  /** The session id; null without consent. */
  getSessionId(): string | null;
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

/** The properties of the first of `lists` that has each key: earlier lists win. */
function merge(...lists: Array<Properties | null | undefined>): Properties {
  const out: Properties = {};
  for (const list of lists) if (list) for (const k of Object.keys(list)) if (!(k in out)) out[k] = list[k];
  return out;
}

const UTM = ['source', 'medium', 'campaign', 'content', 'term'];

export function createClient(options: ClientOptions): Client {
  const { token, host } = options;
  const apiOrigin = options.apiHost || host;
  const endpoint = `${apiOrigin}/e`;
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
  let groupOps: WireGroupOp[] = [];
  /** Super properties, groups (type → key) and first-touch properties: in memory, and in `state` with consent. */
  let supers: Properties = {};
  let groups: Record<string, string> = {};
  let first: Properties | null = null;
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
    if (state === stored && stored) adopt(stored);
    else persist();
  }

  /** Super properties, groups and first touch as another page or tab kept them. */
  function adopt(from: VisitorState): void {
    if (from.p) supers = from.p;
    if (from.r) groups = from.r;
    if (from.f) first = from.f;
  }

  /** Writes the state with the super properties, groups and first touch; nothing without consent. */
  function persist(): void {
    if (!state) return;
    state = { ...state, p: supers, r: groups };
    if (first) state.f = first;
    writeState(token, state);
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
    persist();
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
    groupOps = [];
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
      groupOps = [];
      clearTimeout(timer);
      timer = undefined;
      forget();
    } else if ((key === stateKey(token) || key === null) && newValue === null && state) {
      void flush();
      forget();
    }
  }

  // ── Events ───────────────────────────────────────────────────────────

  /**
   * Queue an event about `at` (default: the current page) unless the visitor opted out or the page
   * is excluded. Its properties get the groups, super and first-touch properties added, unless
   * `anonymous` (web vitals): then it carries no ids and nothing else either.
   */
  function emit(name: string, extra: Partial<EventInput>, at?: Page | null, anonymous?: boolean): void {
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
    if (state && !anonymous) {
      // Another tab may have moved the session on, or identified the visitor, since this one last looked.
      const stored = readState(token);
      if (stored && stored.a === state.a && stored.t > state.t) {
        state = { ...stored, g: state.g || stored.g };
        adopt(stored);
      }
      state = touchSession(state, now);
      writeState(token, state);
      input.anon_id = state.a;
      input.session_id = state.s;
      if (state.u) input.user_id = state.u;
    }
    if (!anonymous) {
      const member: Properties = {};
      // Group membership is kept in memory before consent but only sent after it.
      if (state) for (const type of Object.keys(groups)) member[`$group_${type}`] = groups[type];
      input.props = merge(extra.props as Properties | undefined, member, supers, first);
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
      return warn(`event "${String(name)}" dropped: a name is letters, digits, space and _ . : / -`);
    }
    const clean = cleanProps(props, (key, why) => warn(`"${name}": property "${key}" dropped: ${why}`));
    emit(name, clean ? { props: clean } : {});
  }

  // ── Identity and profiles ───────────────────────────────────────────

  function identify(raw: unknown): void {
    if (!config || optedOut) return;
    const id = cleanUserId(raw);
    if (!id) return warn('identify() dropped: a user id is 1 to 255 characters');
    if (!state) return warn('identify() dropped: no consent');
    // Nothing is sent from an excluded page; the next identify() elsewhere links the visitor.
    if (excluded(location.pathname) || state.u === id) return;
    // Someone else was logged in on this browser: don't join their history to this user.
    if (state.u) reset();
    state = { ...state, u: id };
    writeState(token, state);
    emit('$identify', {});
    // Where this visitor first came from, on the profile too (only where it isn't there yet).
    if (first) profile({ op: 'set_once', user_id: '', props: first });
  }

  function reset(): void {
    if (!config || !state) return;
    // What the old identity queued leaves under it.
    void flush();
    state = newState(state.g === 1, Date.now());
    supers = {};
    groups = {};
    persist();
    syncRecording();
  }

  // ── Super properties, first touch and groups ───────────────────────

  function register(props: Record<string, unknown>, once?: boolean): void {
    const clean = cleanProps(props, (key, why) => warn(`register(): "${key}" dropped: ${why}`));
    if (!clean) return;
    supers = once ? merge(supers, clean) : merge(clean, supers);
    persist();
  }

  function unregister(key: string): void {
    supers = { ...supers };
    delete supers[key];
    persist();
  }

  /** `$initial_*` from the first page seen: referrer (without query), its host, the UTM tags and the landing path. */
  function firstTouch(): void {
    if (first) return;
    let referrer = '$direct';
    let domain = '$direct';
    try {
      if (document.referrer) {
        const u = new URL(document.referrer);
        referrer = (u.origin + u.pathname).slice(0, 2048);
        domain = u.hostname;
      }
    } catch {
      // An unreadable referrer counts as direct.
    }
    first = { $initial_referrer: referrer, $initial_referring_domain: domain, $initial_landing_path: location.pathname.slice(0, 2048) };
    const query = new URLSearchParams(location.search);
    for (const tag of UTM) {
      const value = query.get(`utm_${tag}`);
      if (value) first[`$initial_utm_${tag}`] = value.slice(0, 256);
    }
    persist();
  }

  function groupOp(input: GroupOpInput): void {
    if (!config || optedOut) return;
    // An account ties events together across visitors, so like identity it waits for consent.
    if (!state) return warn(`groups.${input.op}() dropped: no consent`);
    const op = normalizeGroupOp(input, (key, why) => warn(`group "${key}" dropped: ${why}`));
    // Types: a-z, 0-9 and _, starting with a letter; keys: 1 to 255 characters.
    if (!op) return warn('group dropped: bad type or key');
    if (groupOps.length >= MAX_PENDING_PEOPLE) groupOps.shift();
    groupOps.push(op);
    if (queue.length && !timer) timer = setTimeout(() => void flush(), FLUSH_INTERVAL_MS);
  }

  /** Membership (only for a valid type and key), and the group's profile operation (which warns about a bad one). */
  function group(type: string, rawKey: unknown, props?: Record<string, unknown>): void {
    const key = cleanGroupKey(rawKey);
    if (key && GROUP_TYPE.test(type)) {
      groups = { ...groups, [type]: key };
      persist();
    }
    groupOp({ op: 'set', type, key: rawKey, props });
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

  // ── Web vitals ───────────────────────────────────────────────────────

  let vitals: Vitals | null = null;

  /** The page view's `$webvitals`, once, without ids or other properties. */
  function sendVitals(): void {
    const props = vitals && vitals.take();
    if (props) emit('$webvitals', { props }, page, true);
  }

  function onLocation(): void {
    activity();
    const key = pageKey();
    if (page && page.key === key && !page.left) return;
    if (page && vitals) {
      sendVitals();
      vitals.soft();
    }
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

  /** A plugin's factory: passed in, already on the page, or loaded from `{host}{path}`, which puts it on `window[name]`. */
  function loadPlugin<T>(given: T | undefined, name: string, path: string): Promise<T | null> {
    const w = window as unknown as Record<string, T | undefined>;
    const ready = given || w[name];
    if (ready) return Promise.resolve(ready);
    return new Promise((resolve) => {
      const script = document.createElement('script');
      script.async = true;
      script.src = host + path;
      script.onload = () => resolve(w[name] || null);
      script.onerror = () => resolve(null);
      (document.head || document.documentElement).appendChild(script);
    });
  }

  /** The recorder factory: passed in, already on the page, or loaded from `{host}/rec.js`. */
  function loadRecorder(): Promise<RecorderFactory | null> {
    return loadPlugin(options.recorder, RECORDER_GLOBAL, '/rec.js');
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
          recorder = factory({ host: apiOrigin, token, maskingLevel: config.maskingLevel, debug: options.debug });
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
    const batches = buildBatches({ token, consent: state !== null, events: queue, people: ops, groups: groupOps.splice(0, MAX_GROUP_OPS_PER_BATCH) });
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
      if (document.visibilityState !== 'hidden') return;
      sendVitals();
      void flush(true);
    });
    on(window, 'pagehide', () => {
      activity();
      sendVitals();
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
      cleanup.push(watchRequests((url) => (url.indexOf(host) === 0 || url.indexOf(apiOrigin) === 0 ? undefined : activity())));
      cleanup.push(() => {
        if (observer) observer.disconnect();
        observer = null;
        deadWatch = [];
      });
    }

    // Web vitals: the plugin (`/v.js`) measures; its observers are buffered, so arriving late loses nothing.
    if (options.webVitals !== false && typeof PerformanceObserver === 'function') {
      void loadPlugin(options.vitals, VITALS_GLOBAL, '/v.js').then(
        safe((factory: VitalsFactory | null) => {
          if (!factory || !config) return;
          const watched = factory(cssSelector);
          vitals = watched;
          cleanup.push(() => watched.stop());
        }),
      );
    }

    // Consent, opt-out and identity calls made before load apply to the first
    // pageview; events and profile calls follow it.
    const calls = pending;
    pending = null;
    safe(firstTouch)();
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
    // Super properties and groups apply to the first pageview too.
    register: (props) => call(true, () => register(props)),
    registerOnce: (props) => call(true, () => register(props, true)),
    unregister: (key) => call(true, () => unregister(key)),
    group: (type, key, props) => call(true, () => group(type, key, props)),
    groups: {
      set: (type, key, props) => call(false, () => groupOp({ op: 'set', type, key, props })),
      set_once: (type, key, props) => call(false, () => groupOp({ op: 'set_once', type, key, props })),
      unset: (type, key, keys) => call(false, () => groupOp({ op: 'unset', type, key, keys: typeof keys === 'string' ? [keys] : keys })),
    },
    resetGroups: () =>
      call(true, () => {
        groups = {};
        persist();
      }),
    getDistinctId: () => (state ? state.u || state.a : null),
    getSessionId: () => (state ? state.s : null),
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
