import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../lib/protocol';
import { AUTH_HEADERS } from '../lib/protocol';
import { canSubscribe, isPersonalTopicForOtherUser } from '../lib/permissions';
import { topicMatches, isMemberlessHubKey } from '@weldsuite/realtime/topics';
import {
  aggregateConnections,
  PRESENCE_EVENTS,
  PRESENCE_TOPIC,
  type LivePresence,
  type PresenceConnectionChange,
  type PresenceSnapshot,
} from '@weldsuite/realtime/presence';
import { reciprocateClose } from '../lib/close';
import {
  OFFLINE_GRACE_MS,
  PRESENCE_SWEEP_INTERVAL_MS,
  isConnectionStale,
  lastHeardFrom,
  newConnectionState,
  type ConnectionState,
} from '../lib/presence';

/**
 * WorkspaceHub Durable Object
 *
 * One instance per workspace. Manages WebSocket connections for
 * workspace-wide events (entity CRUD, notifications, mail, inbox).
 *
 * Uses the WebSocket Hibernation API — the DO sleeps when idle
 * and wakes only when messages arrive or connections open/close.
 *
 * It is also the source of truth for **live presence**: who has a connection
 * open, and whether they are idle or in a call (see
 * `@weldsuite/realtime/presence`). Nothing about it is written to Postgres.
 * Members get a snapshot when they subscribe to `presence` and
 * `connection_changed` events after that; workers ask `GET /presence`.
 * Timers use Durable Object **alarms** rather than setTimeout so they survive
 * hibernation, which almost always follows the last socket closing.
 *
 * Storage layout:
 *   workspaceId                — the Clerk org ID this DO represents
 *   presence:<userId>          — the member's last broadcast live presence
 *   pendingOffline:<userId>    — epoch-ms at which the member goes offline
 *                                unless a connection of theirs opens first
 *   presenceNextSweepAt        — when to look for dead connections next
 */

/** Storage key prefix for the last broadcast live presence per member. */
const PRESENCE_PREFIX = 'presence:';

/** Storage key prefix for per-user pending offline timers. */
const PENDING_OFFLINE_PREFIX = 'pendingOffline:';

/** Storage key for the next dead-connection sweep. */
const NEXT_SWEEP_AT_KEY = 'presenceNextSweepAt';

/** Close code for a connection the sweep found silent (app-defined range). */
const STALE_CLOSE_CODE = 4000;

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

/** A socket's presence state. Sockets accepted before attachments existed count as active. */
function connectionState(ws: WebSocket): ConnectionState {
  const stored = ws.deserializeAttachment() as ConnectionState | null;
  return stored ?? newConnectionState(0);
}

function saveConnectionState(ws: WebSocket, state: ConnectionState): void {
  try {
    ws.serializeAttachment(state);
  } catch {
    // The socket is already gone; its state no longer matters.
  }
}

/**
 * Flag a closing socket so presence ignores it: the runtime may keep listing
 * a socket in `getWebSockets()` until its close completes.
 */
