/**
 * The React Native client: screens, app lifecycle and custom events, identity
 * and profiles, groups, super properties, consent and opt-out, batching,
 * retries and the offline queue.
 *
 * Nothing in here may throw into the app: every public method runs through
 * `safe()`, and storage, network and platform failures are caught where they
 * happen.
 */

import { nextBatch, type QueuedEvent } from './batch';
import {
  cleanGroupKey,
  cleanGroupType,
  cleanProps,
  cleanUserId,
  isCustomEventName,
  LIB_VERSION,
  mergeProps,
  normalizeEvent,
  normalizeGroupOp,
  normalizePeopleOp,
  screenUrl,
  str,
  type EventInput,
  type GroupOpInput,
  type PeopleOpInput,
} from './event';
import type { DeviceInfo, PanelPlatform, Size } from './platform';
import {
  createWriter,
  newIdentity,
  OPT_OUT_KEY,
  parseQueue,
  parseRecord,
  queueKey,
  readItem,
  stateKey,
  touchSession,
  type Identity,
  type StorageAdapter,
  type StoredQueue,
  type StoredRecord,
} from './storage';
import { MAX_PROPERTIES, MAX_STRING, MAX_TITLE, type Properties, type WireGroupOp, type WirePeopleOp } from './wire';

export const DEFAULT_API_HOST = 'https://pnl.weldsuite.org';
/** Send as soon as this many events wait… */
export const FLUSH_AT = 20;
/** …or at the latest this long after the first one was queued. */
export const FLUSH_INTERVAL_MS = 10_000;
/** Events kept waiting (offline) at most; the oldest go first. */
export const MAX_QUEUE = 1000;
/** Profile and group operations kept waiting at most, each. */
export const MAX_PENDING_OPS = 500;
/** The first retry after a failed send waits this long, each next one twice as long… */
export const RETRY_BASE_MS = 1000;
/** …up to this. */
export const RETRY_MAX_MS = 60_000;
/** The project's settings are waited for this long at start; after that the SDK starts without them. */
export const CONFIG_TIMEOUT_MS = 10_000;
/** A send that hasn't answered after this long counts as failed (event ids let the collector drop a late duplicate). */
export const SEND_TIMEOUT_MS = 30_000;
/** Calls made before the SDK is ready are kept, up to this many. */
const MAX_EARLY_CALLS = 1000;

/** The response fields the SDK reads. */
export interface FetchResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

/** The part of `fetch` the SDK uses. */
export type FetchLike = (
  url: string,
  init: { method: 'GET' | 'POST'; headers?: Record<string, string>; body?: string },
) => Promise<FetchResponse>;

export interface WeldPanelOptions {
  /** The project token, `wpk_…` (WeldPanel → Settings → Install). */
  token: string;
  /** The collector. Defaults to `https://pnl.weldsuite.org`. */
  apiHost?: string;
  /**
   * Where ids, super properties and unsent events are kept between launches
   * (with consent only): `AsyncStorage` fits. Without it, memory only.
   */
  storage?: StorageAdapter;
  /** The app itself: React Native core can't read these. `id` is the bundle id (`com.acme.shop`). */
  app?: { id?: string; version?: string; build?: string };
  /** Send as soon as this many events wait (default 20, at most 100). */
  flushAt?: number;
  /** Send at the latest this long after an event was queued (default 10 000 ms). */
  flushIntervalMs?: number;
  /** `$app_opened`, `$app_backgrounded`, `$app_installed`, `$app_updated` (default true). */
  captureLifecycle?: boolean;
  /** Events kept waiting while offline, at most (default 1000); the oldest go first. */
  maxQueue?: number;
  /** Warn in the console about dropped events, properties and failed sends. */
  debug?: boolean;
  /** Replaces React Native's `Platform`, `Dimensions` and `AppState` (tests). */
  platform?: PanelPlatform;
  /** Replaces the global `fetch` (tests). */
  fetch?: FetchLike;
}

