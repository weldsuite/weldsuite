import {
  isoTime,
  LIB_VERSION,
  normalizeEvent,
  normalizeGroupOp,
  normalizePeopleOp,
  utf8Length,
  type EventInput,
  type GroupOpInput,
  type PeopleOpInput,
} from './event';
import {
  MAX_BATCH_BYTES,
  MAX_EVENTS_PER_BATCH,
  MAX_GROUP_OPS_PER_BATCH,
  MAX_PEOPLE_OPS_PER_BATCH,
  type EventBatch,
  type WireEvent,
  type WireGroupOp,
  type WirePeopleOp,
} from './wire';

export interface BatchInput {
  /** The project token (`wpk_…`). */
  token: string;
  /** Whether the visitor has consented (or the project needs no consent). */
  consent: boolean;
  events: ReadonlyArray<EventInput | WireEvent>;
  /**
   * Profile operations. Sent only with consent, and only alongside events: a
   * batch always has at least one event, so operations that find no room in
   * the event batches are left out.
   */
  people?: ReadonlyArray<PeopleOpInput | WirePeopleOp>;
  /**
   * Group profile operations: like `people`, but sent with or without consent
   * (they describe a company or an account, not the visitor).
   */
  groups?: ReadonlyArray<GroupOpInput | WireGroupOp>;
  /** Defaults to now. */
  sentAt?: string | number | Date;
  /** Defaults to this package's version. */
  libVersion?: string;
}

/**
 * The bodies the SDK POSTs to `{collector}/e` for these events: each one at
 * most {@link MAX_EVENTS_PER_BATCH} events, {@link MAX_PEOPLE_OPS_PER_BATCH}
 * profile operations, {@link MAX_GROUP_OPS_PER_BATCH} group operations and
 * {@link MAX_BATCH_BYTES} bytes of JSON. Events are run through
 * {@link normalizeEvent} and operations through {@link normalizePeopleOp} /
 * {@link normalizeGroupOp}; those that cannot be made valid, or that would not
 * fit in a batch, are left out.
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
  const sizes: number[] = [];
  let events: WireEvent[] = [];
  let size = base;
  for (const raw of input.events) {
    const event = normalizeEvent(raw);
    if (!event) continue;
    const n = utf8Length(JSON.stringify(event));
    if (base + n > MAX_BATCH_BYTES) continue;
    if (events.length && (events.length >= MAX_EVENTS_PER_BATCH || size + 1 + n > MAX_BATCH_BYTES)) {
      batches.push({ ...head, events });
      sizes.push(size);
      events = [];
      size = base;
    }
    size += (events.length ? 1 : 0) + n;
    events.push(event);
  }
  if (events.length) {
    batches.push({ ...head, events });
    sizes.push(size);
  }

  // Profile operations only with consent; group operations with or without.
  for (const raw of (input.consent && input.people) || []) addOp(batches, sizes, 'people', MAX_PEOPLE_OPS_PER_BATCH, normalizePeopleOp(raw as PeopleOpInput));
  for (const raw of input.groups || []) addOp(batches, sizes, 'groups', MAX_GROUP_OPS_PER_BATCH, normalizeGroupOp(raw as GroupOpInput));
  return batches;
}

/** Puts an operation in the first batch with room for it; `sizes` tracks each batch's JSON bytes. */
function addOp(batches: EventBatch[], sizes: number[], field: 'people' | 'groups', max: number, op: WirePeopleOp | WireGroupOp | null): void {
  if (!op) return;
  const n = utf8Length(JSON.stringify(op));
  for (let i = 0; i < batches.length; i++) {
    // `op` is of `field`'s kind, so the list stays all one kind.
    const batch: Partial<Record<typeof field, Array<WirePeopleOp | WireGroupOp>>> = batches[i];
    // A batch's list is never empty: it is made for its first operation.
    const list = batch[field] || [];
    // `,"people":[` / `,"groups":[` + `]` the first time, a comma after that.
    const extra = list.length ? n + 1 : n + 12;
    if (list.length >= max || sizes[i] + extra > MAX_BATCH_BYTES) continue;
    list.push(op);
    batch[field] = list;
    sizes[i] += extra;
    return;
  }
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
