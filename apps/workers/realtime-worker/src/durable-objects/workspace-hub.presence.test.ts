import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LivePresence } from '@weldsuite/realtime/presence';
import type { Env } from '../lib/protocol';
import { WorkspaceHub } from './workspace-hub';
import { OFFLINE_GRACE_MS, PRESENCE_SWEEP_INTERVAL_MS, STALE_CONNECTION_MS } from '../lib/presence';

/** Durable Object storage's key-value API, values copied in and out like the real one. */
class FakeStorage {
  readonly data = new Map<string, unknown>();
  alarm: number | null = null;

  async get<T>(key: string | string[]): Promise<T | undefined | Map<string, T>> {
    if (Array.isArray(key)) {
      const found = new Map<string, T>();
      for (const k of key) if (this.data.has(k)) found.set(k, structuredClone(this.data.get(k)) as T);
      return found;
    }
    return structuredClone(this.data.get(key)) as T | undefined;
  }

  async put(key: string, value: unknown): Promise<void> {
    this.data.set(key, structuredClone(value));
  }

  async delete(keys: string | string[]): Promise<boolean | number> {
    if (!Array.isArray(keys)) return this.data.delete(keys);
    return keys.filter((k) => this.data.delete(k)).length;
  }

  async list<T>(options: { prefix?: string; start?: string; limit?: number } = {}): Promise<Map<string, T>> {
    const keys = [...this.data.keys()]
      .filter((k) => k.startsWith(options.prefix ?? '') && (options.start === undefined || k >= options.start))
      .sort()
      .slice(0, options.limit);
    return new Map(keys.map((k) => [k, structuredClone(this.data.get(k)) as T]));
  }

  async getAlarm(): Promise<number | null> {
    return this.alarm;
  }

  async setAlarm(at: number): Promise<void> {
    this.alarm = at;
  }

  async deleteAlarm(): Promise<void> {
    this.alarm = null;
  }
}

class FakeSocket {
  readonly sent: string[] = [];
  closed: { code: number; reason: string } | null = null;
  private attachment: unknown = null;

  send(message: string): void {
    this.sent.push(message);
  }

  serializeAttachment(value: unknown): void {
    this.attachment = structuredClone(value);
  }

  deserializeAttachment(): unknown {
    return structuredClone(this.attachment);
  }

  close(code = 1000, reason = ''): void {
    // Like workerd: 1005 and 1006 describe a close, they cannot be sent.
    if (code === 1005 || code === 1006 || code === 1015) {
      throw new TypeError(`Invalid WebSocket close code: ${code}.`);
    }
    this.closed = { code, reason };
  }

  /** `presence` events this socket received, oldest first. */
  presenceEvents(): Array<{ event: string; data: unknown }> {
    return this.sent
      .map((raw) => JSON.parse(raw) as { type: string; topic?: string; event: string; data: unknown })
      .filter((m) => m.type === 'event' && m.topic === 'presence')
      .map(({ event, data }) => ({ event, data }));
  }

  asSocket(): WebSocket {
    return this as unknown as WebSocket;
  }
}

/** A WorkspaceHub's `ctx`: storage plus the hibernatable sockets it holds. */
function fakeHubState() {
  const storage = new FakeStorage();
  const sockets: Array<{ ws: FakeSocket; tags: string[] }> = [];
  const lastPing = new Map<FakeSocket, Date>();
  const ctx = {
    storage,
    setWebSocketAutoResponse: () => {},
    acceptWebSocket: (ws: FakeSocket, tags: string[]) => sockets.push({ ws, tags }),
    getWebSockets: (tag?: string) => sockets.filter((s) => !tag || s.tags.includes(tag)).map((s) => s.ws),
    getTags: (ws: FakeSocket) => sockets.find((s) => s.ws === ws)?.tags ?? [],
    getWebSocketAutoResponseTimestamp: (ws: FakeSocket) => lastPing.get(ws) ?? null,
  };
  return {
    ctx: ctx as unknown as DurableObjectState,
    storage,
    /** The runtime answered a heartbeat ping on this socket. */
    ping: (ws: FakeSocket) => lastPing.set(ws, new Date()),
    /** The close completed: the runtime stops listing the socket. */
    drop: (ws: FakeSocket) => sockets.splice(sockets.findIndex((s) => s.ws === ws), 1),
  };
}

interface HubInternals {
  acceptConnection(
    ws: WebSocket,
    identity: { userId: string; role: string; allowedTopics: string; workspaceId: string },
  ): Promise<void>;
}

const WORKSPACE = 'org_acme';
const T0 = Date.UTC(2026, 9, 27, 9, 0, 0);

