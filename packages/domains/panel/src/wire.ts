/**
 * The wire format between the browser SDK (@weldsuite/panel-sdk) and the
 * collector (panel-ingest). Zod v3, used by the collector only: the SDK has
 * its own plain TypeScript copy of these shapes to stay small, and a
 * panel-ingest test checks that what the SDK sends passes {@link eventBatchSchema}.
 *
 * `POST /e` body (sent as `text/plain` JSON so browsers skip the CORS
 * preflight, and with `navigator.sendBeacon` on page hide):
 *
 *   { token, sent_at, lib, lib_version, consent, events: [...] }
 *
 * Without consent the SDK keeps nothing in the browser and sends no
 * `anon_id` / `session_id`; the collector derives a daily-rotating visitor
 * hash instead (ADR PANEL-006).
 */

import { z } from 'zod';

export const MAX_EVENTS_PER_BATCH = 100;
/** `navigator.sendBeacon` refuses bodies over 64 KiB, so the SDK stays under it and the collector enforces it. */
export const MAX_BATCH_BYTES = 64 * 1024;
export const MAX_PROPERTIES = 50;
export const MAX_STRING = 2048;
export const MAX_ELEMENT_TEXT = 255;

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
export const PROPERTY_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

const propertyValue = z.union([z.string().max(MAX_STRING), z.number().finite(), z.boolean(), z.null()]);

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
  /** `$pageleave`: furthest scroll reached, percent of the page height. */
  scroll_depth: z.number().int().min(0).max(100).optional(),
  props: z
    .record(z.string().regex(PROPERTY_KEY), propertyValue)
    .refine((p) => Object.keys(p).length <= MAX_PROPERTIES, { message: `At most ${MAX_PROPERTIES} properties` })
    .optional(),
});
export type WireEvent = z.infer<typeof wireEventSchema>;

export const eventBatchSchema = z.object({
  token: z.string().max(64),
  /** Client clock when the batch was sent. */
  sent_at: z.string().datetime({ offset: true }),
  lib: z.enum(['web', 'server']),
  lib_version: z.string().max(32),
  /** Whether the visitor has given consent (or the project needs none). */
  consent: z.boolean(),
  events: z.array(wireEventSchema).min(1).max(MAX_EVENTS_PER_BATCH),
});
export type EventBatch = z.infer<typeof eventBatchSchema>;

/** The batch with its events unchecked; {@link parseEventBatch} checks them one by one. */
export const batchEnvelopeSchema = eventBatchSchema.extend({
  events: z.array(z.unknown()).min(1).max(MAX_EVENTS_PER_BATCH),
});

export type ParsedEventBatch =
  | { ok: true; batch: EventBatch; dropped: number }
  | { ok: false; issues: z.ZodIssue[] };

/**
 * What the collector runs on a `POST /e` body: the envelope strictly, then
 * each event on its own, so an event this version doesn't understand (an SDK
 * newer or older than the schema) costs that event and not the whole batch.
 * A batch whose events are all invalid fails with the first event's issues.
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
  return { ok: true, batch: { ...envelope.data, events }, dropped: envelope.data.events.length - events.length };
}

/** `GET /c/:token`: what the SDK needs before it collects anything. */
export interface ClientConfig {
  autocapture: boolean;
  consentMode: 'required' | 'none';
  maskingLevel: 'strict' | 'balanced' | 'relaxed';
  /** URL patterns (`/admin/*`) where the SDK sends nothing. */
  excludedUrls: string[];
}