function markGone(ws: WebSocket): void {
  saveConnectionState(ws, { ...connectionState(ws), gone: true });
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
  private readonly subscriptions = new Map<string, Set<string>>();

  /** The workspace (Clerk org id or memberless hub key), cached from storage. */
  private hubKey: string | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Reply to client heartbeat pings inside the runtime WITHOUT waking the DO
    // from hibernation. The client sends `{"type":"ping"}` on a timer to keep
    // the connection alive through edge/proxy idle timeouts (~60s). The runtime
    // records when it last answered each socket, which is how the presence
    // sweep tells a live connection from a dead one.
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

    if (url.pathname === '/presence' && request.method === 'GET') {
      const userIds = url.searchParams.getAll('userId');
      const only = userIds.length > 0 ? new Set(userIds) : undefined;
      const users = (await this.tracksPresence()) ? await this.livePresence(only) : {};
      return Response.json({ users } satisfies PresenceSnapshot);
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
    const state = { ...connectionState(ws), lastSeen: Date.now() };

    switch (msg.type) {
      case 'subscribe':
        saveConnectionState(ws, state);
        await this.handleSubscribe(ws, msg, connId, tags);
        break;

      case 'unsubscribe':
        saveConnectionState(ws, state);
        await this.handleUnsubscribe(ws, msg, connId);
        break;

      case 'presence':
        saveConnectionState(ws, { ...state, idle: msg.idle === true, inCall: msg.inCall === true });
        await this.refreshPresence(this.getTag(tags, 'user:'));
        break;

      case 'ping':
        saveConnectionState(ws, state);
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

  /** Send a `forbidden` error frame for a rejected subscribe topic. */
  private sendForbidden(ws: WebSocket, message: string): void {
    ws.send(JSON.stringify({ type: 'error', code: 'forbidden', message }));
  }

  /**
   * Filter the requested topics down to the ones this connection may
   * subscribe to, adding them to `subs` and sending a `forbidden` error for
   * each rejected topic. Returns the accepted topics.
   */
  private acceptTopics(
    ws: WebSocket,
    topics: unknown[],
    subs: Set<string>,
    allowedTopics: string[],
    authUserId: string,
  ): string[] {
    const accepted: string[] = [];
    for (const topic of topics) {
      if (typeof topic !== 'string') continue;
      // Personal-topic isolation: enforced for EVERY role (including
      // owner/admin whose allow list is `*`). Blocks a hand-crafted
      // `notification.<other-user-id>` subscribe regardless of the
      // role-derived allow list.
      if (isPersonalTopicForOtherUser(authUserId, topic)) {
        this.sendForbidden(ws, `Cannot subscribe to another user's personal topic: ${topic}`);
        continue;
      }
      if (canSubscribe(allowedTopics, topic)) {
        subs.add(topic);
        accepted.push(topic);
      } else {
        this.sendForbidden(ws, `Cannot subscribe to topic: ${topic}`);
      }
    }
    return accepted;
  }

  /** Send the catch-up events (or a resync request) for a `since` cursor. */
  private async sendReplay(
    ws: WebSocket,
    since: string,
    accepted: string[],
    wsUserId: string,
  ): Promise<void> {
    const replay = await this.replaySince(since, accepted, wsUserId);
    if (replay.kind === 'resync_required') {
      ws.send(JSON.stringify({ type: 'resync_required', topics: accepted }));
      return;
    }
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

  private async handleSubscribe(
    ws: WebSocket,
    msg: { topics?: string[]; [key: string]: unknown },
    connId: string,
    tags: readonly string[],
  ): Promise<void> {
    if (!Array.isArray(msg.topics)) return;
    const allowedTopics = await this.getAllowedTopics(connId, tags);
    const authUserId = this.getTag(tags, 'user:');
    const subs = await this.loadSubs(connId);

    const accepted = this.acceptTopics(ws, msg.topics, subs, allowedTopics, authUserId);

    await this.saveSubs(connId, subs);

    // Replay missed events when the client supplied a `since` cursor.
    // Must happen BEFORE the `subscribed` ack so the client's local cache
    // sees the catch-up before any live tail message.
    const sinceRaw = msg.since;
    if (typeof sinceRaw === 'string' && sinceRaw.length > 0 && accepted.length > 0) {
      await this.sendReplay(ws, sinceRaw, accepted, authUserId);
    }

    // Live presence is not in the replay log: a subscriber gets the whole of
    // it now, and every change after. A reconnect resubscribes, so a client
    // that missed changes while away is put right without a reload.
    if (accepted.some((topic) => topicMatches(topic, PRESENCE_TOPIC)) && (await this.tracksPresence())) {
      const snapshot: PresenceSnapshot = { users: await this.livePresence() };
      ws.send(this.presenceMessage(PRESENCE_EVENTS.snapshot, snapshot, 'system'));
    }

    if (accepted.length > 0) {
      ws.send(JSON.stringify({ type: 'subscribed', topics: accepted }));
    }
  }

  private async handleUnsubscribe(
    ws: WebSocket,
    msg: { topics?: string[] },
    connId: string,
  ): Promise<void> {
    if (!Array.isArray(msg.topics)) return;
    const subs = await this.loadSubs(connId);
    for (const topic of msg.topics) {
      subs.delete(topic);
    }
    await this.saveSubs(connId, subs);
    ws.send(JSON.stringify({ type: 'unsubscribed', topics: msg.topics }));
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string, _wasClean: boolean): Promise<void> {
    markGone(ws);
    reciprocateClose(ws, code, reason);
    await this.connectionGone(ws);
  }

  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    console.error('[WorkspaceHub] WebSocket error:', error);
    markGone(ws);
    reciprocateClose(ws, 1011, 'Internal error');
    await this.connectionGone(ws);
  }

  // ---- Internal ----

  private async handleWebSocketUpgrade(request: Request): Promise<Response> {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    await this.acceptConnection(server, {
      userId: request.headers.get(AUTH_HEADERS.USER_ID) || 'unknown',
      role: request.headers.get(AUTH_HEADERS.ROLE) || 'member',
      allowedTopics: request.headers.get(AUTH_HEADERS.SUBSCRIBE_TOPICS) || '',
      workspaceId: request.headers.get(AUTH_HEADERS.WORKSPACE_ID) || '',
    });

    return new Response(null, { status: 101, webSocket: client });
  }

  /** Take on the server end of a new connection: identity, allow list, presence. */
  private async acceptConnection(
    server: WebSocket,
    identity: { userId: string; role: string; allowedTopics: string; workspaceId: string },
  ): Promise<void> {
    const { userId, role, allowedTopics, workspaceId } = identity;
    const connId = crypto.randomUUID();

    // Persist workspaceId once so the alarm handler knows which workspace
    // it serves after hibernation.
    if (workspaceId) {
      const stored = await this.ctx.storage.get<string>('workspaceId');
      if (!stored) {
        await this.ctx.storage.put('workspaceId', workspaceId);
      }
      this.hubKey = stored || workspaceId;
    }

    // Tags are immutable and capped at 256 chars each. Keep them short
    // (identity only). The allowed-topic list — which easily exceeds
    // 256 chars once personal topics are included — lives in DO storage
    // under `allowed:<connId>`; mutable presence state in the attachment.
    this.ctx.acceptWebSocket(server, [
      `conn:${connId}`,
      `user:${userId}`,
      `role:${role}`,
    ]);
    const now = Date.now();
    server.serializeAttachment(newConnectionState(now));

    await this.ctx.storage.put(`${ALLOWED_PREFIX}${connId}`, allowedTopics);

    // Initialize empty subscription set
    this.subscriptions.set(connId, new Set());

    server.send(JSON.stringify({ type: 'connected', connectionId: connId }));

    // A reload within the grace period cancels the pending offline and
    // broadcasts nothing; a member who was away is announced.
    await this.refreshPresence(userId);
    if (await this.tracksPresence()) await this.ensureSweepScheduled(now);
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

  // ---- Presence ----

  /**
   * Presence is kept for workspace members only. Personal (consumer) and HR
   * portal hubs have no members to show to each other.
   */
  private async tracksPresence(): Promise<boolean> {
    if (this.hubKey === null) {
      this.hubKey = (await this.ctx.storage.get<string>('workspaceId')) ?? '';
    }
    return this.hubKey !== '' && !isMemberlessHubKey(this.hubKey);
  }

  /** The open connections of one member, minus `exclude` and any already closed. */
  private connectionsOf(userId: string, exclude?: WebSocket): ConnectionState[] {
    const states: ConnectionState[] = [];
    for (const ws of this.ctx.getWebSockets(`user:${userId}`)) {
      if (ws === exclude) continue;
      const state = connectionState(ws);
      if (!state.gone) states.push(state);
    }
    return states;
  }

  /**
   * Live presence of every connected member (or of `only`), counting members
   * inside their offline grace period as still here.
   */
  private async livePresence(only?: Set<string>): Promise<Record<string, LivePresence>> {
    const byUser = new Map<string, ConnectionState[]>();
    for (const ws of this.ctx.getWebSockets()) {
      const userId = this.getTag(this.ctx.getTags(ws), 'user:');
      if (!userId || userId === 'unknown' || (only && !only.has(userId))) continue;
      const state = connectionState(ws);
      if (state.gone) continue;
      const list = byUser.get(userId) ?? [];
      list.push(state);
      byUser.set(userId, list);
    }

    const users: Record<string, LivePresence> = {};
    for (const [userId, connections] of byUser) {
      const live = aggregateConnections(connections);
      if (live) users[userId] = live;
    }

    const pending = await this.ctx.storage.list<number>({ prefix: PENDING_OFFLINE_PREFIX });
    const graceUserIds = [...pending.keys()]
      .map((key) => key.slice(PENDING_OFFLINE_PREFIX.length))
      .filter((userId) => !users[userId] && (!only || only.has(userId)));
    if (graceUserIds.length > 0) {
      const last = await this.ctx.storage.get<LivePresence>(graceUserIds.map((id) => `${PRESENCE_PREFIX}${id}`));
      for (const userId of graceUserIds) {
        const live = last.get(`${PRESENCE_PREFIX}${userId}`);
        if (live) users[userId] = live;
      }
    }
    return users;
  }

  /**
   * Recompute one member's live presence from their open connections and
   * broadcast it when it changed. With no connection left the member is not
   * marked offline yet: that waits out the grace period (`alarm()`), so a
   * reload does not flicker. `exclude` is a socket that is closing but may
   * still be listed by the runtime.
   */
  private async refreshPresence(userId: string, exclude?: WebSocket): Promise<void> {
    if (!userId || userId === 'unknown' || !(await this.tracksPresence())) return;

    const live = aggregateConnections(this.connectionsOf(userId, exclude));
    const stateKey = `${PRESENCE_PREFIX}${userId}`;
    const previous = (await this.ctx.storage.get<LivePresence>(stateKey)) ?? null;

    if (live === null) {
      if (previous !== null) await this.startOfflineGracePeriod(userId);
      return;
    }

    if (await this.ctx.storage.delete(`${PENDING_OFFLINE_PREFIX}${userId}`)) {
      await this.rescheduleAlarm();
    }
    if (live !== previous) {
      await this.ctx.storage.put(stateKey, live);
      await this.broadcastPresence({ userId, live });
    }
  }

  /** A connection closed: forget it and update its member. */
  private async connectionGone(ws: WebSocket): Promise<void> {
    const tags = this.ctx.getTags(ws);
    await this.deleteSubs(this.getTag(tags, 'conn:'));
    await this.refreshPresence(this.getTag(tags, 'user:'), ws);
  }

  /** Mark a member offline at the end of the grace period, unless they come back first. */
  private async startOfflineGracePeriod(userId: string): Promise<void> {
    const key = `${PENDING_OFFLINE_PREFIX}${userId}`;
    const existing = await this.ctx.storage.get<number>(key);
    const fireAt = Date.now() + OFFLINE_GRACE_MS;

    // Don't extend a pending timer — keep the earliest fire time
    if (existing && existing <= fireAt) return;

    await this.ctx.storage.put(key, fireAt);
    await this.rescheduleAlarm();
  }

  private async ensureSweepScheduled(now: number): Promise<void> {
    if ((await this.ctx.storage.get<number>(NEXT_SWEEP_AT_KEY)) !== undefined) return;
    await this.ctx.storage.put(NEXT_SWEEP_AT_KEY, now + PRESENCE_SWEEP_INTERVAL_MS);
    await this.rescheduleAlarm();
  }

  /**
   * Close every connection that has gone silent — a laptop shut or a network
   * dropped never sends a close frame — and settle the presence of everyone
   * affected. Also settles members still recorded as here with no connection
   * left, which a restart of the object can leave behind.
   */
  private async sweepConnections(now: number): Promise<void> {
    const affected = new Set<string>();
    let anyOpen = false;

    for (const ws of this.ctx.getWebSockets()) {
      const state = connectionState(ws);
      if (state.gone) continue;
      const lastHeard = lastHeardFrom(state, this.ctx.getWebSocketAutoResponseTimestamp(ws));
      if (!isConnectionStale(lastHeard, now)) {
        anyOpen = true;
        continue;
      }
      const tags = this.ctx.getTags(ws);
      markGone(ws);
      reciprocateClose(ws, STALE_CLOSE_CODE, 'heartbeat timeout');
      await this.deleteSubs(this.getTag(tags, 'conn:'));
      affected.add(this.getTag(tags, 'user:'));
    }

    const recorded = await this.ctx.storage.list<LivePresence>({ prefix: PRESENCE_PREFIX });
    for (const key of recorded.keys()) affected.add(key.slice(PRESENCE_PREFIX.length));
    for (const userId of affected) await this.refreshPresence(userId);

    if (anyOpen) {
      await this.ctx.storage.put(NEXT_SWEEP_AT_KEY, now + PRESENCE_SWEEP_INTERVAL_MS);
    } else {
      await this.ctx.storage.delete(NEXT_SWEEP_AT_KEY);
    }
  }

  /**
   * Set the DO alarm to the earliest of: a pending offline, the next
   * dead-connection sweep, the next event-log prune. Clears it when none is due.
   */
  private async rescheduleAlarm(): Promise<void> {
    const pending = await this.ctx.storage.list<number>({ prefix: PENDING_OFFLINE_PREFIX });

    let earliest: number | null = null;
    for (const fireAt of pending.values()) {
      if (earliest === null || fireAt < earliest) earliest = fireAt;
    }

    for (const key of [NEXT_PRUNE_AT_KEY, NEXT_SWEEP_AT_KEY]) {
      const at = await this.ctx.storage.get<number>(key);
      if (at && (earliest === null || at < earliest)) earliest = at;
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
   * subsystem: event-log prune, dead-connection sweep, then the members whose
   * offline grace period is over.
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

    // 2) Dead connections.
    const nextSweep = await this.ctx.storage.get<number>(NEXT_SWEEP_AT_KEY);
    if (nextSweep && nextSweep <= now) {
      await this.sweepConnections(now);
    }

    // 3) Members whose grace period is over.
    const pending = await this.ctx.storage.list<number>({ prefix: PENDING_OFFLINE_PREFIX });
    for (const [key, fireAt] of pending.entries()) {
      if (fireAt > now) continue;
      const userId = key.slice(PENDING_OFFLINE_PREFIX.length);
      await this.ctx.storage.delete(key);

      // Reconnected in the meantime (the upgrade should have cancelled the
      // timer already; this covers the race).
      if (this.connectionsOf(userId).length > 0) {
        await this.refreshPresence(userId);
        continue;
      }

      await this.ctx.storage.delete(`${PRESENCE_PREFIX}${userId}`);
      await this.broadcastPresence({ userId, live: null });
    }

    await this.rescheduleAlarm();
  }

  private presenceMessage(event: string, data: unknown, userId: string): string {
    return JSON.stringify({ type: 'event', topic: PRESENCE_TOPIC, event, data, ts: Date.now(), userId });
  }

  /**
   * Tell every `presence` subscriber that a member's live presence changed.
   * Not added to the replay log: a subscriber that missed it gets a fresh
   * snapshot when it resubscribes.
   */
  private async broadcastPresence(change: PresenceConnectionChange): Promise<void> {
    const message = this.presenceMessage(PRESENCE_EVENTS.connection, change, change.userId);

    for (const ws of this.ctx.getWebSockets()) {
      if (connectionState(ws).gone) continue;
      const connId = this.getTag(this.ctx.getTags(ws), 'conn:');
      // Load from storage on miss — alarm-driven wakes have an empty in-memory
      // map even though the underlying WebSocket and its `subs:*` survive.
      const subs = await this.loadSubs(connId);
      if (subs.size === 0 || !this.matchesAnySubscription(subs, PRESENCE_TOPIC)) continue;
      try {
        ws.send(message);
      } catch {
        // WebSocket may have closed
      }
    }
  }
}