describe('WorkspaceHub presence', () => {
  let state: ReturnType<typeof fakeHubState>;
  let hub: WorkspaceHub;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    vi.stubGlobal(
      'WebSocketRequestResponsePair',
      class {
        constructor(
          readonly request: string,
          readonly response: string,
        ) {}
      },
    );
    state = fakeHubState();
    hub = new WorkspaceHub(state.ctx, {} as Env);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  async function connect(userId: string, workspaceId = WORKSPACE): Promise<FakeSocket> {
    const ws = new FakeSocket();
    await (hub as unknown as HubInternals).acceptConnection(ws.asSocket(), {
      userId,
      role: 'member',
      allowedTopics: 'presence',
      workspaceId,
    });
    return ws;
  }

  /** A member who watches the presence topic. */
  async function watcher(userId = 'user_watcher'): Promise<FakeSocket> {
    const ws = await connect(userId);
    await hub.webSocketMessage(ws.asSocket(), JSON.stringify({ type: 'subscribe', topics: ['presence'] }));
    return ws;
  }

  async function clientCloses(ws: FakeSocket, code: number): Promise<void> {
    await hub.webSocketClose(ws.asSocket(), code, '', false);
    state.drop(ws);
  }

  async function runAlarmAt(at: number): Promise<void> {
    vi.setSystemTime(at);
    await hub.alarm();
  }

  async function presenceOf(...userIds: string[]): Promise<Record<string, LivePresence>> {
    const url = new URL('https://internal/presence');
    for (const id of userIds) url.searchParams.append('userId', id);
    const res = await hub.fetch(new Request(url));
    return ((await res.json()) as { users: Record<string, LivePresence> }).users;
  }

  it('sends a snapshot of everyone connected to a new presence subscriber', async () => {
    await connect('user_ann');
    const w = await watcher();

    expect(w.presenceEvents()).toContainEqual({
      event: 'snapshot',
      data: { users: { user_ann: 'online', user_watcher: 'online' } },
    });
  });

  it('announces a member when their first connection opens', async () => {
    const w = await watcher();
    await connect('user_ann');

    expect(w.presenceEvents().at(-1)).toEqual({
      event: 'connection_changed',
      data: { userId: 'user_ann', live: 'online' },
    });
  });

  it('marks a member offline after the grace period when the connection is lost without a close code', async () => {
    const w = await watcher();
    const ann = await connect('user_ann');

    // 1006: the laptop slept or the network dropped. This used to throw inside
    // the handler and leave the member online for good.
    await expect(clientCloses(ann, 1006)).resolves.toBeUndefined();
    expect(ann.closed).toEqual({ code: 1000, reason: '' });
    expect(await presenceOf('user_ann')).toEqual({ user_ann: 'online' }); // still in grace

    await runAlarmAt(T0 + OFFLINE_GRACE_MS);

    expect(w.presenceEvents().at(-1)).toEqual({
      event: 'connection_changed',
      data: { userId: 'user_ann', live: null },
    });
    expect(await presenceOf('user_ann')).toEqual({});
  });

  it('does not flicker offline when a member reloads within the grace period', async () => {
    const w = await watcher();
    const ann = await connect('user_ann');
    const before = w.presenceEvents().length;

    await clientCloses(ann, 1001);
    vi.setSystemTime(T0 + 1_000);
    await connect('user_ann');
    await runAlarmAt(T0 + OFFLINE_GRACE_MS);

    expect(w.presenceEvents()).toHaveLength(before);
    expect(await presenceOf('user_ann')).toEqual({ user_ann: 'online' });
  });

  it('keeps a member online while any connection is active, and away once all are idle', async () => {
    const w = await watcher();
    const laptop = await connect('user_ann');
    const phone = await connect('user_ann');
    const idle = JSON.stringify({ type: 'presence', idle: true, inCall: false });
    const active = JSON.stringify({ type: 'presence', idle: false, inCall: false });

    await hub.webSocketMessage(laptop.asSocket(), idle);
    expect(await presenceOf('user_ann')).toEqual({ user_ann: 'online' });

    await hub.webSocketMessage(phone.asSocket(), idle);
    expect(await presenceOf('user_ann')).toEqual({ user_ann: 'away' });

    await hub.webSocketMessage(phone.asSocket(), active);
    expect(await presenceOf('user_ann')).toEqual({ user_ann: 'online' });

    const changes = w
      .presenceEvents()
      .filter((e) => e.event === 'connection_changed' && (e.data as { userId: string }).userId === 'user_ann')
      .map((e) => (e.data as { live: string }).live);
    expect(changes).toEqual(['online', 'away', 'online']);
  });

  it('shows a member in a call as busy until the call ends', async () => {
    const ann = await connect('user_ann');

    await hub.webSocketMessage(ann.asSocket(), JSON.stringify({ type: 'presence', idle: false, inCall: true }));
    expect(await presenceOf('user_ann')).toEqual({ user_ann: 'busy' });

    await hub.webSocketMessage(ann.asSocket(), JSON.stringify({ type: 'presence', idle: false, inCall: false }));
    expect(await presenceOf('user_ann')).toEqual({ user_ann: 'online' });
  });

  it('closes a connection that stopped pinging and then marks its member offline', async () => {
    const w = await watcher();
    const ann = await connect('user_ann');

    // The watcher keeps pinging; Ann's laptop went to sleep without a close frame.
    const sweepAt = T0 + STALE_CONNECTION_MS + PRESENCE_SWEEP_INTERVAL_MS;
    for (let at = T0 + PRESENCE_SWEEP_INTERVAL_MS; at <= sweepAt; at += PRESENCE_SWEEP_INTERVAL_MS) {
      vi.setSystemTime(at - 5_000);
      state.ping(w);
      await runAlarmAt(at);
      if (at < sweepAt) expect(ann.closed).toBeNull();
    }
    expect(ann.closed).toEqual({ code: 4000, reason: 'heartbeat timeout' });
    expect(w.closed).toBeNull();

    await runAlarmAt(sweepAt + OFFLINE_GRACE_MS);
    expect(await presenceOf()).toEqual({ user_watcher: 'online' });
    expect(w.presenceEvents().at(-1)).toEqual({
      event: 'connection_changed',
      data: { userId: 'user_ann', live: null },
    });
  });

  it('keeps no presence on a personal hub', async () => {
    const ws = await connect('user_ann', 'personal:user_ann');
    await hub.webSocketMessage(ws.asSocket(), JSON.stringify({ type: 'subscribe', topics: ['presence'] }));

    expect(ws.presenceEvents()).toEqual([]);
    expect(await presenceOf()).toEqual({});
    expect(state.storage.alarm).toBeNull();
  });
});
