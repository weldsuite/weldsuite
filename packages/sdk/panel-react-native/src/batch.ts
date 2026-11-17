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

/** An event waiting to be sent, and whether it was collected with consent (so it leaves under that consent). */
export interface QueuedEvent {
  e: WireEvent;
  c: boolean;
}

export interface NextBatchInput {
  token: string;
  /** The queue, oldest first. Already normalised. */
  events: readonly QueuedEvent[];
  /** Profile operations, oldest first: they go only in a batch sent with consent. */
  people?: readonly WirePeopleOp[];
  /** Group operations, oldest first: they go with or without consent. */
  groups?: readonly WireGroupOp[];
  /** Defaults to now. */
  sentAt?: string | number | Date;
  /** Defaults to this package's version. */
  libVersion?: string;
}

/** The next body to POST, and what it takes off the queues once it is sent (or refused). */
export interface BatchPlan {
  /** Null when the leading events were all too large to ever send. */
  batch: EventBatch | null;
  /** The events this plan uses up: those in `batch`, plus any too large to ever send. */
  events: QueuedEvent[];
  people: WirePeopleOp[];
  groups: WireGroupOp[];
}

/** `,"people":[` + `]` (or `groups`) the first time; a comma after that. */
const OPS_KEY_BYTES = 12;

/**
 * The next batch from the front of the queue: events collected under the same
 * consent as the first one, at most {@link MAX_EVENTS_PER_BATCH} events,
 * {@link MAX_PEOPLE_OPS_PER_BATCH} profile and {@link MAX_GROUP_OPS_PER_BATCH}
 * group operations and {@link MAX_BATCH_BYTES} bytes of JSON.
 *
 * Operations travel with events (a batch needs at least one), and they are
 * placed right after the first event, so a long queue of events can't keep
 * them waiting. They stay in order: the first one that doesn't fit ends the
 * run, and it and those after it wait for the next batch.
 *
 * Returns null when the queue is empty. Pure apart from `sentAt`.
 */
export function nextBatch(input: NextBatchInput): BatchPlan | null {
  if (!input.events.length) return null;
  const consent = input.events[0].c;
  const head = {
    token: input.token,
    sent_at: isoTime(input.sentAt),
    lib: 'mobile' as const,
    lib_version: input.libVersion ?? LIB_VERSION,
    consent,
  };
  const base = utf8Length(JSON.stringify({ ...head, events: [] }));
  const used: QueuedEvent[] = [];
  const events: WireEvent[] = [];
  let people: WirePeopleOp[] = [];
  let groups: WireGroupOp[] = [];
  let size = base;

  for (const queued of input.events) {
    if (queued.c !== consent || events.length >= MAX_EVENTS_PER_BATCH) break;
    const n = utf8Length(JSON.stringify(queued.e));
    if (base + n > MAX_BATCH_BYTES) {
      // Never fits in any batch: it is used up, and dropped.
      used.push(queued);
      continue;
    }
    const extra = (events.length ? 1 : 0) + n;
    if (size + extra > MAX_BATCH_BYTES) break;
    size += extra;
    events.push(queued.e);
    used.push(queued);
    if (events.length === 1) {
      if (consent) [people, size] = takeOps(input.people, MAX_PEOPLE_OPS_PER_BATCH, size);
      [groups, size] = takeOps(input.groups, MAX_GROUP_OPS_PER_BATCH, size);
    }
  }

  if (!events.length) return { batch: null, events: used, people: [], groups: [] };
  const batch: EventBatch = { ...head, events };
  if (people.length) batch.people = people;
  if (groups.length) batch.groups = groups;
  return { batch, events: used, people, groups };
}

/** The leading operations that fit, and the batch's size with them. */
function takeOps<T>(ops: readonly T[] | undefined, max: number, size: number): [T[], number] {
  const taken: T[] = [];
  for (const op of ops ?? []) {
    if (taken.length >= max) break;
    const extra = utf8Length(JSON.stringify(op)) + (taken.length ? 1 : OPS_KEY_BYTES);
    if (size + extra > MAX_BATCH_BYTES) break;
    size += extra;
    taken.push(op);
  }
  return [taken, size];
}

export interface BuildInput {
  token: string;
  /** Whether the events were collected with consent. */
  consent: boolean;
  events: ReadonlyArray<EventInput>;
  people?: ReadonlyArray<PeopleOpInput>;
  groups?: ReadonlyArray<GroupOpInput>;
  sentAt?: string | number | Date;
  libVersion?: string;
}

/**
 * Every batch for these events and operations, in order: each input is
 * normalised as the client does when it is queued (invalid ones are left out),
 * then {@link nextBatch} is applied until the events run out. Operations that
 * find no batch are left out. For tests and scripts; the client sends one
 * {@link nextBatch} at a time.
 */
export function buildBatches(input: BuildInput): EventBatch[] {
  let events: QueuedEvent[] = [];
  for (const raw of input.events) {
    const e = normalizeEvent(raw);
    if (e) events.push({ e, c: input.consent });
  }
  let people = input.consent ? (input.people ?? []).map((op) => normalizePeopleOp(op)).filter(isPresent) : [];
  let groups = (input.groups ?? []).map((op) => normalizeGroupOp(op, undefined, true)).filter(isPresent);
  const batches: EventBatch[] = [];
  for (;;) {
    const plan = nextBatch({ token: input.token, events, people, groups, sentAt: input.sentAt, libVersion: input.libVersion });
    if (!plan) return batches;
    if (plan.batch) batches.push(plan.batch);
    events = events.slice(plan.events.length);
    people = people.slice(plan.people.length);
    groups = groups.slice(plan.groups.length);
  }
}

function isPresent<T>(v: T | null): v is T {
  return v !== null;
}
