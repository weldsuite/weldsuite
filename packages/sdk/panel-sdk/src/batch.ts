import { isoTime, LIB_VERSION, normalizeEvent, utf8Length, type EventInput } from './event';
import { MAX_BATCH_BYTES, MAX_EVENTS_PER_BATCH, type EventBatch, type WireEvent } from './wire';

export interface BatchInput {
  /** The project token (`wpk_…`). */
  token: string;
  /** Whether the visitor has consented (or the project needs no consent). */
  consent: boolean;
  events: ReadonlyArray<EventInput | WireEvent>;
  /** Defaults to now. */
  sentAt?: string | number | Date;
  /** Defaults to this package's version. */
  libVersion?: string;
}

/**
 * The bodies the SDK POSTs to `{collector}/e` for these events: each one at
 * most {@link MAX_EVENTS_PER_BATCH} events and {@link MAX_BATCH_BYTES} bytes
 * of JSON. Events are run through {@link normalizeEvent}; those that cannot be
 * made valid, or that would not fit in a batch on their own, are left out.
 *
 * Pure apart from filling a missing `event_id`, `ts` or `sentAt`. This is the
 * function the transport uses, so a test that validates its output against the
 * collector's schema checks what browsers actually send.
 */
export function buildBatches(input: BatchInput): EventBatch[] {
  const head = {
    token: input.token,
    sent_at: isoTime(input.sentAt),
    lib: 'web' as const,
    lib_version: input.libVersion ?? LIB_VERSION,
    consent: input.consent,
  };
  // `{...head,"events":[]}`: each event adds its own JSON plus a comma.
  const base = utf8Length(JSON.stringify({ ...head, events: [] }));
  const batches: EventBatch[] = [];
  let events: WireEvent[] = [];
  let size = base;
  for (const raw of input.events) {
    const event = normalizeEvent(raw);
    if (!event) continue;
    const n = utf8Length(JSON.stringify(event));
    if (base + n > MAX_BATCH_BYTES) continue;
    if (events.length && (events.length >= MAX_EVENTS_PER_BATCH || size + 1 + n > MAX_BATCH_BYTES)) {
      batches.push({ ...head, events });
      events = [];
      size = base;
    }
    size += (events.length ? 1 : 0) + n;
    events.push(event);
  }
  if (events.length) batches.push({ ...head, events });
  return batches;
}

/**
 * One batch for events that fit in one: {@link buildBatches} for callers that
 * want a single body (tests, scripts). Throws a RangeError when the events
 * need more than one batch or none of them is valid.
 */
export function buildBatch(input: BatchInput): EventBatch {
  const batches = buildBatches(input);
  if (batches.length !== 1) {
    throw new RangeError(batches.length ? `Events need ${batches.length} batches` : 'No valid events');
  }
  return batches[0];
}
