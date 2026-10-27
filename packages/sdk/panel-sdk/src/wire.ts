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

/** `$`-prefixed names are reserved for events the SDK sends itself. */
export const SYSTEM_EVENTS = ['$pageview', '$pageleave', '$autocapture'] as const;
export type SystemEventName = (typeof SYSTEM_EVENTS)[number];

/**
 * Custom event names: what a person would type, not a sentence. Up to 100
 * characters, starting and ending with a non-space, so "Signed up " can't
 * become a second event next to "Signed up".
 */
export const CUSTOM_EVENT_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9 _.:/-]{0,98}[A-Za-z0-9_.:/-])?$/;
/** Property keys: identifiers, kept SQL-safe because the query compiler reads them with `json_get_*`. */
export const PROPERTY_KEY = /^[A-Za-z_]\w{0,63}$/;

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
  /** An absolute URL, at most 2048 characters. */
  url: string;
  title?: string;
  referrer?: string;
  /** Integer, 0 to 20000. */
  viewport_w?: number;
  /** `$autocapture`: the clicked or submitted element. */
  el?: WireElement;
  /** `$autocapture` click position in the document, CSS pixels: integers, x 0 to 100000, y 0 to 1000000. */
  x?: number;
  y?: number;
  /** `$pageleave`: furthest scroll reached, integer percent of the page height. */
  scroll_depth?: number;
  /** At most {@link MAX_PROPERTIES} keys matching {@link PROPERTY_KEY}. */
  props?: Properties;
}

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
}

/** `GET /c/:token`: what the SDK needs before it collects anything. */
export interface ClientConfig {
  autocapture: boolean;
  consentMode: 'required' | 'none';
  maskingLevel: 'strict' | 'balanced' | 'relaxed';
  /** URL patterns (`/admin/*`) where the SDK sends nothing. */
  excludedUrls: string[];
}
