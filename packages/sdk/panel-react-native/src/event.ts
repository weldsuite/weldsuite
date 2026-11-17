/**
 * Turning what the app passes in into wire events and operations the
 * collector accepts. Everything is clamped or dropped here, item by item,
 * before it is queued, so a batch never fails the collector's schema.
 */

import { version } from '../package.json';
import {
  CUSTOM_EVENT_NAME,
  EVENT_PROPERTY_KEY,
  GROUP_TYPE,
  MAX_GROUP_KEY,
  MAX_ID,
  MAX_PROPERTIES,
  MAX_STRING,
  MAX_TITLE,
  MAX_UNSET_KEYS,
  PROFILE_PROPERTY_KEY,
  PROPERTY_KEY,
  SYSTEM_EVENTS,
  USER_ID,
  type KeyPattern,
  type Properties,
  type WireEvent,
  type WireGroupOp,
  type WirePeopleOp,
} from './wire';

export const LIB_VERSION: string = version;

/** The collector's path for a mobile event is `/` + the screen name, at most this long. */
export const MAX_SCREEN_PATH = 200;

type OnDrop = (key: string, reason: string) => void;

/** What {@link normalizeEvent} takes: a wire event whose fields may still be out of range. */
export interface EventInput {
  name: string;
  url: string;
  /** Generated when missing or not 8 to 64 characters. */
  event_id?: string;
  /** Defaults to now. */
  ts?: string | number | Date;
  anon_id?: string;
  session_id?: string;
  user_id?: string;
  title?: string;
  viewport_w?: number;
  props?: Record<string, unknown>;
}

/** What {@link normalizePeopleOp} takes: `email` and `name` become `$email` and `$name`. */
export type PeopleOpInput =
  | { op: 'set' | 'set_once' | 'increment'; user_id: string; ts?: string | number | Date; props: Record<string, unknown> }
  | { op: 'unset'; user_id: string; ts?: string | number | Date; keys: string[] };

/** What {@link normalizeGroupOp} takes: `email` and `name` become `$email` and `$name`. */
export type GroupOpInput =
  | { op: 'set' | 'set_once'; type: unknown; key: unknown; props?: Record<string, unknown> }
  | { op: 'unset'; type: unknown; key: unknown; keys: string[] };

interface CryptoLike {
  randomUUID?: () => string;
  getRandomValues?: (array: Uint8Array) => Uint8Array;
}

function randomBytes(): Uint8Array {
  const bytes = new Uint8Array(16);
  const c = (globalThis as { crypto?: CryptoLike }).crypto;
  if (c && typeof c.getRandomValues === 'function') {
    try {
      c.getRandomValues(bytes);
      return bytes;
    } catch {
      // Fall through.
    }
  }
  // Hermes has no `crypto` unless the app polyfills it. These ids only tell
  // events, visitors and sessions apart; they guard nothing (no access is
  // granted by knowing one), so a non-cryptographic fallback is acceptable.
  // eslint-disable-next-line sonarjs/pseudo-random -- ids, not secrets (see above)
  for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256); // NOSONAR
  return bytes;
}

/** A v4 UUID: `crypto.randomUUID` when the runtime has it, else built from random bytes. */
export function uuid(): string {
  const c = (globalThis as { crypto?: CryptoLike }).crypto;
  if (c && typeof c.randomUUID === 'function') {
    try {
      return c.randomUUID();
    } catch {
      // Fall through.
    }
  }
  const b = randomBytes();
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => (x < 16 ? '0' : '') + x.toString(16)).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function isoTime(t?: string | number | Date): string {
  const d = t === undefined ? new Date() : new Date(t);
  return isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}

/** UTF-8 byte length of a string produced by `JSON.stringify` (which escapes lone surrogates). */
export function utf8Length(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c < 0xdc00 && i + 1 < s.length) {
      n += 4;
      i++;
    } else n += 3;
  }
  return n;
}

export function isSystemEvent(name: string): boolean {
  return (SYSTEM_EVENTS as readonly string[]).indexOf(name) >= 0;
}

/** Names `track()` accepts: custom names only, `$` names are the SDK's own. */
export function isCustomEventName(name: unknown): name is string {
  return typeof name === 'string' && CUSTOM_EVENT_NAME.test(name);
}

