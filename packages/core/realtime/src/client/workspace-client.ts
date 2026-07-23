import type {
  ConnectionState,
  WorkspaceEvent,
  WorkspaceClientMessage,
  WorkspaceServerMessage,
} from '../types';
import { topicMatches, isBarePersonalTopic } from '../topics';

/**
 * Pluggable persistent storage for the last-seen `eventId` cursor. Web uses
 * localStorage; mobile uses AsyncStorage. Implementations may be async so
 * AsyncStorage can be wrapped without a wait-for-init dance.
 */
export interface CursorStore {
  get(): Promise<string | null> | string | null;
  set(eventId: string): Promise<void> | void;
  clear(): Promise<void> | void;
}

export interface WorkspaceClientConfig {
  /** WebSocket URL, e.g. wss://realtime.weldsuite.com/ws */
  url: string;
  /** Returns a Clerk JWT for authentication */
  getToken: () => Promise<string>;
  /**
   * Optional cursor store. When supplied, the client persists the latest
   * `eventId` received from the server and replays from that cursor on
   * (re)subscribe. The DO returns `resync_required` if the cursor is older
   * than the retention window.
   */
  cursorStore?: CursorStore;
}

type EventHandler<T = unknown> = (event: WorkspaceEvent<T>) => void;
type ConnectionHandler = (state: ConnectionState) => void;
type ResyncHandler = (topics: string[]) => void;

/**
 * Client for the WorkspaceHub Durable Object.
 *
 * Maintains a persistent WebSocket connection for workspace-wide events
 * (entity CRUD, notifications, mail, inbox updates). Automatically
 * reconnects with exponential backoff.
 *
 * Usage:
 *   const client = new WorkspaceClient({ url, getToken });
 *   await client.connect();
 *   const unsub = client.on('project', (event) => { ... });
 */
export class WorkspaceClient {
  private ws: WebSocket | null = null;
  /** WebSocket that is still handshaking (not yet promoted to this.ws) */
  private pendingWs: WebSocket | null = null;
  private handlers = new Map<string, Set<EventHandler>>();
  private subscribedTopics = new Set<string>();
  private connectionHandlers = new Set<ConnectionHandler>();
  private resyncHandlers = new Set<ResyncHandler>();
  private state: ConnectionState = 'disconnected';
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private intentionalClose = false;
  /** In-memory mirror of the persisted cursor — last `eventId` we observed. */
  private lastEventId: string | null = null;

  constructor(private config: WorkspaceClientConfig) {}

  async connect(): Promise<void> {
    if (this.ws && this.state === 'connected') return;

    this.intentionalClose = false;
    this.setState(this.reconnectAttempt > 0 ? 'reconnecting' : 'connecting');

    // Hydrate cursor from persistent storage on first connect so cold launches
    // can replay missed events.
    if (this.lastEventId === null && this.config.cursorStore) {
      try {
        const stored = await Promise.resolve(this.config.cursorStore.get());
        if (typeof stored === 'string' && stored.length > 0) {
          this.lastEventId = stored;
        }
      } catch (err) {
        console.warn('[Realtime] CursorStore.get failed:', err);
      }
    }

    try {
      const token = await this.config.getToken();

      // If disconnected while awaiting the token, bail out
      if (this.intentionalClose) return;

      const url = new URL(this.config.url);
      url.searchParams.set('token', token);
      const ws = new WebSocket(url.toString());
      this.pendingWs = ws;

      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          ws.close();
          reject(new Error('Connection timeout'));
        }, 15000);

        ws.addEventListener('message', (ev) => {
          try {
            const msg: WorkspaceServerMessage = JSON.parse(
              typeof ev.data === 'string' ? ev.data : new TextDecoder().decode(ev.data as ArrayBuffer),
            );
            if (msg.type === 'connected') {
              clearTimeout(timeout);

              // If disconnected during handshake, close immediately
              if (this.intentionalClose) {
                ws.close();
                reject(new Error('Disconnected during handshake'));
                return;
              }

              this.pendingWs = null;
              this.ws = ws;
              this.reconnectAttempt = 0;
              this.setState('connected');
              this.resubscribe();
              resolve();
            }
          } catch {
            // Ignore parse errors during handshake
          }
        });

