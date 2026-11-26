/**
 * In-memory stand-ins for the Workers bindings a CollabRoom uses (R2,
 * Durable Object storage and sockets), for tests that run under node.
 */

import { FrameAssembler, decodeServer, type ServerMessage } from '../protocol';

export class FakeBucket {
  readonly objects = new Map<string, Uint8Array>();
  /** Keys whose puts throw, as when R2 is down. */
  readonly failing = new Set<string>();

  async put(key: string, body: ArrayBuffer | Uint8Array | string, options?: { onlyIf?: { etagDoesNotMatch?: string } }): Promise<object | null> {
    if (this.failing.has(key)) throw new Error(`R2 put ${key} failed`);
    // `etagDoesNotMatch: '*'`: only when nothing is there yet (R2 answers null otherwise).
    if (options?.onlyIf?.etagDoesNotMatch === '*' && this.objects.has(key)) return null;
    this.objects.set(key, typeof body === 'string' ? new TextEncoder().encode(body) : new Uint8Array(body));
    return { key };
  }

  async get(key: string): Promise<{ body: ReadableStream } | null> {
    const bytes = this.objects.get(key);
    return bytes ? { body: new Blob([new Uint8Array(bytes)]).stream() } : null;
  }

  asBinding(): R2Bucket {
    return this as unknown as R2Bucket;
  }
}

/** Durable Object storage's key-value API, with values copied in and out like the real one. */
export class FakeStorage {
  readonly data = new Map<string, unknown>();
  alarm: number | null = null;

  async get<T>(key: string): Promise<T | undefined> {
    return structuredClone(this.data.get(key)) as T | undefined;
  }

  async put(keyOrEntries: string | Record<string, unknown>, value?: unknown): Promise<void> {
    const entries = typeof keyOrEntries === 'string' ? { [keyOrEntries]: value } : keyOrEntries;
    for (const [k, v] of Object.entries(entries)) this.data.set(k, structuredClone(v));
  }

  async delete(keys: string | string[]): Promise<number> {
    let count = 0;
    for (const k of Array.isArray(keys) ? keys : [keys]) if (this.data.delete(k)) count++;
    return count;
  }

  async list<T>(options: { prefix?: string; end?: string } = {}): Promise<Map<string, T>> {
    const keys = [...this.data.keys()]
      .filter((k) => k.startsWith(options.prefix ?? '') && (options.end === undefined || k < options.end))
      .sort((a, b) => (a < b ? -1 : 1));
    return new Map(keys.map((k) => [k, structuredClone(this.data.get(k)) as T]));
  }

  async getAlarm(): Promise<number | null> {
    return this.alarm;
  }

  async setAlarm(at: number): Promise<void> {
    this.alarm = at;
  }

  async sync(): Promise<void> {}
}

export class FakeSocket {
  readonly frames: string[] = [];
  closed: { code?: number; reason?: string } | null = null;
  /** A socket already gone: `close` throws, as the runtime's does. */
  gone = false;
  private attachment: unknown = null;

  send(frame: string): void {
    if (this.gone) throw new Error('socket closed');
    this.frames.push(frame);
  }

  serializeAttachment(value: unknown): void {
    this.attachment = structuredClone(value);
  }

  deserializeAttachment(): unknown {
    return structuredClone(this.attachment);
  }

  close(code?: number, reason?: string): void {
    if (this.gone) throw new Error('socket closed');
    this.closed = { code, reason };
  }

  /** Everything received so far, frames joined back into messages. */
  messages<Op, Snapshot, Presence>(): ServerMessage<Op, Snapshot, Presence>[] {
    const assembler = new FrameAssembler();
    return this.frames
      .map((f) => assembler.accept(f))
      .filter((text): text is string => text !== null)
      .map((text) => decodeServer<Op, Snapshot, Presence>(text)!);
  }

  asSocket(): WebSocket {
    return this as unknown as WebSocket;
  }
}

/** A Durable Object's `ctx`: storage plus the hibernatable sockets it holds. */
export function fakeObjectState(id = 'a'.repeat(64)) {
  const storage = new FakeStorage();
  const sockets: FakeSocket[] = [];
  const ctx = {
    id: { toString: () => id },
    storage,
    acceptWebSocket: (ws: FakeSocket) => sockets.push(ws),
    getWebSockets: () => [...sockets],
  } as unknown as DurableObjectState;
  return { ctx, storage, sockets };
}
