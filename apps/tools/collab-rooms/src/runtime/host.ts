/**
 * The Durable Object runtime, for the two room classes: one `RoomHost` per
 * live room gives the class its `ctx` (id, storage, sockets) and `env`, and
 * runs its events the way the runtime does:
 *
 * - Socket messages reach `webSocketMessage` one at a time per socket, in
 *   order; a close reaches `webSocketClose` after that socket's messages.
 * - Output gate: whatever a socket sends waits until every storage write
 *   issued before it is durable.
 * - Alarms are timers. The handler is retried with backoff when it throws,
 *   and the time is kept in the alarm index (`collab-alarms/…`), so a room
 *   whose pod restarted or dropped it is woken again (`RoomNamespace.wake`).
 * - A room with no socket, no pending write and no alarm due soon is dropped
 *   after `idleMs` (Durable Object eviction; its storage stays in the store).
 *   A room whose storage broke is dropped at once and its sockets closed;
 *   clients reconnect and catch up from what was committed.
 */

import { createHash } from 'node:crypto';
import type { WebSocket as Ws } from 'ws';
import type { ObjectStore } from './objects';
import { RoomStorage } from './storage';

/** What the room classes implement (DocRoom, SheetRoom). */
export interface RoomObject {
  accept(server: unknown, secret: string | null): Promise<'ok' | 'invalid' | 'unavailable'>;
  webSocketMessage(ws: unknown, message: string | ArrayBuffer): Promise<void>;
  webSocketClose(ws: unknown, code: number, reason: string, wasClean?: boolean): Promise<void>;
  webSocketError?(ws: unknown, error: unknown): Promise<void>;
  alarm?(): Promise<void>;
}

export type RoomFactory = (ctx: unknown, env: unknown) => RoomObject;

const ALARM_RETRIES = 6;

/** A room's id: what `idFromName` gives on Cloudflare, and the prefix of its tickets. */
export function roomId(binding: string, name: string): string {
  return createHash('sha256').update(`${binding}:${name}`).digest('hex');
}

/** A socket as a Durable Object holds it, on top of a `ws` socket attached once the upgrade completes. */
export class HostedSocket {
  private ws: Ws | null = null;
  private readonly early: (string | ArrayBuffer)[] = [];
  private attachment: unknown = null;
  /** This socket's events, one after the other. */
  inbox: Promise<void> = Promise.resolve();
  closed = false;

  constructor(private readonly host: RoomHost) {}

  attach(ws: Ws): void {
    this.ws = ws;
    for (const frame of this.early.splice(0)) ws.send(frame);
    ws.on('message', (data, isBinary) => {
      const message = isBinary ? toArrayBuffer(data) : data.toString();
      this.host.deliver(this, (object) => object.webSocketMessage(this, message));
    });
    ws.on('close', (code, reason) => this.host.socketClosed(this, code, reason.toString()));
    ws.on('error', (error) => this.host.deliver(this, (object) => object.webSocketError?.(this, error) ?? Promise.resolve()));
  }

  send(frame: string | ArrayBuffer): void {
    this.host.gate(() => this.sendNow(frame));
  }

  private sendNow(frame: string | ArrayBuffer): void {
    if (!this.ws) {
      this.early.push(frame);
      return;
    }
    if (this.ws.readyState === this.ws.OPEN) this.ws.send(frame);
  }

  close(code?: number, reason?: string): void {
    if (this.ws && (this.ws.readyState === this.ws.OPEN || this.ws.readyState === this.ws.CONNECTING)) {
      this.ws.close(code, reason);
    } else if (!this.ws) {
      this.closed = true;
    }
  }

  serializeAttachment(value: unknown): void {
    this.attachment = structuredClone(value);
  }

  deserializeAttachment(): unknown {
    return structuredClone(this.attachment);
  }
}

function toArrayBuffer(data: unknown): ArrayBuffer {
  const buffers = Array.isArray(data) ? (data as Buffer[]) : [data as Buffer];
  const joined = Buffer.concat(buffers.map((b) => (b instanceof ArrayBuffer ? Buffer.from(b) : b)));
  return joined.buffer.slice(joined.byteOffset, joined.byteOffset + joined.byteLength) as ArrayBuffer;
}