/** A user id (or group key) the collector accepts: trimmed, 1 to 255 characters, no control characters; else undefined. */
export function cleanUserId(id: unknown): string | undefined {
  let s = '';
  if (typeof id === 'number' && isFinite(id)) s = String(id);
  else if (typeof id === 'string') s = id.trim();
  return USER_ID.test(s) ? s : undefined;
}

export function cleanGroupType(type: unknown): string | undefined {
  const s = typeof type === 'string' ? type.trim() : '';
  return GROUP_TYPE.test(s) ? s : undefined;
}

export function cleanGroupKey(key: unknown): string | undefined {
  const s = cleanUserId(key);
  return s && s.length <= MAX_GROUP_KEY ? s : undefined;
}

/**
 * Keeps the flat, primitive properties the collector accepts. Long strings are
 * cut to {@link MAX_STRING}; anything else invalid is dropped and reported to
 * `onDrop`. `keys` is the key pattern: {@link PROPERTY_KEY} for what the app
 * passes in.
 */
export function cleanProps(
  props: Record<string, unknown> | null | undefined,
  onDrop?: OnDrop,
  keys: KeyPattern = PROPERTY_KEY,
  numbersOnly = false,
): Properties | undefined {
  if (!props || typeof props !== 'object') return undefined;
  const out: Properties = {};
  let n = 0;
  for (const key of Object.keys(props)) {
    const v = props[key];
    let reason = '';
    if (!keys.test(key) || key === '__proto__') reason = 'invalid key';
    else if (n >= MAX_PROPERTIES) reason = `more than ${MAX_PROPERTIES} properties`;
    else if (typeof v === 'number' && isFinite(v)) out[key] = v;
    else if (numbersOnly) reason = 'value must be a finite number';
    else if (v === null || typeof v === 'boolean') out[key] = v;
    else if (typeof v === 'string') out[key] = v.slice(0, MAX_STRING);
    else reason = 'value must be a string, finite number, boolean or null';
    if (reason) onDrop?.(key, reason);
    else n++;
  }
  return n ? out : undefined;
}

/**
 * One property set from layers in order of precedence: a key keeps the value
 * of the first layer that has it, and only the first {@link MAX_PROPERTIES}
 * keys are kept.
 */
export function mergeProps(layers: ReadonlyArray<Properties | undefined>): Properties | undefined {
  const out: Properties = {};
  let n = 0;
  for (const layer of layers) {
    if (!layer) continue;
    for (const key of Object.keys(layer)) {
      if (Object.prototype.hasOwnProperty.call(out, key)) continue;
      if (n >= MAX_PROPERTIES) return out;
      out[key] = layer[key];
      n++;
    }
  }
  return n ? out : undefined;
}

/** `email` and `name` are a profile's own `$email` and `$name`. */
export function profileKey(key: string): string {
  return key === 'email' || key === 'name' ? `$${key}` : key;
}

/** The profile keys an `unset` may name: valid, unique, at most {@link MAX_UNSET_KEYS}. */
function unsetKeys(raws: unknown, onDrop?: OnDrop): string[] {
  const keys: string[] = [];
  for (const raw of Array.isArray(raws) ? raws : []) {
    const key = typeof raw === 'string' ? profileKey(raw) : '';
    if (PROFILE_PROPERTY_KEY.test(key) && keys.indexOf(key) < 0 && keys.length < MAX_UNSET_KEYS) keys.push(key);
    else onDrop?.(String(raw), 'invalid or repeated key');
  }
  return keys;
}

function profileProps(props: Record<string, unknown> | undefined, onDrop?: OnDrop, numbersOnly = false): Properties | undefined {
  const mapped: Record<string, unknown> = {};
  if (props && typeof props === 'object') {
    for (const key of Object.keys(props)) mapped[profileKey(key)] = props[key];
  }
  return cleanProps(mapped, onDrop, PROFILE_PROPERTY_KEY, numbersOnly);
}

