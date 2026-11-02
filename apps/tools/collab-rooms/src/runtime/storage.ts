/**
 * A Durable Object's `ctx.storage` on Node: the values live in memory (read
 * and listed from there, as the runtime serves them from its cache), and
 * every write goes through to the object store, one object per key under the
 * room's prefix, JSON encoded.
 *
 * - Writes to one key are applied in order, and a write still queued behind
 *   another for the same key is replaced by the newer value.
 * - `written()` settles once every write issued so far is durable: the room
 *   host holds socket sends behind it, as the runtime's output gate holds a
 *   Durable Object's.
 * - Logged ops (`op:…`) are written create-only. Finding one taken means
 *   another pod committed that revision of this room (the pod set changed
 *   under it): the storage is broken, and the host drops the room so it
 *   reloads from the store instead of forking the document.
 * - Tickets (`ticket:…`) are kept in memory only: single use, a minute long,
 *   redeemed on the pod that issued them.
 */

import type { ObjectStore } from './objects';

const EPHEMERAL = 'ticket:';
const CREATE_ONLY = 'op:';
const DELETE = Symbol('delete');

type Pending = { value: unknown } | typeof DELETE;

export interface ListOptions {
  prefix?: string;
  start?: string;
  startAfter?: string;
  end?: string;
  limit?: number;
  reverse?: boolean;
}

export class RoomStorage {
  private readonly data = new Map<string, unknown>();
  private readonly queued = new Map<string, Pending>();
  private readonly draining = new Set<string>();
  private readonly inflight = new Set<Promise<void>>();
  private alarmAt: number | null = null;
  /** Set once a write failed: the room must be dropped and reloaded. */
  broken: Error | null = null;
  onBroken: (error: Error) => void = () => {};
  onAlarm: (at: number | null) => void = () => {};

  constructor(
    private readonly store: ObjectStore | null,
    private readonly prefix: string,
  ) {}

  /** Reads every value the room stored. */
  async load(): Promise<void> {
    if (!this.store) return;
    const keys = await this.store.list(this.prefix);
    const values = await mapLimit(keys, 16, async (key) => {
      const object = await this.store!.get(key);
      return [key.slice(this.prefix.length), object] as const;
    });
    for (const [key, object] of values) {
      if (object) this.data.set(decodeURIComponent(key), JSON.parse(new TextDecoder().decode(object.bytes)) as unknown);
    }
  }

  /** Settles when every write issued so far is durable; throws once the storage broke. */
  async written(): Promise<void> {
    while (this.inflight.size > 0) await Promise.all([...this.inflight]);
    if (this.broken) throw this.broken;
  }

  get pending(): boolean {
    return this.inflight.size > 0;
  }

  get alarm(): number | null {
    return this.alarmAt;
  }

  // ---- Durable Object storage API ----

  async get<T>(key: string | string[]): Promise<T | undefined | Map<string, T>> {
    if (Array.isArray(key)) {
      const out = new Map<string, T>();
      for (const k of key) if (this.data.has(k)) out.set(k, structuredClone(this.data.get(k)) as T);
      return out;
    }
    return structuredClone(this.data.get(key)) as T | undefined;
  }

  async put(keyOrEntries: string | Record<string, unknown>, value?: unknown): Promise<void> {
    const entries = typeof keyOrEntries === 'string' ? { [keyOrEntries]: value } : keyOrEntries;
    for (const [key, v] of Object.entries(entries)) {
      this.data.set(key, structuredClone(v));
      if (!key.startsWith(EPHEMERAL)) this.schedule(key, { value: v });
    }
  }

  async delete(keys: string | string[]): Promise<boolean | number> {
    let count = 0;
    for (const key of Array.isArray(keys) ? keys : [keys]) {
      if (this.data.delete(key)) count++;
      if (!key.startsWith(EPHEMERAL)) this.schedule(key, DELETE);
    }
    return Array.isArray(keys) ? count : count > 0;
  }

  async deleteAll(): Promise<void> {
    await this.delete([...this.data.keys()]);
  }

  async list<T>(options: ListOptions = {}): Promise<Map<string, T>> {
    let keys = [...this.data.keys()]
      .filter(
        (k) =>
          k.startsWith(options.prefix ?? '') &&
          (options.start === undefined || k >= options.start) &&
          (options.startAfter === undefined || k > options.startAfter) &&
          (options.end === undefined || k < options.end),
      )
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    if (options.reverse) keys.reverse();
    if (options.limit !== undefined) keys = keys.slice(0, options.limit);
    return new Map(keys.map((k) => [k, structuredClone(this.data.get(k)) as T]));
  }

  async getAlarm(): Promise<number | null> {
    return this.alarmAt;
  }

  async setAlarm(at: number | Date): Promise<void> {
    this.alarmAt = typeof at === 'number' ? at : at.getTime();
    this.onAlarm(this.alarmAt);
  }

  async deleteAlarm(): Promise<void> {
    this.alarmAt = null;
    this.onAlarm(null);
  }

  /** The alarm went off: it is cleared before the handler runs, as on Cloudflare. */
  clearAlarmForRun(): void {
    this.alarmAt = null;
  }

  /** Restores an alarm read from the alarm index when the room loads. */
  restoreAlarm(at: number | null): void {
    this.alarmAt = at;
  }

  async sync(): Promise<void> {
    await this.written();
  }

  async transaction<T>(fn: (txn: RoomStorage) => Promise<T>): Promise<T> {
    return fn(this);
  }

  // ---- Write-through ----

  private schedule(key: string, pending: Pending): void {
    if (!this.store) return;
    this.queued.set(key, pending);
    if (this.draining.has(key)) return;
    this.draining.add(key);
    const run = this.drain(key)
      .catch((error: unknown) => {
        const err = error instanceof Error ? error : new Error(String(error));
        if (!this.broken) {
          this.broken = err;
          this.onBroken(err);
        }
      })
      .finally(() => {
        this.draining.delete(key);
        this.inflight.delete(run);
      });
    this.inflight.add(run);
  }

  private async drain(key: string): Promise<void> {
    const objectKey = `${this.prefix}${encodeURIComponent(key)}`;
    for (let next = this.queued.get(key); next !== undefined; next = this.queued.get(key)) {
      this.queued.delete(key);
      if (next === DELETE) {
        await this.store!.delete(objectKey);
        continue;
      }
      const bytes = new TextEncoder().encode(JSON.stringify(next.value));
      const createOnly = key.startsWith(CREATE_ONLY);
      if ((await this.store!.put(objectKey, bytes, { contentType: 'application/json', createOnly })) === 'exists') {
        throw new Error(`Another pod committed ${key} of this room`);
      }
    }
  }
}

/** `fn` over `items`, at most `limit` at a time, results in order. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
