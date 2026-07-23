import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../lib/protocol';
import { AUTH_HEADERS } from '../lib/protocol';
import { canSubscribe, isPersonalTopicForOtherUser } from '../lib/permissions';
import { topicMatches } from '@weldsuite/realtime/topics';
import { getTenantDbForWorkspace, setUserOffline, setUserOnlineIfOffline } from '../lib/db';

/**
 * WorkspaceHub Durable Object
 *
 * One instance per workspace. Manages WebSocket connections for
 * workspace-wide events (entity CRUD, notifications, mail, inbox).
 *
 * Uses the WebSocket Hibernation API — the DO sleeps when idle
 * and wakes only when messages arrive or connections open/close.
 *
 * Presence offline detection uses Durable Object **alarms** rather than
 * setTimeout so the grace period survives DO hibernation (which happens
 * almost always when the last WS closes — exactly the case we care about).
 *
 * Storage layout:
 *   workspaceId                — the Clerk org ID this DO represents
 *   pendingOffline:<userId>    — epoch-ms timestamp at which this user
 *                                should be broadcast offline if they have
 *                                not reconnected by then
 */

/** Grace period after the last WS closes before we broadcast offline. */
const OFFLINE_GRACE_MS = 5_000;

/** Storage key prefix for per-user pending offline timers. */
const PENDING_OFFLINE_PREFIX = 'pendingOffline:';

/**
 * Storage key prefix for users that the DO itself transitioned to `offline`
 * via the grace-period alarm. Set in `alarm()` right before
 * `persistOfflineToDb`, cleared on the next `handleWebSocketUpgrade`. When
 * present on reconnect, the DO repairs the DB back to `online` so the row
 * doesn't stay stale until the user happens to touch the API again.
 */
const DO_MARKED_OFFLINE_PREFIX = 'doMarkedOffline:';

/** Storage key prefix for per-connection topic subscriptions. */
const SUBS_PREFIX = 'subs:';

/**
 * Storage key prefix for the per-connection allowed-topic list (the topics
 * the user's role grants them subscribe permission for). Stored in DO
 * storage rather than a WebSocket tag because the joined list easily blows
 * past the 256-character per-tag limit imposed by the Hibernation API.
 */
const ALLOWED_PREFIX = 'allowed:';

/**
 * Per-event log entries: `eventLog:<16-digit-zero-padded-id>` → serialized
 * EventLogEntry. Keys sort lexically so list ranges are monotonic.
 */
const EVENT_LOG_PREFIX = 'eventLog:';

/** Monotonic counter for minting event ids. */
const EVENT_LOG_COUNTER_KEY = 'eventLogCounter';

/** Retain replayable events for 6h. Older cursors trigger resync_required. */
const EVENT_LOG_TTL_MS = 6 * 60 * 60 * 1000;

/** Sweep stale events once per hour. */
const EVENT_LOG_PRUNE_INTERVAL_MS = 60 * 60 * 1000;

/** Storage key for the next scheduled prune. */
const NEXT_PRUNE_AT_KEY = 'eventLogNextPruneAt';

type EventLogEntry = {
  eventId: string;
  topic: string;
  event: string;
  data: unknown;
  ts: number;
  userId: string;
  accessUserIds?: string[];
};

function formatEventId(n: number): string {
  return n.toString().padStart(16, '0');
}