        ws.addEventListener('error', () => {
          clearTimeout(timeout);
          reject(new Error('WebSocket error'));
        });

        ws.addEventListener('close', () => {
          clearTimeout(timeout);
          if (this.state !== 'connected') {
            reject(new Error('WebSocket closed before connected'));
          }
        });
      });

      // Set up permanent listeners after connection established
      this.ws!.addEventListener('message', (ev) => this.handleMessage(ev));
      this.ws!.addEventListener('close', () => this.handleClose());
      this.ws!.addEventListener('error', () => this.handleClose());

      this.startHeartbeat();
    } catch {
      if (!this.intentionalClose) {
        this.scheduleReconnect();
      }
    }
  }

  disconnect(): void {
    this.intentionalClose = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.stopHeartbeat();
    // Close in-flight handshake if any
    if (this.pendingWs) {
      this.pendingWs.close();
      this.pendingWs = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.setState('disconnected');
  }

  /**
   * Re-establish the connection if it is not genuinely live. Intended for
   * mobile foreground transitions: the OS suspends the JS runtime (and this
   * socket) in the background, but the client's `state` can still read
   * `connected` because the heartbeat that would detect the dead socket was
   * also suspended. This force-reconnects when the underlying socket isn't
   * OPEN, bypassing any pending backoff timer; if the socket is truly OPEN it
   * is a no-op (no needless churn). Cursor replay covers any gap.
   */
  reconnect(): void {
    if (this.intentionalClose) return;
    // Truly connected — nothing to do.
    if (this.state === 'connected' && this.ws?.readyState === WebSocket.OPEN) {
      return;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.stopHeartbeat();
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // ignore
      }
      this.ws = null;
    }
    this.reconnectAttempt = 0;
    this.setState('disconnected');
    void this.connect();
  }

  /**
   * Subscribe to events on a topic. Returns an unsubscribe function.
   * Subscribing to "project" will receive events for "project", "project.proj_123", etc.
   */
  on<T = unknown>(topic: string, handler: EventHandler<T>): () => void {
    // Skip topics the WorkspaceHub will always reject. An empty topic is the
    // transient "user not loaded yet" state (callers pass '' until they have an
    // id) — silently ignore it. A bare personal topic (`notification`, `mail`,
    // …) is a bug: personal topics are per-user, so warn and no-op rather than
    // letting the server answer with a `forbidden` error on the wire.
    if (!topic) return () => {};
    if (isBarePersonalTopic(topic)) {
      console.warn(
        `[Realtime] Ignoring subscribe to bare personal topic "${topic}" — ` +
          `personal topics are per-user; subscribe to "${topic}.<userId>" instead.`,
      );
      return () => {};
    }

    if (!this.handlers.has(topic)) {
      this.handlers.set(topic, new Set());
    }
    this.handlers.get(topic)!.add(handler as EventHandler);
    this.ensureSubscribed(topic);

    return () => {
      const set = this.handlers.get(topic);
      if (set) {
        set.delete(handler as EventHandler);
        if (set.size === 0) {
          this.handlers.delete(topic);
          this.unsubscribeTopic(topic);
        }
      }
    };
  }

  /**
   * Subscribe to a specific event name on a topic.
   * e.g. onEvent('contact', 'created', (data) => { ... })
   */
  onEvent<T = unknown>(
    topic: string,
    eventName: string,
    handler: (data: T, event: WorkspaceEvent<T>) => void,
  ): () => void {
    return this.on<T>(topic, (event) => {
      if (event.event === eventName) {
        handler(event.data, event);
      }
    });
  }

  get isConnected(): boolean {
    return this.state === 'connected';
  }

  get connectionState(): ConnectionState {
    return this.state;
  }

  onConnectionChange(handler: ConnectionHandler): () => void {
    this.connectionHandlers.add(handler);
    return () => this.connectionHandlers.delete(handler);
  }

  /**
   * Subscribe to `resync_required` notifications — fired when the cursor
   * we sent on (re)subscribe is older than the server's retention window
   * and the client must invalidate its caches for the affected topics.
   */
  onResyncRequired(handler: ResyncHandler): () => void {
    this.resyncHandlers.add(handler);
    return () => this.resyncHandlers.delete(handler);
  }

  /** Most recent eventId observed (or hydrated from cursor store). */
  get cursor(): string | null {
    return this.lastEventId;
  }

  // ---- Internal ----

  private send(msg: WorkspaceClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  private handleMessage(ev: MessageEvent): void {
    let msg: WorkspaceServerMessage;
    try {
      msg = JSON.parse(typeof ev.data === 'string' ? ev.data : new TextDecoder().decode(ev.data));
    } catch {
      return;
    }

    switch (msg.type) {
      case 'event':
        this.dispatchEvent(msg);
        break;
      case 'resync_required':
        this.dispatchResync(msg.topics);
        break;
      case 'pong':
        break;
      case 'error':
        console.warn('[Realtime] Server error:', msg.code, msg.message);
        break;
    }
  }

  private dispatchEvent(msg: Extract<WorkspaceServerMessage, { type: 'event' }>): void {
    if (msg.eventId) {
      this.recordCursor(msg.eventId);
    }
    const event: WorkspaceEvent = {
      topic: msg.topic,
      event: msg.event,
      data: msg.data,
      ts: msg.ts,
      userId: msg.userId,
      eventId: msg.eventId,
    };

    for (const [subTopic, handlers] of this.handlers) {
      if (topicMatches(subTopic, msg.topic)) {
        for (const handler of handlers) {
          try {
            handler(event);
          } catch (err) {
            console.error('[Realtime] Handler error:', err);
          }
        }
      }
    }
  }

  private handleClose(): void {
    this.ws = null;
    this.stopHeartbeat();
    if (!this.intentionalClose) {
      this.scheduleReconnect();
    }
  }

  /**
   * Send `{"type":"ping"}` every 25s to keep the WebSocket alive through
   * edge/proxy idle timeouts (~60s). The DO pairs this with
   * `setWebSocketAutoResponse` so pings don't wake it from hibernation.
   */
  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        try {
          this.ws.send('{"type":"ping"}');
        } catch {
          // Will be picked up by the close handler.
        }
      }
    }, 25_000);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.intentionalClose) return;
    this.setState('reconnecting');
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempt), 30000);
    this.reconnectAttempt++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private ensureSubscribed(topic: string): void {
    if (!this.subscribedTopics.has(topic)) {
      this.subscribedTopics.add(topic);
      this.send({
        type: 'subscribe',
        topics: [topic],
        ...(this.lastEventId ? { since: this.lastEventId } : {}),
      });
    }
  }

  private unsubscribeTopic(topic: string): void {
    if (this.subscribedTopics.has(topic)) {
      this.subscribedTopics.delete(topic);
      this.send({ type: 'unsubscribe', topics: [topic] });
    }
  }

  private resubscribe(): void {
    if (this.subscribedTopics.size > 0) {
      this.send({
        type: 'subscribe',
        topics: Array.from(this.subscribedTopics),
        ...(this.lastEventId ? { since: this.lastEventId } : {}),
      });
    }
  }

  private dispatchResync(topics: string[]): void {
    for (const handler of this.resyncHandlers) {
      try {
        handler(topics);
      } catch (err) {
        console.error('[Realtime] Resync handler error:', err);
      }
    }
  }

  private recordCursor(eventId: string): void {
    // Monotonic check: ignore out-of-order deliveries.
    if (this.lastEventId !== null && eventId <= this.lastEventId) return;
    this.lastEventId = eventId;
    if (this.config.cursorStore) {
      try {
        const result = this.config.cursorStore.set(eventId);
        if (result && typeof (result as Promise<void>).catch === 'function') {
          (result as Promise<void>).catch((err) => {
            console.warn('[Realtime] CursorStore.set failed:', err);
          });
        }
      } catch (err) {
        console.warn('[Realtime] CursorStore.set failed:', err);
      }
    }
  }

  private setState(state: ConnectionState): void {
    if (this.state === state) return;
    this.state = state;
    for (const handler of this.connectionHandlers) {
      try {
        handler(state);
      } catch (err) {
        console.error('[Realtime] Connection handler error:', err);
      }
    }
  }
}