export class RoomHost {
  readonly storage: RoomStorage;
  readonly sockets = new Set<HostedSocket>();
  readonly object: RoomObject;
  private outbox: Promise<void> = Promise.resolve();
  /** Socket events not finished yet. */
  private readonly running = new Set<Promise<void>>();
  private alarmTimer: NodeJS.Timeout | null = null;
  lastActive = Date.now();
  dropped = false;

  constructor(
    readonly binding: string,
    readonly id: string,
    store: ObjectStore | null,
    factory: RoomFactory,
    env: unknown,
    private readonly namespace: RoomNamespace,
  ) {
    this.storage = new RoomStorage(store, `collab-rooms/${binding}/${id}/`);
    this.storage.onBroken = (error) => {
      console.error(`[collab-rooms] ${binding} ${id}: storage failed, dropping the room:`, error.message);
      this.namespace.drop(this, 1012, 'Reloading the document');
    };
    this.storage.onAlarm = (at) => {
      this.armAlarm(at);
      this.namespace.recordAlarm(this, at);
    };
    const ctx = {
      id: { toString: () => id, equals: (other: { toString(): string }) => other.toString() === id },
      storage: this.storage,
      acceptWebSocket: (ws: HostedSocket) => this.sockets.add(ws),
      getWebSockets: () => [...this.sockets].filter((s) => !s.closed),
      waitUntil: (promise: Promise<unknown>) => void promise.catch(() => undefined),
      blockConcurrencyWhile: <T>(fn: () => Promise<T>) => fn(),
    };
    this.object = factory(ctx, env);
  }

  touch(): void {
    this.lastActive = Date.now();
  }

  /** Holds `send` until the writes issued before it are durable. */
  gate(send: () => void): void {
    this.outbox = this.outbox
      .then(() => (this.storage.pending ? this.storage.written() : undefined))
      .then(send, () => undefined);
  }

  deliver(socket: HostedSocket, event: (object: RoomObject) => Promise<void>): void {
    this.touch();
    const run = socket.inbox
      .then(() => event(this.object))
      .catch((error: unknown) => console.error(`[collab-rooms] ${this.binding} ${this.id}: a socket event failed:`, error))
      .finally(() => this.running.delete(run));
    this.running.add(run);
    socket.inbox = run;
  }

  /** Settles once every socket event so far has been handled and its writes are durable. */
  async quiet(): Promise<void> {
    while (this.running.size > 0) await Promise.all([...this.running]);
    await this.storage.written().catch(() => undefined);
  }

  socketClosed(socket: HostedSocket, code: number, reason: string): void {
    socket.closed = true;
    this.sockets.delete(socket);
    this.deliver(socket, (object) => object.webSocketClose(socket, code, reason, true));
  }

  armAlarm(at: number | null): void {
    if (this.alarmTimer) clearTimeout(this.alarmTimer);
    this.alarmTimer = null;
    if (at === null || this.dropped) return;
    this.alarmTimer = setTimeout(() => void this.runAlarm(1), Math.max(0, at - Date.now()));
  }

  private async runAlarm(attempt: number): Promise<void> {
    this.alarmTimer = null;
    if (this.dropped || !this.object.alarm) return;
    this.touch();
    this.storage.clearAlarmForRun();
    try {
      await this.object.alarm();
      if (this.storage.alarm === null) this.namespace.recordAlarm(this, null);
    } catch (error) {
      console.error(`[collab-rooms] ${this.binding} ${this.id}: the alarm failed (attempt ${attempt}):`, error);
      if (attempt < ALARM_RETRIES && this.storage.alarm === null) {
        this.alarmTimer = setTimeout(() => void this.runAlarm(attempt + 1), 2 ** attempt * 1000);
      }
    }
  }

  /** Idle: no socket, nothing to write, no alarm due within `soonMs`. */
  idle(idleMs: number, soonMs: number): boolean {
    const alarm = this.storage.alarm;
    return (
      this.sockets.size === 0 &&
      !this.storage.pending &&
      (alarm === null || alarm - Date.now() > soonMs) &&
      Date.now() - this.lastActive > idleMs
    );
  }