export class WorkspaceHub extends DurableObject<Env> {
  /**
   * In-memory cache of topic subscriptions per WebSocket, keyed by
   * connectionId tag. Authoritative copy lives in `ctx.storage` under
   * `subs:<connId>` so subscriptions survive DO hibernation — the
   * Hibernation API keeps WebSockets alive but wipes the DO's JS state,
   * so an in-memory-only Map silently empties on every wake and publishes
   * stop reaching subscribers.
   */
  private subscriptions = new Map<string, Set<string>>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Reply to client heartbeat pings inside the runtime WITHOUT waking the DO
    // from hibernation. The client sends `{"type":"ping"}` on a timer to keep
    // the connection alive through edge/proxy idle timeouts (~60s).
    ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair('{"type":"ping"}', '{"type":"pong"}'),
    );
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.headers.get('Upgrade') === 'websocket') {
      return this.handleWebSocketUpgrade(request);
    }

    if (url.pathname === '/publish' && request.method === 'POST') {
      return this.handlePublish(request);
    }

    return new Response('Not found', { status: 404 });
  }

  // ---- WebSocket Hibernation API handlers ----

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const raw = typeof message === 'string' ? message : new TextDecoder().decode(message);

    let msg: { type: string; topics?: string[]; [key: string]: unknown };
    try {
      msg = JSON.parse(raw);
    } catch {
      ws.send(JSON.stringify({ type: 'error', code: 'invalid_json', message: 'Invalid JSON' }));
      return;
    }

    const tags = this.ctx.getTags(ws);
    const connId = this.getTag(tags, 'conn:');

    switch (msg.type) {
      case 'subscribe': {
        if (!Array.isArray(msg.topics)) break;
        const allowedTopics = await this.getAllowedTopics(connId, tags);
        const authUserId = this.getTag(tags, 'user:');
        const accepted: string[] = [];
        const subs = await this.loadSubs(connId);

        for (const topic of msg.topics) {
          if (typeof topic !== 'string') continue;
          // Personal-topic isolation: enforced for EVERY role (including
          // owner/admin whose allow list is `*`). Blocks a hand-crafted
          // `notification.<other-user-id>` subscribe regardless of the
          // role-derived allow list.
          if (isPersonalTopicForOtherUser(authUserId, topic)) {
            ws.send(
              JSON.stringify({
                type: 'error',
                code: 'forbidden',
                message: `Cannot subscribe to another user's personal topic: ${topic}`,
              }),
            );
            continue;
          }
          if (canSubscribe(allowedTopics, topic)) {
            subs.add(topic);
            accepted.push(topic);
          } else {
            ws.send(
              JSON.stringify({
                type: 'error',
                code: 'forbidden',
                message: `Cannot subscribe to topic: ${topic}`,
              }),
            );
          }
        }

        await this.saveSubs(connId, subs);

        // Replay missed events when the client supplied a `since` cursor.
        // Must happen BEFORE the `subscribed` ack so the client's local cache
        // sees the catch-up before any live tail message.
        const sinceRaw = msg.since;
        const wsUserId = this.getTag(tags, 'user:');
        if (typeof sinceRaw === 'string' && sinceRaw.length > 0 && accepted.length > 0) {
          const replay = await this.replaySince(sinceRaw, accepted, wsUserId);
          if (replay.kind === 'resync_required') {
            ws.send(JSON.stringify({ type: 'resync_required', topics: accepted }));
          } else {
            for (const entry of replay.events) {
              ws.send(
                JSON.stringify({
                  type: 'event',
                  topic: entry.topic,
                  event: entry.event,
                  data: entry.data,
                  ts: entry.ts,
                  userId: entry.userId,
                  eventId: entry.eventId,
                }),
              );
            }
          }
        }

        if (accepted.length > 0) {
          ws.send(JSON.stringify({ type: 'subscribed', topics: accepted }));
        }
        break;
      }

      case 'unsubscribe': {
        if (!Array.isArray(msg.topics)) break;
        const subs = await this.loadSubs(connId);
        for (const topic of msg.topics) {
          subs.delete(topic);
        }
        await this.saveSubs(connId, subs);
        ws.send(JSON.stringify({ type: 'unsubscribed', topics: msg.topics }));
        break;
      }

      case 'ping':
        ws.send('{"type":"pong"}');
        break;

      default:
        ws.send(
          JSON.stringify({
            type: 'error',
            code: 'unknown_type',
            message: `Unknown message type: ${msg.type}`,
          }),
        );
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string, _wasClean: boolean): Promise<void> {
    const tags = this.ctx.getTags(ws);
    const connId = this.getTag(tags, 'conn:');
    const userId = this.getTag(tags, 'user:');
    await this.deleteSubs(connId);
    ws.close(code, reason);

    if (userId) {
      await this.startOfflineGracePeriod(userId, ws);
    }
  }

  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    console.error('[WorkspaceHub] WebSocket error:', error);
    const tags = this.ctx.getTags(ws);
    const connId = this.getTag(tags, 'conn:');
    const userId = this.getTag(tags, 'user:');
    await this.deleteSubs(connId);
    ws.close(1011, 'Internal error');

    if (userId) {
      await this.startOfflineGracePeriod(userId, ws);
    }
  }

  // ---- Internal ----

  private async handleWebSocketUpgrade(request: Request): Promise<Response> {
    const userId = request.headers.get(AUTH_HEADERS.USER_ID) || 'unknown';
    const role = request.headers.get(AUTH_HEADERS.ROLE) || 'member';
    const allowedTopics = request.headers.get(AUTH_HEADERS.SUBSCRIBE_TOPICS) || '';
    const workspaceId = request.headers.get(AUTH_HEADERS.WORKSPACE_ID) || '';
    const connId = crypto.randomUUID();

    // Persist workspaceId once so the alarm handler knows which workspace
    // to broadcast on behalf of after hibernation.
    if (workspaceId) {
      const stored = await this.ctx.storage.get<string>('workspaceId');
      if (!stored) {
        await this.ctx.storage.put('workspaceId', workspaceId);
      }
    }

    // User reconnected — cancel any pending offline for this user and
    // recompute the earliest alarm time.
    await this.ctx.storage.delete(`${PENDING_OFFLINE_PREFIX}${userId}`);
    await this.rescheduleAlarm();

    // If the DO previously persisted this user offline (grace expired while
    // they were disconnected), repair the DB back to online and broadcast.
    // Without this, `chat_user_status` stays stale until the user manually
    // touches the API.
    const doOfflineKey = `${DO_MARKED_OFFLINE_PREFIX}${userId}`;
    const wasMarkedOffline = await this.ctx.storage.get<number>(doOfflineKey);
    if (wasMarkedOffline) {
      await this.ctx.storage.delete(doOfflineKey);
      if (workspaceId && userId !== 'unknown') {
        // Don't await — the upgrade response must not block on tenant DB
        // resolution + write. Fire-and-forget with an internal log on error.
        this.ctx.waitUntil(this.repairOnlineInDb(workspaceId, userId));
      }
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    // Tags are immutable and capped at 256 chars each. Keep them short
    // (identity only). The allowed-topic list — which easily exceeds
    // 256 chars once personal topics are included — lives in DO storage
    // under `allowed:<connId>`.
    this.ctx.acceptWebSocket(server, [
      `conn:${connId}`,
      `user:${userId}`,
      `role:${role}`,
    ]);

    await this.ctx.storage.put(`${ALLOWED_PREFIX}${connId}`, allowedTopics);

    // Initialize empty subscription set
    this.subscriptions.set(connId, new Set());

    server.send(JSON.stringify({ type: 'connected', connectionId: connId }));

    return new Response(null, { status: 101, webSocket: client });
  }

  private async handlePublish(request: Request): Promise<Response> {
    const { topic, event, data, userId } = (await request.json()) as {
      topic: string;
      event: string;
      data: unknown;
      userId: string;
    };

    // Extract access control from data (if present)
    const accessUserIds = (data as any)?._access?.userIds as string[] | undefined;

    // Strip _access from data before sending to clients
    let clientData = data;
    if ((data as any)?._access) {
      const { _access, ...rest } = data as any;
      clientData = rest;
    }

    const ts = Date.now();
    const eventId = await this.appendEventLog({
      topic,
      event,
      data: clientData,
      ts,
      userId,
      accessUserIds,
    });

    const message = JSON.stringify({
      type: 'event',
      topic,
      event,
      data: clientData,
      ts,
      userId,
      eventId,
    });

    // Broadcast to matching subscribers, filtered by access.
    // We load subscriptions from storage on miss because the DO may have
    // hibernated since the last subscribe message — the in-memory Map is
    // wiped by hibernation but the underlying WebSocket and its `subs:*`
    // storage entry survive.
    for (const ws of this.ctx.getWebSockets()) {
      const tags = this.ctx.getTags(ws);
      const connId = this.getTag(tags, 'conn:');
      const subs = await this.loadSubs(connId);
      if (subs.size === 0 || !this.matchesAnySubscription(subs, topic)) continue;

      // If access control is set, only send to allowed users
      if (accessUserIds) {
        const wsUserId = this.getTag(tags, 'user:');
        if (!accessUserIds.includes(wsUserId)) continue;
      }

      try {
        ws.send(message);
      } catch {
        // WebSocket may have closed
      }
    }

    return new Response('ok');
  }

  /**
   * Get subscriptions for a connection, populating the in-memory cache from
   * storage if missing. Returns an empty Set if the connection has never
   * subscribed.
   */
  private async loadSubs(connId: string): Promise<Set<string>> {
    const cached = this.subscriptions.get(connId);
    if (cached) return cached;
    const stored = await this.ctx.storage.get<string[]>(`${SUBS_PREFIX}${connId}`);
    const subs = new Set<string>(stored ?? []);
    this.subscriptions.set(connId, subs);
    return subs;
  }

  private async saveSubs(connId: string, subs: Set<string>): Promise<void> {
    this.subscriptions.set(connId, subs);
    if (subs.size === 0) {
      await this.ctx.storage.delete(`${SUBS_PREFIX}${connId}`);
    } else {
      await this.ctx.storage.put(`${SUBS_PREFIX}${connId}`, Array.from(subs));
    }
  }

  private async deleteSubs(connId: string): Promise<void> {
    this.subscriptions.delete(connId);
    await this.ctx.storage.delete(`${SUBS_PREFIX}${connId}`);
    await this.ctx.storage.delete(`${ALLOWED_PREFIX}${connId}`);
  }

  private matchesAnySubscription(subscriptions: Set<string>, eventTopic: string): boolean {
    for (const sub of subscriptions) {
      if (topicMatches(sub, eventTopic)) return true;
    }
    return false;
  }

  // ---- Event log (replay-on-reconnect) ----

  /**
   * Persist an event under a monotonic key and return the minted id.
   * Also schedules the next prune sweep via the existing alarm subsystem.
   */
  private async appendEventLog(input: {
    topic: string;
    event: string;
    data: unknown;
    ts: number;
    userId: string;
    accessUserIds?: string[];
  }): Promise<string> {
    const counter = (await this.ctx.storage.get<number>(EVENT_LOG_COUNTER_KEY)) ?? 0;
    const next = counter + 1;
    const eventId = formatEventId(next);
    const entry: EventLogEntry = {
      eventId,
      topic: input.topic,
      event: input.event,
      data: input.data,
      ts: input.ts,
      userId: input.userId,
      accessUserIds: input.accessUserIds,
    };
    await this.ctx.storage.put(EVENT_LOG_COUNTER_KEY, next);
    await this.ctx.storage.put(`${EVENT_LOG_PREFIX}${eventId}`, entry);
    await this.ensurePruneScheduled(input.ts);
    return eventId;
  }

  /**
   * Replay events whose id is strictly greater than `since`, filtered to the
   * subscribed topics. Returns `resync_required` if the cursor is older than
   * the oldest retained event (client must do a full refetch).
   */
  private async replaySince(
    since: string,
    topics: string[],
    wsUserId: string,
  ): Promise<{ kind: 'events'; events: EventLogEntry[] } | { kind: 'resync_required' }> {
    const startKey = `${EVENT_LOG_PREFIX}${since}`;
    const all = await this.ctx.storage.list<EventLogEntry>({
      prefix: EVENT_LOG_PREFIX,
      start: startKey,
    });

    if (all.size === 0) {
      // No retained events at all (empty log or all pruned) — if the cursor
      // is non-empty, the client should resync because we cannot prove we
      // captured everything since.
      const counter = (await this.ctx.storage.get<number>(EVENT_LOG_COUNTER_KEY)) ?? 0;
      const cursorNum = Number.parseInt(since, 10);
      if (Number.isFinite(cursorNum) && cursorNum >= counter) {
        // Cursor is up-to-date — nothing to replay, no resync needed.
        return { kind: 'events', events: [] };
      }
      return { kind: 'resync_required' };
    }

    // Check the floor: is `since` older than what we still retain?
    const firstKey = all.keys().next().value as string | undefined;
    const firstId = firstKey ? firstKey.slice(EVENT_LOG_PREFIX.length) : '';
    if (firstId > since && firstId !== formatEventId(Number.parseInt(since, 10) + 1)) {
      // The earliest retained event is more than one step past `since`,
      // meaning we evicted at least one event the client never saw.
      return { kind: 'resync_required' };
    }

    const events: EventLogEntry[] = [];
    for (const [key, entry] of all.entries()) {
      // `list` with `start` is inclusive — skip the cursor itself.
      if (key === startKey) continue;
      if (!topics.some((t) => topicMatches(t, entry.topic))) continue;
      if (entry.accessUserIds && !entry.accessUserIds.includes(wsUserId)) continue;
      events.push(entry);
    }

    return { kind: 'events', events };
  }

  /**
   * Ensure the periodic prune alarm is scheduled. Piggy-backs on the existing
   * alarm subsystem; `alarm()` runs prune when due, then reschedules.
   */
  private async ensurePruneScheduled(now: number): Promise<void> {
    const existing = await this.ctx.storage.get<number>(NEXT_PRUNE_AT_KEY);
    if (existing && existing > now) return;
    const next = now + EVENT_LOG_PRUNE_INTERVAL_MS;
    await this.ctx.storage.put(NEXT_PRUNE_AT_KEY, next);
    await this.rescheduleAlarm();
  }

  /**
   * Drop event log entries older than the TTL. Cheap because keys are sorted
   * lexically and we scan strictly forward until the first non-stale entry.
   */
  private async pruneEventLog(now: number): Promise<void> {
    const cutoffTs = now - EVENT_LOG_TTL_MS;
    const all = await this.ctx.storage.list<EventLogEntry>({ prefix: EVENT_LOG_PREFIX });
    const toDelete: string[] = [];
    for (const [key, entry] of all.entries()) {
      if (entry.ts <= cutoffTs) {
        toDelete.push(key);
      } else {
        break; // entries are insertion-ordered ≈ time-ordered
      }
    }
    if (toDelete.length > 0) {
      await this.ctx.storage.delete(toDelete);
    }
  }

  private async getAllowedTopics(connId: string, tags: readonly string[]): Promise<string[]> {
    // Primary source: DO storage (post-hibernation safe; not subject to the
    // 256-char per-tag cap).
    const stored = await this.ctx.storage.get<string>(`${ALLOWED_PREFIX}${connId}`);
    if (typeof stored === 'string') {
      if (stored === '*') return ['*'];
      return stored.split(',').filter(Boolean);
    }

    // Backward-compat for sockets that were upgraded under the old code,
    // where the allowed list lived in a tag. Safe to remove once all such
    // connections have churned (next deploy + DO eviction).
    for (const tag of tags) {
      if (tag.startsWith('allowed:')) {
        const val = tag.slice('allowed:'.length);
        if (val === '*') return ['*'];
        return val.split(',').filter(Boolean);
      }
    }
    return [];
  }

  private getTag(tags: readonly string[], prefix: string): string {
    for (const tag of tags) {
      if (tag.startsWith(prefix)) return tag.slice(prefix.length);
    }
    return '';
  }

  // ---- Presence Grace Period (via DO Alarms) ----

  /**
   * Start a grace period after a user's last WebSocket disconnects.
   *
   * Uses DO storage + alarms (survives hibernation). setTimeout would not
   * survive the DO hibernating after the last WS closes, which is the
   * exact situation we need to handle.
   *
   * `closingWs` is the WebSocket that just closed (when invoked from the
   * `webSocketClose`/`webSocketError` handlers). It is filtered out of the
   * `getWebSockets()` scan because the runtime may still return it during
   * the close handler, which would cause `hasOther` to spuriously be true
   * for a single-tab user and the grace period would never be scheduled —
   * leaving `chat_user_status` stuck on `online`.
   */
  private async startOfflineGracePeriod(userId: string, closingWs?: WebSocket): Promise<void> {
    // Check if user still has other open connections, excluding the one
    // that just closed (if provided).
    const hasOther = this.ctx.getWebSockets().some((ws) => {
      if (closingWs && ws === closingWs) return false;
      const tags = this.ctx.getTags(ws);
      return this.getTag(tags, 'user:') === userId;
    });
    if (hasOther) return; // Other tabs still open

    const key = `${PENDING_OFFLINE_PREFIX}${userId}`;
    const existing = await this.ctx.storage.get<number>(key);
    const fireAt = Date.now() + OFFLINE_GRACE_MS;

    // Don't extend a pending timer — keep the earliest fire time
    if (existing && existing <= fireAt) return;

    await this.ctx.storage.put(key, fireAt);
    await this.rescheduleAlarm();
  }

  /**
   * Compute the earliest fire time across both presence offline timers and
   * the event-log prune sweep, and set the DO alarm accordingly. If neither
   * has work pending, clears the alarm.
   */
  private async rescheduleAlarm(): Promise<void> {
    const pending = await this.ctx.storage.list<number>({ prefix: PENDING_OFFLINE_PREFIX });

    let earliest: number | null = null;
    for (const fireAt of pending.values()) {
      if (earliest === null || fireAt < earliest) earliest = fireAt;
    }

    const nextPrune = await this.ctx.storage.get<number>(NEXT_PRUNE_AT_KEY);
    if (nextPrune && (earliest === null || nextPrune < earliest)) {
      earliest = nextPrune;
    }

    const currentAlarm = await this.ctx.storage.getAlarm();
    if (earliest === null) {
      if (currentAlarm !== null) await this.ctx.storage.deleteAlarm();
      return;
    }

    if (currentAlarm === null || currentAlarm !== earliest) {
      await this.ctx.storage.setAlarm(earliest);
    }
  }

  /**
   * Alarm handler — runs after DO hibernation via Cloudflare's alarm
   * subsystem. Processes all due `pendingOffline:*` entries, broadcasts
   * offline, persists to the tenant DB via api-worker, and reschedules.
   */
  async alarm(): Promise<void> {
    const now = Date.now();

    // 1) Event-log prune sweep — drops entries older than EVENT_LOG_TTL_MS.
    const nextPrune = await this.ctx.storage.get<number>(NEXT_PRUNE_AT_KEY);
    if (nextPrune && nextPrune <= now) {
      await this.pruneEventLog(now);
      // Only re-arm the prune if there are still events to age out, so an
      // idle workspace's DO can fully hibernate.
      const remaining = await this.ctx.storage.list<EventLogEntry>({
        prefix: EVENT_LOG_PREFIX,
        limit: 1,
      });
      if (remaining.size > 0) {
        await this.ctx.storage.put(NEXT_PRUNE_AT_KEY, now + EVENT_LOG_PRUNE_INTERVAL_MS);
      } else {
        await this.ctx.storage.delete(NEXT_PRUNE_AT_KEY);
      }
    }

    // 2) Presence offline broadcasts.
    const pending = await this.ctx.storage.list<number>({ prefix: PENDING_OFFLINE_PREFIX });

    const dueUserIds: string[] = [];
    for (const [key, fireAt] of pending.entries()) {
      if (fireAt <= now) {
        dueUserIds.push(key.slice(PENDING_OFFLINE_PREFIX.length));
      }
    }

    if (dueUserIds.length === 0) {
      await this.rescheduleAlarm();
      return;
    }

    const workspaceId = await this.ctx.storage.get<string>('workspaceId');

    for (const userId of dueUserIds) {
      // One final sanity check — if the user has reconnected in the
      // interim, skip (the reconnect path should have deleted the key,
      // but belt-and-suspenders for race conditions).
      const hasOther = this.ctx.getWebSockets().some((ws) => {
        const tags = this.ctx.getTags(ws);
        return this.getTag(tags, 'user:') === userId;
      });

      await this.ctx.storage.delete(`${PENDING_OFFLINE_PREFIX}${userId}`);
      if (hasOther) continue;

      await this.broadcastOffline(userId);

      // Persist to the tenant DB. Without this, any client doing a fresh
      // GET /chat/status after the broadcast would see stale "online"
      // and the ghost user would reappear on next page load.
      if (workspaceId) {
        // Record that this DO transitioned the user to offline so a future
        // reconnect can repair the DB back to online. Set BEFORE the DB
        // write so a reconnect that races with the write still has the
        // signal to repair.
        await this.ctx.storage.put(`${DO_MARKED_OFFLINE_PREFIX}${userId}`, now);
        await this.persistOfflineToDb(workspaceId, userId);
      }
    }

    await this.rescheduleAlarm();
  }

  /** Broadcast `presence / status_changed offline` to subscribed WebSockets. */
  private async broadcastOffline(userId: string): Promise<void> {
    const message = JSON.stringify({
      type: 'event',
      topic: 'presence',
      event: 'status_changed',
      data: { userId, status: 'offline' },
      ts: Date.now(),
      userId,
    });

    for (const ws of this.ctx.getWebSockets()) {
      const tags = this.ctx.getTags(ws);
      const connId = this.getTag(tags, 'conn:');
      // Load from storage on miss — alarm-driven wakes have an empty in-memory
      // map even though the underlying WebSocket and its `subs:*` survive.
      const subs = await this.loadSubs(connId);
      if (subs.size === 0) continue;
      for (const sub of subs) {
        if (sub === 'presence' || topicMatches(sub, 'presence')) {
          try {
            ws.send(message);
          } catch {
            // WebSocket may have closed
          }
          break;
        }
      }
    }
  }

  private async persistOfflineToDb(workspaceId: string, userId: string): Promise<void> {
    try {
      const db = await getTenantDbForWorkspace(this.env, workspaceId);
      await setUserOffline(db, userId);
    } catch (err) {
      console.error('[WorkspaceHub] persistOfflineToDb failed:', err);
    }
  }

  /**
   * Repair `chat_user_status` to online after a reconnect that follows a
   * DO-induced offline transition. Only writes if the row is currently
   * `offline`; preserves user-set custom statuses untouched. Broadcasts
   * a `status_changed online` so any subscribed clients update too.
   */
  private async repairOnlineInDb(workspaceId: string, userId: string): Promise<void> {
    try {
      const db = await getTenantDbForWorkspace(this.env, workspaceId);
      const updated = await setUserOnlineIfOffline(db, userId);
      if (updated) {
        this.broadcastStatusChange(userId, 'online');
      }
    } catch (err) {
      console.error('[WorkspaceHub] repairOnlineInDb failed:', err);
    }
  }

  /**
   * Broadcast a `presence/status_changed` event to subscribed WebSockets.
   * Shared with `broadcastOffline`; pulls subscription state from storage
   * so it works after an alarm-driven wake.
   */
  private async broadcastStatusChange(userId: string, status: string): Promise<void> {
    const message = JSON.stringify({
      type: 'event',
      topic: 'presence',
      event: 'status_changed',
      data: { userId, status },
      ts: Date.now(),
      userId,
    });

    for (const ws of this.ctx.getWebSockets()) {
      const tags = this.ctx.getTags(ws);
      const connId = this.getTag(tags, 'conn:');
      const subs = await this.loadSubs(connId);
      if (subs.size === 0) continue;
      for (const sub of subs) {
        if (sub === 'presence' || topicMatches(sub, 'presence')) {
          try {
            ws.send(message);
          } catch {
            // WebSocket may have closed
          }
          break;
        }
      }
    }
  }
}
