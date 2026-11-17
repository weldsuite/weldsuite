/**
 * The wire format between this SDK and the collector (panel-ingest).
 *
 * A plain TypeScript copy of `packages/domains/panel/src/wire.ts`, the Zod
 * source of truth on the collector side. The SDK keeps its own copy so an app
 * bundle never pulls in zod; `wire.contract.test.ts` checks that the two
 * agree and that every batch {@link nextBatch} builds passes the Zod schema.
 * Change both together.
 */

export const MAX_EVENTS_PER_BATCH = 100;
export const MAX_BATCH_BYTES = 64 * 1024;
export const MAX_PROPERTIES = 50;
export const MAX_STRING = 2048;
export const MAX_TITLE = 512;
export const MAX_ID = 64;
export const MAX_PEOPLE_OPS_PER_BATCH = 50;
export const MAX_UNSET_KEYS = 50;
export const MAX_GROUP_OPS_PER_BATCH = 50;
/** Group types a project collects; the collector drops the ops and `$group_<type>` properties of any type past these. */
export const MAX_GROUP_TYPES = 5;
/** A group type (`company`, `workspace`): sent as the `$group_<type>` event property. */
export const GROUP_TYPE = /^[a-z][a-z0-9_]{0,31}$/;
/** A group key: 1 to 255 characters, no control characters ({@link USER_ID}). */
export const MAX_GROUP_KEY = 255;
/** The event property that carries a group membership. */
export const GROUP_PROPERTY = /^\$group_([a-z][a-z0-9_]{0,31})$/;

/** `$`-prefixed names are reserved for events the SDKs send themselves. */
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
  '$webvitals',
  '$screen',
  '$app_opened',
  '$app_backgrounded',
  '$app_installed',
  '$app_updated',
] as const;
export type SystemEventName = (typeof SYSTEM_EVENTS)[number];

/** Custom event names: up to 100 characters, starting and ending with a non-space. */
export const CUSTOM_EVENT_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9 _.:/-]{0,98}[A-Za-z0-9_.:/-])?$/;
/** Property keys: identifiers. What `track()`, `screen()` and `register()` take. */
export const PROPERTY_KEY = /^[A-Za-z_]\w{0,63}$/;
/** Reserved event keys about the page and the visitor: `$exception`'s source, line and column, `$quickback`'s page left, the first touch and `$group_<type>`. */
export const PAGE_EVENT_KEY =
  /^\$(?:source|line|col|from|initial_(?:referrer|referring_domain|utm_source|utm_medium|utm_campaign|utm_content|utm_term|landing_path)|group_[a-z][a-z0-9_]{0,31})$/;
/** Reserved event keys about the device: `$webvitals`' measures, and the mobile SDK's device and screen. */
export const DEVICE_EVENT_KEY =
  /^\$(?:lcp|inp|fcp|ttfb|cls|lcp_el|inp_el|cls_el|nav_type|screen_name|os|os_version|device_type|device_model|app_id|app_version|app_build|screen_width|screen_height|locale)$/;
/** What a property key is checked against: a RegExp, or {@link EVENT_PROPERTY_KEY}. */
export interface KeyPattern {
  test(key: string): boolean;
}
/**
 * Event property keys: {@link PROPERTY_KEY} plus the reserved `$` keys the SDKs set themselves
 * ({@link PAGE_EVENT_KEY}, {@link DEVICE_EVENT_KEY}).
 */
export const EVENT_PROPERTY_KEY: KeyPattern = {
  test: (key) => PROPERTY_KEY.test(key) || PAGE_EVENT_KEY.test(key) || DEVICE_EVENT_KEY.test(key),
};
/** Profile property keys (people and groups): {@link PROPERTY_KEY} plus the reserved profile fields. */
export const PROFILE_PROPERTY_KEY =
  /^(?:[A-Za-z_]\w{0,63}|\$(?:email|name|avatar|created|initial_(?:referrer|referring_domain|utm_source|utm_medium|utm_campaign|utm_content|utm_term|landing_path)))$/;
/** User ids (and group keys): 1 to 255 characters, no control characters. */
export const USER_ID = /^[^\u0000-\u001f\u007f-\u009f]{1,255}$/;

export type PropertyValue = string | number | boolean | null;
export type Properties = Record<string, PropertyValue>;

/** The event fields a mobile client sends (the web-only ones, `el`, `x`, `scroll_depth` and so on, never). */
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
  /** Only with consent, on every event after `identify()`. */
  user_id?: string;
  /** An absolute URL, at most 2048 characters: `app://<app id>/<screen>` on mobile. */
  url: string;
  /** The current screen's name. */
  title?: string;
  /** The window's width, integer 0 to 20000. */
  viewport_w?: number;
  /** At most {@link MAX_PROPERTIES} keys matching {@link EVENT_PROPERTY_KEY}. */
  props?: Properties;
}

/** A profile operation: only with consent. Keys match {@link PROFILE_PROPERTY_KEY}. */
export type WirePeopleOp =
  | { op: 'set' | 'set_once'; user_id: string; ts: string; props: Properties }
  | { op: 'unset'; user_id: string; ts: string; keys: string[] }
  | { op: 'increment'; user_id: string; ts: string; props: Record<string, number> };

/** A group profile operation: sent with or without consent (it describes a group, not the person). */
export type WireGroupOp =
  | { op: 'set' | 'set_once'; type: string; key: string; props: Properties }
  | { op: 'unset'; type: string; key: string; keys: string[] };

export interface EventBatch {
  token: string;
  /** Client clock when the batch was sent. */
  sent_at: string;
  lib: 'mobile';
  lib_version: string;
  /** Whether the person has consented (or the project needs no consent). */
  consent: boolean;
  /** 1 to {@link MAX_EVENTS_PER_BATCH} events. */
  events: WireEvent[];
  /** At most {@link MAX_PEOPLE_OPS_PER_BATCH}, only with consent. */
  people?: WirePeopleOp[];
  /** At most {@link MAX_GROUP_OPS_PER_BATCH}. */
  groups?: WireGroupOp[];
}

/** `GET /c/:token`. Only the consent mode matters on mobile. */
export interface ClientConfig {
  consentMode: 'required' | 'none';
}
