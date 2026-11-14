/**
 * The wire format between the browser SDK (@weldsuite/panel-sdk) and the
 * collector (panel-ingest). Zod v3, used by the collector only: the SDK has
 * its own plain TypeScript copy of these shapes to stay small, and a
 * panel-ingest test checks that what the SDK sends passes {@link eventBatchSchema}.
 *
 * `POST /e` body (sent as `text/plain` JSON so browsers skip the CORS
 * preflight, and with `navigator.sendBeacon` on page hide):
 *
 *   { token, sent_at, lib, lib_version, consent, events: [...], people?: [...] }
 *
 * Without consent the SDK keeps nothing in the browser and sends no
 * `anon_id` / `session_id` / `user_id` / `people`; the collector derives a
 * daily-rotating visitor hash instead (ADR PANEL-006).
 *
 * The server API (`POST /v1/track`, `/v1/import`) has its own envelope
 * ({@link parseServerBatch}).
 */

import { z } from 'zod';

export const MAX_EVENTS_PER_BATCH = 100;
/** `navigator.sendBeacon` refuses bodies over 64 KiB, so the SDK stays under it and the collector enforces it. */
export const MAX_BATCH_BYTES = 64 * 1024;
export const MAX_PROPERTIES = 50;
export const MAX_STRING = 2048;
export const MAX_ELEMENT_TEXT = 255;
export const MAX_ERROR_MESSAGE = 1000;
export const MAX_PEOPLE_OPS_PER_BATCH = 50;
export const MAX_UNSET_KEYS = 50;

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
/**
 * Property keys of an event: {@link PROPERTY_KEY}, plus the few reserved `$`
 * keys the SDK's own events carry (`$exception`: source, line, column;
 * `$quickback`: the page left). Any other `$` key stays refused, so a client
 * can't forge the collector's own (`$action`).
 */
export const EVENT_PROPERTY_KEY = /^(?:[A-Za-z_]\w{0,63}|\$(?:source|line|col|from))$/;
/** Profile property keys: {@link PROPERTY_KEY}, plus the reserved profile fields. */
export const PROFILE_PROPERTY_KEY = /^(?:[A-Za-z_]\w{0,63}|\$(?:email|name|avatar|created))$/;
/** User ids: 1 to 255 characters, no control characters. */
export const USER_ID = /^[^\u0000-\u001f\u007f-\u009f]{1,255}$/;

const propertyValue = z.union([z.string().max(MAX_STRING), z.number().finite(), z.boolean(), z.null()]);

const eventProps = z
  .record(z.string().regex(EVENT_PROPERTY_KEY), propertyValue)
  .refine((p) => Object.keys(p).length <= MAX_PROPERTIES, { message: `At most ${MAX_PROPERTIES} properties` });

export const wireEventSchema = z.object({
  /** Client-generated UUID, so a retried batch can be told apart from a new one. */
  event_id: z.string().min(8).max(64),
  name: z.union([z.enum(SYSTEM_EVENTS), z.string().regex(CUSTOM_EVENT_NAME)]),
  /** Client clock, ISO 8601. The collector corrects it with `sent_at`. */
  ts: z.string().datetime({ offset: true }),
  /** Only with consent. */
  anon_id: z.string().max(64).optional(),
  /** Only with consent. */
  session_id: z.string().max(64).optional(),
  /** Only with consent, on every event after `identify()`. */
  user_id: z.string().regex(USER_ID).optional(),
  url: z.string().url().max(MAX_STRING),
  title: z.string().max(512).optional(),
  referrer: z.string().max(MAX_STRING).optional(),
  viewport_w: z.number().int().min(0).max(20000).optional(),
  /** `$autocapture`: the clicked or submitted element. */
  el: z
    .object({
      tag: z.string().max(32),
      selector: z.string().max(512),
      /** Visible text, masked per the project's masking level; never input values. */
      text: z.string().max(MAX_ELEMENT_TEXT).optional(),
      /** `click` or `submit`. */
      action: z.enum(['click', 'submit']),
    })
    .optional(),
  /** `$autocapture` click position in the document, CSS pixels. */
  x: z.number().int().min(0).max(100000).optional(),
  y: z.number().int().min(0).max(1000000).optional(),
  /** Click position inside the element's box, 0 to 1 (clicks, rage clicks, dead clicks). */
  rel_x: z.number().min(0).max(1).optional(),
  rel_y: z.number().min(0).max(1).optional(),
  /** `$pageleave`: furthest scroll reached, percent of the page height. `$excessivescroll` too. */
  scroll_depth: z.number().int().min(0).max(100).optional(),
  /** `$exception`: the error's message. */
  error_message: z.string().max(MAX_ERROR_MESSAGE).optional(),
  props: eventProps.optional(),
});
export type WireEvent = z.infer<typeof wireEventSchema>;