/** The public API: what `createWeldPanel()` returns. */
export interface WeldPanelMobile {
  readonly version: string;
  /** Resolves once the project's settings and the stored state are loaded. Calls made before are kept and run then. */
  readonly ready: Promise<void>;
  /** A custom event. Flat properties only: strings, finite numbers, booleans, null. */
  track(name: string, props?: Record<string, unknown>): void;
  /** The person is on this screen now: sends `$screen` and tags every later event with it. */
  screen(name: string, props?: Record<string, unknown>): void;
  /** Who the person is (your user id): links the anonymous id to them and adds `user_id` to every later event. Needs consent. */
  identify(userId: string): void;
  /** Forget the user id, super properties and groups, and start a new anonymous id and session (call it on log out). */
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
  /** Properties sent with every event from now on (kept between launches with consent). */
  register(props: Record<string, unknown>): void;
  /** Like `register()`, but only the properties not registered yet. */
  registerOnce(props: Record<string, unknown>): void;
  unregister(key: string): void;
  /**
   * The person belongs to this group (`group('company', 'acme')`): every later
   * event carries `$group_<type>`, and the group's profile gets `props`.
   */
  group(type: string, key: string | number, props?: Record<string, unknown>): void;
  /** A group's profile, without changing membership. `name` is the group's own `$name`. */
  groups: {
    set(type: string, key: string | number, props: Record<string, unknown>): void;
    set_once(type: string, key: string | number, props: Record<string, unknown>): void;
    unset(type: string, key: string | number, keys: string | string[]): void;
  };
  /** Leave every group. */
  resetGroups(): void;
  consent: {
    /** The person agreed: keep an anonymous id, a session and what's registered, from now on. */
    grant(): void;
    /** The person withdrew: delete what is stored and go back to counting without ids. */
    revoke(): void;
  };
  /** Send nothing at all, now and on later launches, until `optIn()`. */
  optOut(): void;
  optIn(): void;
  /** Send waiting events now. Never rejects. */
  flush(): Promise<void>;
  /** The user id once identified, else the anonymous id; null without consent (or before `ready`). */
  getDistinctId(): string | null;
  getSessionId(): string | null;
  /** Stop: removes the app state listener and timers. Later calls do nothing. */
  shutdown(): void;
}

export interface Client {
  api: WeldPanelMobile;
  /** Resolves when sending and storage writes have settled (tests). */
  idle(): Promise<void>;
}

type Outcome = 'sent' | 'refused' | 'retry';

interface Loaded {
  optedOut: boolean;
  record: StoredRecord | null;
  queue: StoredQueue;
  /** Something was stored under the queue key. */
  queueStored: boolean;
}

function count(value: number | undefined, fallback: number, max = Number.MAX_SAFE_INTEGER): number {
  return typeof value === 'number' && isFinite(value) && value >= 1 ? Math.min(Math.floor(value), max) : fallback;
}

/** `https://pnl.weldsuite.org///` → `https://pnl.weldsuite.org`, without a backtracking regex. */
function trimTrailingSlashes(url: string): string {
  let end = url.length;
  while (end > 0 && url[end - 1] === '/') end--;
  return url.slice(0, end);
}

function globalFetch(): FetchLike | undefined {
  const f = (globalThis as { fetch?: unknown }).fetch;
  return typeof f === 'function' ? (f as FetchLike) : undefined;
}

