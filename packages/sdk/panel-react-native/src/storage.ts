/**
 * What the SDK keeps on the device, through the storage adapter the app
 * passes in (AsyncStorage fits it). Before consent: nothing but the opt-out
 * flag, if the person opted out. With consent (or a project that needs none):
 *
 * - `weldpanel:<token>`: the ids, the user id, super properties, group
 *   memberships and the app version last seen ({@link StoredRecord});
 * - `weldpanel:<token>:queue`: events and operations not sent yet
 *   ({@link StoredQueue}), so they survive the app being closed offline.
 *
 * Without an adapter everything lives in memory for the life of the process.
 */

import { normalizeEvent, normalizeGroupOp, normalizePeopleOp, uuid, type EventInput, type GroupOpInput, type PeopleOpInput } from './event';
import { GROUP_TYPE, PROPERTY_KEY, type Properties, type WireEvent, type WireGroupOp, type WirePeopleOp } from './wire';

/** The storage the SDK writes to: `@react-native-async-storage/async-storage` fits it as is. */
export interface StorageAdapter {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

/** A session ends after 30 minutes without events. */
export const SESSION_TIMEOUT_MS = 30 * 60 * 1000;
/** `'1'` while the person has opted out (for every project in the app). */
export const OPT_OUT_KEY = 'weldpanel:optout';
export const stateKey = (token: string): string => `weldpanel:${token}`;
export const queueKey = (token: string): string => `weldpanel:${token}:queue`;

export interface Identity {
  /** Anonymous id, `a_` + UUID. */
  anonId: string;
  /** Session id, `s_` + UUID. */
  sessionId: string;
  /** Last event, epoch ms. */
  lastEventAt: number;
  /** True when `consent.grant()` created it, false when the project needs no consent. */
  granted: boolean;
  /** The user id from `identify()`. */
  userId?: string;
}

/** `weldpanel:<token>`. */
export interface StoredRecord extends Identity {
  superProps: Properties;
  /** Group type → key. */
  groups: Record<string, string>;
  /**
   * The app version last seen: a string, or null when the app passes no
   * version. Missing until the first launch with consent was recorded.
   */
  appVersion?: string | null;
}

/** `weldpanel:<token>:queue`: only events collected with consent are kept. */
export interface StoredQueue {
  events: WireEvent[];
  people: WirePeopleOp[];
  groups: WireGroupOp[];
}

export function newIdentity(granted: boolean, now: number): Identity {
  return { anonId: `a_${uuid()}`, sessionId: `s_${uuid()}`, lastEventAt: now, granted };
}

/** Rolls the session after {@link SESSION_TIMEOUT_MS} of silence and records this event's time. */
export function touchSession(id: Identity, now: number): Identity {
  return { ...id, sessionId: now - id.lastEventAt > SESSION_TIMEOUT_MS ? `s_${uuid()}` : id.sessionId, lastEventAt: now };
}

function parseObject(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function primitives(v: unknown, key: RegExp): Properties {
  const out: Properties = {};
  if (!isObject(v)) return out;
  for (const k of Object.keys(v)) {
    const value = v[k];
    if (!key.test(k) || k === '__proto__') continue;
    if (value === null || typeof value === 'boolean' || typeof value === 'string' || (typeof value === 'number' && isFinite(value))) {
      out[k] = value;
    }
  }
  return out;
}

/** The stored record, or null when it is missing or not one of ours. */
export function parseRecord(raw: string | null): StoredRecord | null {
  const v = parseObject(raw);
  if (!v || typeof v.anonId !== 'string' || typeof v.sessionId !== 'string' || typeof v.lastEventAt !== 'number') return null;
  const groups: Record<string, string> = {};
  if (isObject(v.groups)) {
    for (const type of Object.keys(v.groups)) {
      const key = v.groups[type];
      if (GROUP_TYPE.test(type) && typeof key === 'string' && key) groups[type] = key;
    }
  }
  const record: StoredRecord = {
    anonId: v.anonId,
    sessionId: v.sessionId,
    lastEventAt: v.lastEventAt,
    granted: v.granted === true,
    superProps: primitives(v.superProps, PROPERTY_KEY),
    groups,
  };
  if (typeof v.userId === 'string' && v.userId) record.userId = v.userId;
  if ('appVersion' in v) record.appVersion = typeof v.appVersion === 'string' ? v.appVersion : null;
  return record;
}

/** The stored queue, every item checked again (what doesn't pass is left out). */
export function parseQueue(raw: string | null): StoredQueue {
  const v = parseObject(raw);
  const list = (x: unknown): unknown[] => (Array.isArray(x) ? x : []);
  const events: WireEvent[] = [];
  const people: WirePeopleOp[] = [];
  const groups: WireGroupOp[] = [];
  if (!v) return { events, people, groups };
  for (const e of list(v.events)) {
    const event = isObject(e) ? normalizeEvent(e as unknown as EventInput) : null;
    if (event) events.push(event);
  }
  for (const o of list(v.people)) {
    const op = isObject(o) ? normalizePeopleOp(o as unknown as PeopleOpInput) : null;
    if (op) people.push(op);
  }
  for (const o of list(v.groups)) {
    const op = isObject(o) ? normalizeGroupOp(o as unknown as GroupOpInput, undefined, true) : null;
    if (op) groups.push(op);
  }
  return { events, people, groups };
}

export interface Writer {
  /**
   * Write `value()` to `key` (or remove it when it returns null), soon and in
   * order. Writes to the same key in the same turn collapse into one, and
   * `value` runs only then, so a busy queue is serialised once.
   */
  write(key: string, value: () => string | null): void;
  /** Resolves when the writes asked for so far are done. */
  idle(): Promise<void>;
}

/** Serialises writes to the adapter; a failing adapter costs only the write. */
export function createWriter(storage: StorageAdapter | undefined, onError: (err: unknown) => void): Writer {
  const latest = new Map<string, () => string | null>();
  let chain: Promise<void> = Promise.resolve();
  let scheduled = false;

  async function run(): Promise<void> {
    scheduled = false;
    const entries = Array.from(latest.entries());
    latest.clear();
    for (const [key, value] of entries) {
      try {
        const v = value();
        if (v === null) await storage?.removeItem(key);
        else await storage?.setItem(key, v);
      } catch (err) {
        onError(err);
      }
    }
  }

  return {
    write(key, value) {
      if (!storage) return;
      latest.set(key, value);
      if (scheduled) return;
      scheduled = true;
      chain = chain.then(run);
    },
    idle: () => chain,
  };
}

/** `getItem`, or null when the adapter is missing, throws or rejects. */
export async function readItem(storage: StorageAdapter | undefined, key: string): Promise<string | null> {
  if (!storage) return null;
  try {
    const v = await storage.getItem(key);
    return typeof v === 'string' ? v : null;
  } catch {
    return null;
  }
}