const profileKey = z.string().regex(PROFILE_PROPERTY_KEY);
const profileProps = <V extends z.ZodTypeAny>(value: V) =>
  z
    .record(profileKey, value)
    .refine((p) => Object.keys(p).length <= MAX_PROPERTIES, { message: `At most ${MAX_PROPERTIES} properties` });
const userId = z.string().regex(USER_ID);
const opTime = z.string().datetime({ offset: true });

/**
 * A profile operation (`people.set()` and friends), from the SDK in a batch's
 * `people` array (only with consent) and from the server API.
 */
export const wirePeopleOpSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('set'), user_id: userId, ts: opTime, props: profileProps(propertyValue) }),
  z.object({ op: z.literal('set_once'), user_id: userId, ts: opTime, props: profileProps(propertyValue) }),
  z.object({ op: z.literal('unset'), user_id: userId, ts: opTime, keys: z.array(profileKey).max(MAX_UNSET_KEYS) }),
  z.object({ op: z.literal('increment'), user_id: userId, ts: opTime, props: profileProps(z.number().finite()) }),
]);
export type WirePeopleOp = z.infer<typeof wirePeopleOpSchema>;

export const eventBatchSchema = z.object({
  token: z.string().max(64),
  /** Client clock when the batch was sent. */
  sent_at: z.string().datetime({ offset: true }),
  lib: z.enum(['web', 'server']),
  lib_version: z.string().max(32),
  /** Whether the visitor has given consent (or the project needs none). */
  consent: z.boolean(),
  events: z.array(wireEventSchema).min(1).max(MAX_EVENTS_PER_BATCH),
  /** Profile operations; only with consent (the collector ignores them without). */
  people: z.array(wirePeopleOpSchema).max(MAX_PEOPLE_OPS_PER_BATCH).optional(),
});
export type EventBatch = z.infer<typeof eventBatchSchema>;

/** The batch with its events and operations unchecked; {@link parseEventBatch} checks them one by one. */
export const batchEnvelopeSchema = eventBatchSchema.extend({
  events: z.array(z.unknown()).min(1).max(MAX_EVENTS_PER_BATCH),
  people: z.array(z.unknown()).max(MAX_PEOPLE_OPS_PER_BATCH).optional(),
});

export type ParsedEventBatch =
  | { ok: true; batch: EventBatch; dropped: number; peopleDropped: number }
  | { ok: false; issues: z.ZodIssue[] };

/** Profile operations one by one: an operation this version doesn't understand costs only itself. */
export function parsePeopleOps(raw: readonly unknown[] | undefined): { ops: WirePeopleOp[]; dropped: number } {
  const ops: WirePeopleOp[] = [];
  for (const candidate of raw ?? []) {
    const op = wirePeopleOpSchema.safeParse(candidate);
    if (op.success) ops.push(op.data);
  }
  return { ops, dropped: (raw?.length ?? 0) - ops.length };
}

/**
 * What the collector runs on a `POST /e` body: the envelope strictly, then
 * each event (and each profile operation) on its own, so one this version
 * doesn't understand (an SDK newer or older than the schema) costs that item
 * and not the whole batch. A batch whose events are all invalid fails with
 * the first event's issues.
 */
export function parseEventBatch(body: unknown): ParsedEventBatch {
  const envelope = batchEnvelopeSchema.safeParse(body);
  if (!envelope.success) return { ok: false, issues: envelope.error.issues };

  const events: WireEvent[] = [];
  let firstIssues: z.ZodIssue[] | null = null;
  envelope.data.events.forEach((raw, index) => {
    const event = wireEventSchema.safeParse(raw);
    if (event.success) events.push(event.data);
    else firstIssues ??= event.error.issues.map((issue) => ({ ...issue, path: ['events', index, ...issue.path] }));
  });
  if (events.length === 0) return { ok: false, issues: firstIssues ?? [] };

  const { people: rawPeople, ...rest } = envelope.data;
  const people = parsePeopleOps(rawPeople);
  const batch: EventBatch = { ...rest, events };
  if (people.ops.length > 0) batch.people = people.ops;
  return { ok: true, batch, dropped: envelope.data.events.length - events.length, peopleDropped: people.dropped };
}

