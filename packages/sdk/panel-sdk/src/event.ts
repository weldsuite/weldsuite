/**
 * Turning what the page knows into a {@link WireEvent} the collector accepts.
 *
 * The collector rejects a whole batch when one event fails its schema, so
 * everything is clamped or dropped here, per event, before it is queued.
 */

import { version } from '../package.json';
import {
  CUSTOM_EVENT_NAME,
  MAX_ELEMENT_TEXT,
  MAX_ID,
  MAX_PROPERTIES,
  MAX_STRING,
  MAX_TITLE,
  PROPERTY_KEY,
  SYSTEM_EVENTS,
  type Properties,
  type WireElement,
  type WireEvent,
} from './wire';

export const LIB_VERSION: string = version;

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
  title?: string;
  referrer?: string;
  viewport_w?: number;
  el?: WireElement;
  x?: number;
  y?: number;
  scroll_depth?: number;
  props?: Record<string, unknown>;
}

export function uuid(): string {
  const c = typeof crypto !== 'undefined' ? crypto : undefined;
  // randomUUID only exists in secure contexts; plain-http sites still get a v4 id.
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  const b = new Uint8Array(16);
  if (c && typeof c.getRandomValues === 'function') c.getRandomValues(b);
  else for (let i = 0; i < 16; i++) b[i] = (Math.random() * 256) | 0;
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

/**
 * Names `track()` accepts: custom names only, `$` names are the SDK's own.
 * Callers trim first, so `track(' Signed up ')` still counts as "Signed up".
 */
export function isCustomEventName(name: unknown): name is string {
  return typeof name === 'string' && CUSTOM_EVENT_NAME.test(name);
}

/**
 * Keeps the flat, primitive properties the collector accepts. Long strings are
 * cut to {@link MAX_STRING}; anything else invalid is dropped and reported to
 * `onDrop` (the client warns about it in debug mode).
 */
export function cleanProps(
  props: Record<string, unknown> | null | undefined,
  onDrop?: (key: string, reason: string) => void,
): Properties | undefined {
  if (!props || typeof props !== 'object') return undefined;
  const out: Properties = {};
  let n = 0;
  for (const key of Object.keys(props)) {
    const v = props[key];
    let reason = '';
    if (!PROPERTY_KEY.test(key)) reason = 'invalid key';
    else if (n >= MAX_PROPERTIES) reason = `more than ${MAX_PROPERTIES} properties`;
    else if (v === null || typeof v === 'boolean') out[key] = v;
    else if (typeof v === 'string') out[key] = v.slice(0, MAX_STRING);
    else if (typeof v === 'number' && isFinite(v)) out[key] = v;
    else reason = 'value must be a string, finite number, boolean or null';
    if (reason) onDrop?.(key, reason);
    else n++;
  }
  return n ? out : undefined;
}

/** The URL as sent: at most {@link MAX_STRING} characters, losing the hash, then the query, before cutting. */
export function clampUrl(url: string): string | null {
  try {
    if (url.length > MAX_STRING) {
      const u = new URL(url);
      u.hash = '';
      if (u.href.length > MAX_STRING) u.search = '';
      url = u.href.slice(0, MAX_STRING);
    }
    new URL(url);
    return url;
  } catch {
    return null;
  }
}

function int(v: unknown, max: number): number | undefined {
  return typeof v === 'number' && isFinite(v) ? Math.min(max, Math.max(0, Math.round(v))) : undefined;
}

function str(v: unknown, max: number): string | undefined {
  return typeof v === 'string' && v ? v.slice(0, max) : undefined;
}

/**
 * The event as the collector will accept it, or null when it can't be made
 * valid (unknown name, unparseable URL). Idempotent: normalising a normalised
 * event returns an equal one.
 */
export function normalizeEvent(e: EventInput): WireEvent | null {
  if (!e || (!isSystemEvent(e.name) && !isCustomEventName(e.name))) return null;
  const url = typeof e.url === 'string' ? clampUrl(e.url) : null;
  if (!url) return null;
  const id = e.event_id;
  const out: WireEvent = {
    event_id: typeof id === 'string' && id.length >= 8 && id.length <= MAX_ID ? id : uuid(),
    name: e.name,
    ts: isoTime(e.ts),
    url,
  };
  const anon = str(e.anon_id, MAX_ID);
  const session = str(e.session_id, MAX_ID);
  if (anon) out.anon_id = anon;
  if (session) out.session_id = session;
  const title = str(e.title, MAX_TITLE);
  if (title) out.title = title;
  const referrer = str(e.referrer, MAX_STRING);
  if (referrer) out.referrer = referrer;
  const vw = int(e.viewport_w, 20000);
  if (vw !== undefined) out.viewport_w = vw;
  if (e.el && typeof e.el.tag === 'string' && typeof e.el.selector === 'string') {
    const el: WireElement = {
      tag: e.el.tag.slice(0, 32),
      selector: e.el.selector.slice(0, 512),
      action: e.el.action === 'submit' ? 'submit' : 'click',
    };
    const text = str(e.el.text, MAX_ELEMENT_TEXT);
    if (text) el.text = text;
    out.el = el;
  }
  const x = int(e.x, 100000);
  const y = int(e.y, 1000000);
  if (x !== undefined) out.x = x;
  if (y !== undefined) out.y = y;
  const depth = int(e.scroll_depth, 100);
  if (depth !== undefined) out.scroll_depth = depth;
  const props = cleanProps(e.props);
  if (props) out.props = props;
  return out;
}