export function createClient(options: WeldPanelOptions & { platform: PanelPlatform }): Client {
  const token = options.token;
  const platform = options.platform;
  const storage = options.storage;
  const host = trimTrailingSlashes(options.apiHost || DEFAULT_API_HOST);
  const endpoint = `${host}/e`;
  const flushAt = count(options.flushAt, FLUSH_AT, 100);
  const flushIntervalMs = count(options.flushIntervalMs, FLUSH_INTERVAL_MS);
  const maxQueue = count(options.maxQueue, MAX_QUEUE);
  const lifecycle = options.captureLifecycle !== false;
  const app = {
    id: str(options.app?.id, MAX_STRING),
    version: str(options.app?.version, MAX_STRING),
    build: str(options.app?.build, MAX_STRING),
  };
  const send = options.fetch || globalFetch();

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
  const dropped = (what: string) => (key: string, why: string) => warn(`${what}: "${key}" dropped: ${why}`);
  const writer = createWriter(storage, (err) => warn('storage write failed', err));

  let started = false;
  let stopped = false;
  /** Calls made before the SDK was ready: `[changes state, run]`. Null once started. */
  let pending: Array<[boolean, () => void]> | null = [];
  let consentMode: 'required' | 'none' = 'required';
  let optedOut = false;
  /** The person's ids. Non-null exactly when there is consent (or none is needed). */
  let ids: Identity | null = null;
  let superProps: Properties = {};
  let memberships: Record<string, string> = {};
  /** Whether a launch with consent was recorded, and the app version it saw. */
  let appSeen = false;
  let appVersionSeen: string | null = null;
  let screenName: string | undefined;
  let device: DeviceInfo = {};
  let queue: QueuedEvent[] = [];
  let people: WirePeopleOp[] = [];
  let groupOps: WireGroupOp[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let backoffMs = 0;
  let draining: Promise<void> | null = null;
  let foreground = true;
  let unsubscribeAppState: (() => void) | null = null;

  // ── Storage ──────────────────────────────────────────────────────────

  /** Writes the record: ids, user id, super properties, groups, app version. Only with consent. */
  function saveState(): void {
    if (!ids) return;
    writer.write(stateKey(token), () => {
      if (!ids) return null;
      const record: StoredRecord = { ...ids, superProps, groups: memberships };
      if (appSeen) record.appVersion = appVersionSeen;
      return JSON.stringify(record);
    });
  }

  /** Writes what is waiting to be sent: only with consent, and only what was collected with it. */
  function saveQueue(): void {
    if (!ids) return;
    writer.write(queueKey(token), () => {
      if (!ids) return null;
      const events = queue.filter((q) => q.c).map((q) => q.e);
      if (!events.length && !people.length && !groupOps.length) return null;
      const stored: StoredQueue = { events, people, groups: groupOps };
      return JSON.stringify(stored);
    });
  }

  function forgetStored(): void {
    writer.write(stateKey(token), () => null);
    writer.write(queueKey(token), () => null);
  }

  async function load(): Promise<Loaded> {
    const [optOut, record, stored] = await Promise.all([
      readItem(storage, OPT_OUT_KEY),
      readItem(storage, stateKey(token)),
      readItem(storage, queueKey(token)),
    ]);
    return { optedOut: optOut === '1', record: parseRecord(record), queue: parseQueue(stored), queueStored: stored !== null };
  }

  /** The project's consent mode, or null when the settings could not be loaded. */
  async function loadConsentMode(): Promise<'required' | 'none' | null> {
    if (!send) return null;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const timedOut = new Promise<null>((resolve) => {
        timeout = setTimeout(() => resolve(null), CONFIG_TIMEOUT_MS);
      });
      const res = await Promise.race([send(`${host}/c/${encodeURIComponent(token)}`, { method: 'GET' }), timedOut]);
      if (!res || !res.ok) return null;
      const body = await res.json();
      // Anything but an explicit `none` asks for consent.
      return body && typeof body === 'object' && (body as { consentMode?: unknown }).consentMode === 'none' ? 'none' : 'required';
    } catch (err) {
      warn('project settings not loaded', err);
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }

  // ── Consent ──────────────────────────────────────────────────────────

  /**
   * A launch with consent: `$app_installed` the first time (the first launch
   * the app could be remembered on), `$app_updated` when the version changed.
   * `announce: false` records the launch without sending either.
   */
  function recordLaunch(announce = true): void {
    if (!ids) return;
    const current = app.version ?? null;
    if (lifecycle && announce) {
      if (!appSeen) emit('$app_installed');
      else if (current && appVersionSeen && appVersionSeen !== current) emit('$app_updated', { previous_version: appVersionSeen });
    }
    const changed = !appSeen || (current !== null && current !== appVersionSeen);
    appSeen = true;
    if (current) appVersionSeen = current;
    if (changed) saveState();
  }

  function grant(): void {
    if (optedOut) return warn('opted out: consent.grant() ignored until optIn()');
    if (ids && ids.granted) return;
    ids = ids ? { ...ids, granted: true } : newIdentity(true, Date.now());
    saveState();
    saveQueue();
    recordLaunch();
  }

  function revoke(): void {
    const had = ids !== null;
    ids = null;
    people = [];
    forgetStored();
    // What was collected with consent leaves as it was collected; nothing of it is kept on the device.
    if (had && queue.length) void flush();
  }

  function stopTimers(): void {
    clearTimeout(timer);
    clearTimeout(retryTimer);
    timer = undefined;
    retryTimer = undefined;
    backoffMs = 0;
  }

  function optOut(): void {
    optedOut = true;
    queue = [];
    people = [];
    groupOps = [];
    stopTimers();
    ids = null;
    forgetStored();
    writer.write(OPT_OUT_KEY, () => '1');
  }

  function optIn(): void {
    if (!optedOut) return;
    optedOut = false;
    writer.write(OPT_OUT_KEY, () => null);
    ids = consentMode === 'none' ? newIdentity(false, Date.now()) : null;
    saveState();
    // Opting back in is not an install.
    recordLaunch(false);
  }

  // ── Events ───────────────────────────────────────────────────────────

  function dimensions(): { window: Size; screen: Size } | null {
    try {
      return platform.dimensions();
    } catch {
      return null;
    }
  }

  /** The `$` properties every event carries, those known. */
  function deviceProps(dims: { window: Size; screen: Size } | null): Properties {
    const p: Properties = {};
    if (screenName) p.$screen_name = screenName;
    if (device.os) p.$os = device.os;
    if (device.osVersion) p.$os_version = device.osVersion;
    if (device.deviceType) p.$device_type = device.deviceType;
    if (device.deviceModel) p.$device_model = device.deviceModel;
    if (app.id) p.$app_id = app.id;
    if (app.version) p.$app_version = app.version;
    if (app.build) p.$app_build = app.build;
    if (dims && isFinite(dims.screen.width) && isFinite(dims.screen.height)) {
      p.$screen_width = Math.round(dims.screen.width);
      p.$screen_height = Math.round(dims.screen.height);
    }
    if (device.locale) p.$locale = device.locale;
    return p;
  }

  function groupProps(): Properties | undefined {
    // Membership is kept in memory before consent but only sent after it (like identity).
    if (!ids) return undefined;
    const types = Object.keys(memberships);
    if (!types.length) return undefined;
    const p: Properties = {};
    for (const type of types) p[`$group_${type}`] = memberships[type];
    return p;
  }

  /** Queue an event with the current screen, ids, groups, super and device properties. */
  function emit(name: string, own?: Properties): void {
    if (!started || stopped || optedOut) return;
    const now = Date.now();
    const dims = dimensions();
    // The event's own properties win, then groups, then super properties, then the device's.
    const input: EventInput = {
      name,
      ts: now,
      url: screenUrl(app.id, screenName),
      title: screenName,
      viewport_w: dims ? dims.window.width : undefined,
      props: mergeProps([own, groupProps(), superProps, deviceProps(dims)]),
    };
    if (ids) {
      ids = touchSession(ids, now);
      input.anon_id = ids.anonId;
      input.session_id = ids.sessionId;
      if (ids.userId) input.user_id = ids.userId;
      saveState();
    }
    const event = normalizeEvent(input);
    if (!event) return warn(`event "${name}" dropped: not a valid event`);
    queue.push({ e: event, c: ids !== null });
    if (queue.length > maxQueue) {
      queue.splice(0, queue.length - maxQueue);
      warn(`more than ${maxQueue} events waiting: the oldest were dropped`);
    }
    saveQueue();
    if (queue.length >= flushAt && !retryTimer) void flush();
    else schedule();
  }

  function track(rawName: string, props?: Record<string, unknown>): void {
    const name = typeof rawName === 'string' ? rawName.trim() : rawName;
    if (!isCustomEventName(name)) {
      return warn(`event "${String(name)}" dropped: names start with a letter or digit and use letters, digits, space and _ . : / -`);
    }
    emit(name, cleanProps(props, dropped(`"${name}"`)));
  }

  function screen(rawName: string, props?: Record<string, unknown>): void {
    const name = typeof rawName === 'string' ? rawName.trim() : '';
    if (!name) return warn('screen() dropped: the screen needs a name');
    screenName = name.slice(0, MAX_TITLE);
    emit('$screen', cleanProps(props, dropped(`screen "${screenName}"`)));
  }

  // ── Identity, super properties and profiles ─────────────────────────

  function identify(raw: unknown): void {
    if (optedOut) return;
    const id = cleanUserId(raw);
    if (!id) return warn('identify() dropped: a user id is 1 to 255 characters, without control characters');
    if (!ids) return warn('identify() dropped: no consent');
    if (ids.userId === id) return;
    // Someone else was logged in on this device: don't join their history to this user.
    if (ids.userId) ids = newIdentity(ids.granted, Date.now());
    ids = { ...ids, userId: id };
    saveState();
    emit('$identify');
  }

  function reset(): void {
    superProps = {};
    memberships = {};
    if (ids) ids = newIdentity(ids.granted, Date.now());
    saveState();
  }

  function register(props: Record<string, unknown>, once: boolean): void {
    const clean = cleanProps(props, dropped(once ? 'registerOnce()' : 'register()'));
    if (!clean) return;
    const next = { ...superProps };
    for (const key of Object.keys(clean)) {
      const has = Object.prototype.hasOwnProperty.call(next, key);
      if (once && has) continue;
      if (!has && Object.keys(next).length >= MAX_PROPERTIES) {
        warn(`register(): "${key}" dropped: more than ${MAX_PROPERTIES} super properties`);
        continue;
      }
      next[key] = clean[key];
    }
    superProps = next;
    saveState();
  }

  function unregister(key: string): void {
    if (typeof key !== 'string' || !Object.prototype.hasOwnProperty.call(superProps, key)) return;
    const next = { ...superProps };
    delete next[key];
    superProps = next;
    saveState();
  }

  function profile(input: PeopleOpInput): void {
    if (optedOut) return;
    const op = input.op;
    if (!ids) return warn(`people.${op}() dropped: no consent`);
    if (!ids.userId) return warn(`people.${op}() dropped: call identify() first`);
    const clean = normalizePeopleOp({ ...input, user_id: ids.userId }, dropped(`people.${op}()`));
    if (!clean) return warn(`people.${op}() dropped: nothing valid to send`);
    people.push(clean);
    if (people.length > MAX_PENDING_OPS) people.shift();
    saveQueue();
    // Operations travel with events: they leave with the next batch.
    schedule();
  }

  function increment(props: string | Record<string, number>, by?: number): void {
    const values: Record<string, unknown> = typeof props === 'string' ? { [props]: by === undefined ? 1 : by } : props;
    profile({ op: 'increment', user_id: '', props: values });
  }

  // ── Groups ───────────────────────────────────────────────────────────

  function groupOp(input: GroupOpInput, allowEmpty = false): void {
    if (optedOut) return;
    // An account ties events together across people, so like identity it waits for consent.
    if (!ids) return warn(`groups.${input.op}() dropped: no consent`);
    const clean = normalizeGroupOp(input, dropped(`groups.${input.op}()`), allowEmpty);
    if (!clean) return warn(`groups.${input.op}() dropped: invalid group type or key, or nothing valid to send`);
    groupOps.push(clean);
    if (groupOps.length > MAX_PENDING_OPS) groupOps.shift();
    saveQueue();
    schedule();
  }

  function group(rawType: unknown, rawKey: unknown, props?: Record<string, unknown>): void {
    const type = cleanGroupType(rawType);
    const key = cleanGroupKey(rawKey);
    if (!type) return warn(`group() dropped: a group type is lower case letters, digits and _, starting with a letter`);
    if (!key) return warn('group() dropped: a group key is 1 to 255 characters, without control characters');
    memberships = { ...memberships, [type]: key };
    saveState();
    groupOp({ op: 'set', type, key, props: props || {} }, true);
  }

  // ── Transport ────────────────────────────────────────────────────────

  /** A flush in `flushIntervalMs`, unless one is already due (or a retry is). */
  function schedule(): void {
    if (timer || retryTimer || !queue.length || !started || stopped) return;
    timer = setTimeout(() => {
      timer = undefined;
      void flush();
    }, flushIntervalMs);
  }

  function retryLater(): void {
    backoffMs = backoffMs ? Math.min(backoffMs * 2, RETRY_MAX_MS) : RETRY_BASE_MS;
    warn(`batch not sent: retrying in ${backoffMs} ms`);
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      void flush();
    }, backoffMs);
  }

  async function post(body: string): Promise<Outcome> {
    if (!send) return 'retry';
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      // A stalled connection (Android's fetch has no timeout of its own) must not hold the queue.
      const timedOut = new Promise<null>((resolve) => {
        timeout = setTimeout(() => resolve(null), SEND_TIMEOUT_MS);
      });
      const res = await Promise.race([send(endpoint, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body }), timedOut]);
      if (!res) return 'retry';
      if (res.ok) return 'sent';
      // Busy or broken: try again later. Any other answer won't change on a retry.
      return res.status === 408 || res.status === 429 || res.status >= 500 ? 'retry' : 'refused';
    } catch {
      return 'retry';
    } finally {
      clearTimeout(timeout);
    }
  }

  /** Sends the queue one batch at a time, oldest first, until it is empty or a send fails. */
  async function drain(): Promise<void> {
    clearTimeout(timer);
    clearTimeout(retryTimer);
    timer = undefined;
    retryTimer = undefined;
    while (queue.length && started && !stopped && !optedOut) {
      const plan = nextBatch({ token, events: queue, people, groups: groupOps });
      if (!plan) break;
      const outcome = plan.batch ? await post(JSON.stringify(plan.batch)) : 'refused';
      if (outcome === 'retry') return retryLater();
      const tooLarge = plan.events.length - (plan.batch ? plan.batch.events.length : 0);
      if (tooLarge) warn(`${tooLarge} event(s) dropped: larger than a batch`);
      if (plan.batch && outcome === 'refused') warn('batch refused by the collector: dropped');
      backoffMs = 0;
      // The queues may have changed while the batch was in flight: take out exactly what it carried.
      const sent = new Set<unknown>([...plan.events, ...plan.people, ...plan.groups]);
      queue = queue.filter((q) => !sent.has(q));
      people = people.filter((op) => !sent.has(op));
      groupOps = groupOps.filter((op) => !sent.has(op));
      saveQueue();
    }
  }

  function flush(): Promise<void> {
    if (stopped) return Promise.resolve();
    if (!started) return ready.then(() => (started ? flush() : undefined));
    if (!draining) {
      draining = (async () => {
        try {
          await drain();
        } catch (err) {
          warn(err);
        } finally {
          draining = null;
        }
      })();
    }
    return draining;
  }

  // ── Lifecycle ────────────────────────────────────────────────────────

  function onAppState(next: string): void {
    if (stopped) return;
    if (next === 'active' && !foreground) {
      foreground = true;
      if (lifecycle) emit('$app_opened');
    } else if (next === 'background' && foreground) {
      foreground = false;
      if (lifecycle) emit('$app_backgrounded');
      // The app may not come back: send what is waiting now.
      void flush();
    }
  }

  function start(mode: 'required' | 'none' | null, loaded: Loaded): void {
    if (stopped || started) return;
    started = true;
    const record = loaded.record;
    optedOut = loaded.optedOut;
    // Offline at launch: a stored record made without a grant means the project needed no consent.
    consentMode = mode ?? (record && !record.granted ? 'none' : 'required');

    if (optedOut) {
      ids = null;
      forgetStored();
    } else if (record && (record.granted || consentMode === 'none')) {
      ids = { anonId: record.anonId, sessionId: record.sessionId, lastEventAt: record.lastEventAt, granted: record.granted };
      if (record.userId) ids.userId = record.userId;
      superProps = record.superProps;
      memberships = record.groups;
      appSeen = record.appVersion !== undefined;
      appVersionSeen = record.appVersion ?? null;
    } else {
      // Kept under settings that no longer allow it (the project now asks for consent): it goes.
      if (record) forgetStored();
      ids = consentMode === 'none' ? newIdentity(false, Date.now()) : null;
      saveState();
    }

    if (!optedOut) {
      // Left over from a launch that ended offline: sent first. Collected with consent, so sent with it.
      queue = loaded.queue.events.map((e) => ({ e, c: true }));
      people = loaded.queue.people;
      groupOps = loaded.queue.groups;
      if (!ids && loaded.queueStored) writer.write(queueKey(token), () => null);
    }

    try {
      device = platform.device();
    } catch (err) {
      warn('device info unavailable', err);
    }
    try {
      foreground = platform.appState() !== 'background';
      unsubscribeAppState = platform.onAppStateChange(safe(onAppState));
    } catch (err) {
      warn('app state unavailable', err);
    }

    // Consent, opt-out, identity, super properties and groups set before the
    // SDK was ready apply to the launch events; events and profiles follow them.
    const calls = pending || [];
    pending = null;
    // With ids from storage (or a project needing no consent) the launch is recorded first; a grant() records it itself.
    safe(recordLaunch)();
    for (const [changesState, run] of calls) if (changesState) safe(run)();
    if (lifecycle && foreground) safe(emit)('$app_opened');
    for (const [changesState, run] of calls) if (!changesState) safe(run)();
    schedule();
  }

  const ready: Promise<void> = Promise.all([loadConsentMode(), load()]).then(
    ([mode, loaded]) => safe(start)(mode, loaded),
    (err) => {
      warn('not started', err);
      pending = null;
    },
  );

  function call(changesState: boolean, run: () => void): void {
    if (stopped) return;
    if (pending) {
      if (pending.length < MAX_EARLY_CALLS) pending.push([changesState, run]);
    } else safe(run)();
  }

  function shutdown(): void {
    stopped = true;
    pending = null;
    stopTimers();
    if (unsubscribeAppState) {
      const unsubscribe = unsubscribeAppState;
      unsubscribeAppState = null;
      safe(unsubscribe)();
    }
  }

  const api: WeldPanelMobile = {
    version: LIB_VERSION,
    ready,
    track: (name, props) => call(false, () => track(name, props)),
    screen: (name, props) => call(false, () => screen(name, props)),
    identify: (userId) => call(true, () => identify(userId)),
    reset: () => call(true, reset),
    people: {
      set: (props) => call(false, () => profile({ op: 'set', user_id: '', props })),
      set_once: (props) => call(false, () => profile({ op: 'set_once', user_id: '', props })),
      unset: (keys) => call(false, () => profile({ op: 'unset', user_id: '', keys: typeof keys === 'string' ? [keys] : keys })),
      increment: (props, by) => call(false, () => increment(props, by)),
    },
    register: (props) => call(true, () => register(props, false)),
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
        memberships = {};
        saveState();
      }),
    consent: {
      grant: () => call(true, grant),
      revoke: () => call(true, revoke),
    },
    optOut: () => call(true, optOut),
    optIn: () => call(true, optIn),
    flush: () => {
      try {
        return flush().catch(warn);
      } catch (err) {
        warn(err);
        return Promise.resolve();
      }
    },
    getDistinctId: () => (ids ? ids.userId || ids.anonId : null),
    getSessionId: () => (ids ? ids.sessionId : null),
    shutdown: () => safe(shutdown)(),
  };

  return {
    api,
    async idle() {
      await ready;
      for (let i = 0; i < 5; i++) {
        if (draining) await draining;
        await writer.idle();
      }
    },
  };
}
