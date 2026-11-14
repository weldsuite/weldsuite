/**
 * The wire format between this SDK and the collector (panel-ingest).
 *
 * A plain TypeScript copy of `packages/domains/panel/src/wire.ts`, which is
 * the Zod source of truth on the collector side. The SDK keeps its own copy so
 * the browser bundle never pulls in zod; `wire.contract.test.ts` checks that
 * the two agree and that what {@link buildBatches} produces passes the Zod
 * schema. Change both together.
 */

export const MAX_EVENTS_PER_BATCH = 100;
/** `navigator.sendBeacon` refuses bodies over 64 KiB, so the SDK stays under it and the collector enforces it. */
export const MAX_BATCH_BYTES = 64 * 1024;
export const MAX_PROPERTIES = 50;
export const MAX_STRING = 2048;
export const MAX_ELEMENT_TEXT = 255;
export const MAX_TITLE = 512;
export const MAX_ID = 64;
export const MAX_ERROR_MESSAGE = 1000;
export const MAX_PEOPLE_OPS_PER_BATCH = 50;
export const MAX_UNSET_KEYS = 50;
/** `POST /v1/track` takes at most this many events, `/v1/import` {@link MAX_IMPORT_EVENTS}. */
export const MAX_TRACK_EVENTS = 100;
export const MAX_IMPORT_EVENTS = 1000;

/** `$`-prefixed names are reserved for events the SDK sends itself. */
export const SYSTEM_EVENTS = [
  '$pageview',
  '$pageleave',
  '$autocapture',
  '$identify',
  '$rageclick',
  '$deadclick',
  '$quickback',
  '$excessivescroll',
  '$exception',
] as const;
export type SystemEventName = (typeof SYSTEM_EVENTS)[number];

/**
 * Custom event names: what a person would type, not a sentence. Up to 100
 * characters, starting and ending with a non-space, so "Signed up " can't
 * become a second event next to "Signed up".
 */
export const CUSTOM_EVENT_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9 _.:/-]{0,98}[A-Za-z0-9_.:/-])?$/;
/** Property keys: identifiers, kept SQL-safe because the query compiler reads them with `json_get_*`. */
export const PROPERTY_KEY = /^[A-Za-z_]\w{0,63}$/;
/** Event property keys: {@link PROPERTY_KEY} plus the reserved keys of the SDK's own events. `track()` takes only the former. */
export const EVENT_PROPERTY_KEY = /^(?:[A-Za-z_]\w{0,63}|\$(?:source|line|col|from))$/;
/** Profile property keys: {@link PROPERTY_KEY} plus the reserved profile fields. */
export const PROFILE_PROPERTY_KEY = /^(?:[A-Za-z_]\w{0,63}|\$(?:email|name|avatar|created))$/;
/** User ids: 1 to 255 characters, no control characters. */
export const USER_ID = /^[^\u0000-\u001f\u007f-\u009f]{1,255}$/;

export type PropertyValue = string | number | boolean | null;
export type Properties = Record<string, PropertyValue>;

export interface WireElement {
  /** Lower-case tag name, at most 32 characters. */
  tag: string;
  /** Short CSS selector, at most 512 characters. */
  selector: string;
  /** Visible text, masked per the project's masking level; never input values. */
  text?: string;
  action: 'click' | 'submit';
}

export interface WireEvent {
  /** Client-generated UUID, so a retried batch can be told apart from a new one. 8 to 64 characters. */
  event_id: string;
  name: SystemEventName | string;
  /** Client clock, ISO 8601. The collector corrects it with `sent_at`. */
  ts: string;
  /** Only with consent. */
  anon_id?: string;
  /** Only with consent. */
  session_id?: string;
  /** Only with consent, on every event after `identify()`. Matches {@link USER_ID}. */
  user_id?: string;
  /** An absolute URL, at most 2048 characters. */
  url: string;
  title?: string;
  referrer?: string;
  /** Integer, 0 to 20000. */
  viewport_w?: number;
  /** `$autocapture`, `$rageclick`, `$deadclick`: the element. */
  el?: WireElement;
  /** Click position in the document, CSS pixels: integers, x 0 to 100000, y 0 to 1000000. */
  x?: number;
  y?: number;
  /** Click position inside the element's box, 0 to 1. */
  rel_x?: number;
  rel_y?: number;
  /** `$pageleave`, `$excessivescroll`: scroll depth, integer percent of the page height. */
  scroll_depth?: number;
  /** `$exception`: the message, at most {@link MAX_ERROR_MESSAGE} characters. */
  error_message?: string;
  /** At most {@link MAX_PROPERTIES} keys matching {@link EVENT_PROPERTY_KEY}. */
  props?: Properties;
}

/** A profile operation (`people.set()` and friends): only with consent. Keys match {@link PROFILE_PROPERTY_KEY}. */
export type WirePeopleOp =
  | { op: 'set' | 'set_once'; user_id: string; ts: string; props: Properties }
  | { op: 'unset'; user_id: string; ts: string; keys: string[] }
  | { op: 'increment'; user_id: string; ts: string; props: Record<string, number> };

export interface EventBatch {
  token: string;
  /** Client clock when the batch was sent. */
  sent_at: string;
  lib: 'web' | 'server';
  lib_version: string;
  /** Whether the visitor has given consent (or the project needs none). */
  consent: boolean;
  /** 1 to {@link MAX_EVENTS_PER_BATCH} events. */
  events: WireEvent[];
  /** At most {@link MAX_PEOPLE_OPS_PER_BATCH}, only with consent. */
  people?: WirePeopleOp[];
}

/** One event sent to `POST /v1/track` or `/v1/import` with a secret key. */
export interface ServerEvent {
  event_id: string;
  name: SystemEventName | string;
  ts: string;
  /** Whoever the caller counts as the visitor (a user id or an anonymous id). Matches {@link USER_ID}. */
  distinct_id: string;
  user_id?: string;
  anon_id?: string;
  url?: string;
  title?: string;
  props?: Properties;
}

export interface ServerBatch {
  lib: 'server';
  lib_version: string;
  events: ServerEvent[];
  people?: WirePeopleOp[];
}

export type DeviceClass = 'desktop' | 'tablet' | 'mobile';

/** < 768 px mobile, < 1024 px tablet, else desktop: the same split as the collector's `deviceClassFromViewport`. */
export function deviceClassFromViewport(width: number): DeviceClass {
  if (width < 768) return 'mobile';
  return width < 1024 ? 'tablet' : 'desktop';
}

/** `GET /c/:token`: what the SDK needs before it collects anything. */
export interface ClientConfig {
  autocapture: boolean;
  consentMode: 'required' | 'none';
  maskingLevel: 'strict' | 'balanced' | 'relaxed';
  /** URL patterns (`/admin/*`) where the SDK sends nothing. */
  excludedUrls: string[];
  /** 0 to 1: the share of consented sessions the SDK records. */
  recordingSampleRate: number;
  /** Quota state or settings stop new recordings: the SDK doesn't load the recorder. */
  recordingBlocked: boolean;
  /** One masked page snapshot the project wants for a heatmap background. */
  snapshot: { pageGroupId: string; urlPattern: string; deviceClass: DeviceClass } | null;
}

// ── Recordings (`POST /r`, `POST /snap`) ──────────────────────────────────

/** A recording chunk or snapshot is at most this many compressed bytes. */
export const MAX_BLOB_BYTES = 1024 * 1024;
/** Chunk numbers run from 0 to this per session. */
export const MAX_SEQ = 100000;