  stop(code: number, reason: string): void {
    this.dropped = true;
    if (this.alarmTimer) clearTimeout(this.alarmTimer);
    for (const socket of this.sockets) {
      try {
        socket.close(code, reason);
      } catch {
        // Closing already.
      }
    }
  }
}

export interface NamespaceOptions {
  binding: string;
  factory: RoomFactory;
  env: unknown;
  store: ObjectStore | null;
  idleMs?: number;
}

/** One binding's rooms (`env.DOC_ROOM`): created on first use, one host per room id. */
export class RoomNamespace {
  private readonly hosts = new Map<string, Promise<RoomHost>>();
  private readonly idleMs: number;

  constructor(private readonly options: NamespaceOptions) {
    this.idleMs = options.idleMs ?? 5 * 60_000;
  }

  get binding(): string {
    return this.options.binding;
  }

  idFromName(name: string): string {
    return roomId(this.options.binding, name);
  }

  /** The room `id`, loaded from the store if it is not live. */
  host(id: string): Promise<RoomHost> {
    let host = this.hosts.get(id);
    if (!host) {
      host = this.load(id);
      this.hosts.set(id, host);
      host.catch(() => this.hosts.delete(id));
    }
    return host;
  }

  /** The room `id` if it is live here (a socket's ticket was issued by a live room). */
  live(id: string): Promise<RoomHost> | undefined {
    return this.hosts.get(id);
  }

  private async load(id: string): Promise<RoomHost> {
    const { binding, store, factory, env } = this.options;
    const host = new RoomHost(binding, id, store, factory, env, this);
    await host.storage.load();
    const alarm = store ? await store.get(alarmKey(binding, id)) : null;
    if (alarm) {
      const at = (JSON.parse(new TextDecoder().decode(alarm.bytes)) as { at: number }).at;
      host.storage.restoreAlarm(at);
      host.armAlarm(at);
    }
    return host;
  }

  drop(host: RoomHost, code: number, reason: string): void {
    host.stop(code, reason);
    void this.hosts.get(host.id)?.then((current) => {
      if (current === host) this.hosts.delete(host.id);
    });
  }

  recordAlarm(host: RoomHost, at: number | null): void {
    const { store, binding } = this.options;
    if (!store) return;
    const key = alarmKey(binding, host.id);
    const write = at === null ? store.delete(key) : store.put(key, new TextEncoder().encode(JSON.stringify({ at })), { contentType: 'application/json' });
    write.then(
      () => undefined,
      (error: unknown) => console.error(`[collab-rooms] ${binding} ${host.id}: recording the alarm failed:`, error),
    );
  }

  /** Wakes the rooms whose alarms are due within `soonMs` and that `owns` says live here. */
  async wake(owns: (id: string) => boolean, soonMs: number): Promise<void> {
    const { store, binding } = this.options;
    if (!store) return;
    const prefix = `collab-alarms/${binding}/`;
    for (const key of await store.list(prefix)) {
      const id = key.slice(prefix.length);
      if (this.hosts.has(id) || !owns(id)) continue;
      const object = await store.get(key);
      if (!object) continue;
      const { at } = JSON.parse(new TextDecoder().decode(object.bytes)) as { at: number };
      if (at - Date.now() <= soonMs) await this.host(id);
    }
  }

  /** Drops the idle rooms. */
  async sweep(): Promise<void> {
    for (const [id, pending] of this.hosts) {
      const host = await pending.catch(() => null);
      if (host && host.idle(this.idleMs, 2 * 60_000)) {
        host.stop(1001, 'Idle');
        this.hosts.delete(id);
      }
    }
  }

  /** Every live room (shutdown). */
  async all(): Promise<RoomHost[]> {
    const out: RoomHost[] = [];
    for (const pending of this.hosts.values()) {
      const host = await pending.catch(() => null);
      if (host) out.push(host);
    }
    return out;
  }
}

function alarmKey(binding: string, id: string): string {
  return `collab-alarms/${binding}/${id}`;
}