// ---------------------------------------------------------------------------
// Server API: POST /v1/track and /v1/import
// ---------------------------------------------------------------------------

export const MAX_TRACK_EVENTS = 100;
export const MAX_IMPORT_EVENTS = 1000;

/** One event sent with a secret key. There is no browser: the caller names the visitor. */
export const serverEventSchema = z.object({
  event_id: z.string().min(8).max(64),
  name: z.union([z.enum(SYSTEM_EVENTS), z.string().regex(CUSTOM_EVENT_NAME)]),
  ts: z.string().datetime({ offset: true }),
  /** Required: whoever the caller counts as the visitor (a user id, or an anonymous id). */
  distinct_id: z.string().regex(USER_ID),
  user_id: z.string().regex(USER_ID).optional(),
  anon_id: z.string().max(64).optional(),
  url: z.string().url().max(MAX_STRING).optional(),
  title: z.string().max(512).optional(),
  props: eventProps.optional(),
});
export type ServerEvent = z.infer<typeof serverEventSchema>;

export interface ServerBatch {
  lib: 'server';
  lib_version: string;
  events: ServerEvent[];
  people?: WirePeopleOp[];
}

/** A server batch may carry only profile updates (`people.set(userId, …)` with no event), but not nothing. */
const serverEnvelopeSchema = z
  .object({
    lib: z.literal('server'),
    lib_version: z.string().max(32),
    events: z.array(z.unknown()).default([]),
    people: z.array(z.unknown()).max(MAX_PEOPLE_OPS_PER_BATCH).optional(),
  })
  .refine((body) => body.events.length > 0 || (body.people?.length ?? 0) > 0, {
    message: 'Send at least one event or people operation',
    path: ['events'],
  });

export type ParsedServerBatch =
  | { ok: true; batch: ServerBatch; dropped: number; peopleDropped: number }
  | { ok: false; issues: z.ZodIssue[] };

/** Like {@link parseEventBatch}, for `/v1/track` (`maxEvents` 100) and `/v1/import` (1000). */
export function parseServerBatch(body: unknown, maxEvents: number): ParsedServerBatch {
  const envelope = serverEnvelopeSchema.safeParse(body);
  if (!envelope.success) return { ok: false, issues: envelope.error.issues };
  if (envelope.data.events.length > maxEvents) {
    return {
      ok: false,
      issues: [
        {
          code: 'too_big',
          maximum: maxEvents,
          type: 'array',
          inclusive: true,
          exact: false,
          message: `Array must contain at most ${maxEvents} element(s)`,
          path: ['events'],
        },
      ],
    };
  }

  const events: ServerEvent[] = [];
  let firstIssues: z.ZodIssue[] | null = null;
  envelope.data.events.forEach((raw, index) => {
    const event = serverEventSchema.safeParse(raw);
    if (event.success) events.push(event.data);
    else firstIssues ??= event.error.issues.map((issue) => ({ ...issue, path: ['events', index, ...issue.path] }));
  });
  const people = parsePeopleOps(envelope.data.people);
  if (events.length === 0 && (envelope.data.events.length > 0 || people.ops.length === 0)) {
    return {
      ok: false,
      issues: firstIssues ?? [{ code: 'custom', message: 'No valid event or people operation', path: ['people'] }],
    };
  }

  const batch: ServerBatch = { lib: 'server', lib_version: envelope.data.lib_version, events };
  if (people.ops.length > 0) batch.people = people.ops;
  return { ok: true, batch, dropped: envelope.data.events.length - events.length, peopleDropped: people.dropped };
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
  /** A masked page snapshot the project wants from the next consented visitor on a matching page and device class. */
  snapshot: { pageGroupId: string; urlPattern: string; deviceClass: 'desktop' | 'tablet' | 'mobile' } | null;
}
