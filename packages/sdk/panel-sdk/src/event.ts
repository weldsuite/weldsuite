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
  // randomUUID only exists in secure contexts; plain-http sites still get a v4
  // id from getRandomValues, which every browser the ES2018 target covers has.
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
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
  return {
    event_id: typeof id === 'string' && id.length >= 8 && id.length <= MAX_ID ? id : uuid(),
    name: e.name,
    ts: isoTime(e.ts),
    url,
    ...optionalFields(e),
  };
}

/** The optional fields that survive cleaning; one that doesn't is left out, not set to undefined. */
function optionalFields(e: EventInput): Partial<WireEvent> {
  const fields: Partial<WireEvent> = {
    anon_id: str(e.anon_id, MAX_ID),
    session_id: str(e.session_id, MAX_ID),
    title: str(e.title, MAX_TITLE),
    referrer: str(e.referrer, MAX_STRING),
    viewport_w: int(e.viewport_w, 20000),
    el: normalizeElement(e.el),
    x: int(e.x, 100000),
    y: int(e.y, 1000000),
    scroll_depth: int(e.scroll_depth, 100),
    props: cleanProps(e.props),
  };
  for (const key of Object.keys(fields) as (keyof WireEvent)[]) {
    if (fields[key] === undefined) delete fields[key];
  }
  return fields;
}

function normalizeElement(el: EventInput['el']): WireElement | undefined {
  if (!el || typeof el.tag !== 'string' || typeof el.selector !== 'string') return undefined;
  const out: WireElement = {
    tag: el.tag.slice(0, 32),
    selector: el.selector.slice(0, 512),
    action: el.action === 'submit' ? 'submit' : 'click',
  };
  const text = str(el.text, MAX_ELEMENT_TEXT);
  if (text) out.text = text;
  return out;
}