/** The profile operation as the collector will accept it, or null when nothing valid is left. */
export function normalizePeopleOp(input: PeopleOpInput, onDrop?: OnDrop): WirePeopleOp | null {
  const user_id = input && cleanUserId(input.user_id);
  if (!user_id) return null;
  const ts = isoTime(input.ts);
  if (input.op === 'unset') {
    const keys = unsetKeys(input.keys, onDrop);
    return keys.length ? { op: 'unset', user_id, ts, keys } : null;
  }
  if (input.op !== 'set' && input.op !== 'set_once' && input.op !== 'increment') return null;
  const props = profileProps(input.props, onDrop, input.op === 'increment');
  if (!props) return null;
  return input.op === 'increment'
    ? { op: 'increment', user_id, ts, props: props as Record<string, number> }
    : { op: input.op, user_id, ts, props };
}

/**
 * The group operation as the collector will accept it, or null when the type
 * or key is invalid or nothing valid is left. `allowEmpty`: a `set` with no
 * properties still goes (what `group()` sends to register the group).
 */
export function normalizeGroupOp(input: GroupOpInput, onDrop?: OnDrop, allowEmpty = false): WireGroupOp | null {
  const type = input && cleanGroupType(input.type);
  const key = input && cleanGroupKey(input.key);
  if (!type || !key) return null;
  if (input.op === 'unset') {
    const keys = unsetKeys(input.keys, onDrop);
    return keys.length ? { op: 'unset', type, key, keys } : null;
  }
  if (input.op !== 'set' && input.op !== 'set_once') return null;
  const props = profileProps(input.props, onDrop);
  if (!props && !allowEmpty) return null;
  return { op: input.op, type, key, props: props || {} };
}

/** The screen name as the collector turns it into a path: trimmed, whitespace runs as `-`. */
export function screenSlug(screen: string): string {
  return screen.trim().replace(/\s+/g, '-').slice(0, MAX_SCREEN_PATH - 1);
}

/** The URL host for an app id: what a URL host may hold, `app` when there is nothing. */
export function appHost(appId: string | undefined): string {
  return (appId || '').replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 253) || 'app';
}

/**
 * The URL a mobile event carries: `app://<app id>/<screen>`. The collector
 * takes host and path from `$app_id` and `$screen_name`; the URL only has to
 * be valid, so anything doubtful falls back to `app://<app id>/`.
 */
export function screenUrl(appId: string | undefined, screen: string | undefined): string {
  const base = `app://${appHost(appId)}/`;
  const slug = screen ? screenSlug(screen) : '';
  if (!slug) return base;
  try {
    const url = base + encodeURI(slug).replace(/[#?]/g, (c) => (c === '#' ? '%23' : '%3F'));
    return url.length <= MAX_STRING ? url : base;
  } catch {
    // A lone surrogate.
    return base;
  }
}

function int(v: unknown, max: number): number | undefined {
  return typeof v === 'number' && isFinite(v) ? Math.min(max, Math.max(0, Math.round(v))) : undefined;
}

export function str(v: unknown, max: number): string | undefined {
  return typeof v === 'string' && v ? v.slice(0, max) : undefined;
}

/**
 * The event as the collector will accept it, or null when it can't be made
 * valid (unknown name, no URL). Idempotent: normalising a normalised event
 * returns an equal one, which is what lets a stored queue be re-checked on load.
 */
export function normalizeEvent(e: EventInput): WireEvent | null {
  if (!e || typeof e !== 'object' || typeof e.name !== 'string') return null;
  if (!isSystemEvent(e.name) && !isCustomEventName(e.name)) return null;
  if (typeof e.url !== 'string' || !/^[a-z][a-z0-9+.-]*:\/\/\S/.test(e.url) || e.url.length > MAX_STRING) return null;
  const id = e.event_id;
  const event: WireEvent = {
    event_id: typeof id === 'string' && id.length >= 8 && id.length <= MAX_ID ? id : uuid(),
    name: e.name,
    ts: isoTime(e.ts),
    url: e.url,
  };
  const anon = str(e.anon_id, MAX_ID);
  const session = str(e.session_id, MAX_ID);
  const user = cleanUserId(e.user_id);
  const title = str(e.title, MAX_TITLE);
  const width = int(e.viewport_w, 20000);
  const props = cleanProps(e.props, undefined, EVENT_PROPERTY_KEY);
  if (anon) event.anon_id = anon;
  if (session) event.session_id = session;
  if (user) event.user_id = user;
  if (title) event.title = title;
  if (width !== undefined) event.viewport_w = width;
  if (props) event.props = props;
  return event;
}
