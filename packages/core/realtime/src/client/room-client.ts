import type {
  ConnectionState,
  RoomEvent,
  PresenceMember,
  TypingUser,
  Attachment,
} from '../types';

export interface RoomClientConfig {
  /** WebSocket URL, e.g. wss://realtime.weldsuite.com/ws/conversation/conv_123 */
  url: string;
  /** Returns a Clerk JWT or widget token for authentication */
  getToken: () => Promise<string>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyHandler = (event: any) => void;

/**
 * Client for ConversationRoom and ChatRoom Durable Objects.
 *
 * Created on-demand when viewing a conversation or chat channel,
 * disposed when leaving. Handles bidirectional messaging, presence,
 * and typing indicators.
 *
 * Usage:
 *   const room = new RoomClient({ url: `${baseUrl}/ws/conversation/${id}`, getToken });
 *   await room.connect();
 *   room.on('message', (msg) => { ... });
 *   room.sendMessage('Hello!');
 */
export class RoomClient {
  private ws: WebSocket | null = null;
  /** WebSocket that is still handshaking (not yet promoted to this.ws) */
  private pendingWs: WebSocket | null = null;
  private eventHandlers = new Map<string, Set<AnyHandler>>();
  private presenceHandlers = new Set<(members: PresenceMember[]) => void>();
  private typingHandlers = new Set<(users: TypingUser[]) => void>();
  private connectionHandlers = new Set<(state: ConnectionState) => void>();
  private _presence: PresenceMember[] = [];
  private _typing = new Map<string, TypingUser>();
  private typingTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private state: ConnectionState = 'disconnected';
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private intentionalClose = false;
  private enteredPresenceData: Record<string, unknown> | null = null;
  private _lastSeq = 0;

  constructor(private config: RoomClientConfig) {}

  async connect(): Promise<void> {
    if (this.ws && this.state === 'connected') return;

    this.intentionalClose = false;
    this.setState(this.reconnectAttempt > 0 ? 'reconnecting' : 'connecting');

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
            const msg = JSON.parse(
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
              // Capture sequence number for gap detection
              if (typeof msg.lastSeq === 'number') {
                this._lastSeq = msg.lastSeq;
              }
              // Initialize presence from server snapshot
              if (Array.isArray(msg.presence)) {
                this._presence = msg.presence;
                this.notifyPresence();
              }
              // Re-enter presence if we were in it before reconnect
              if (this.enteredPresenceData) {
                this.send({ type: 'presence:enter', data: this.enteredPresenceData });
              }
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
    // Leave presence before closing
    if (this.enteredPresenceData && this.ws?.readyState === WebSocket.OPEN) {
      this.send({ type: 'presence:leave' });
    }
    this.enteredPresenceData = null;
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.clearAllTypingTimers();
    this.setState('disconnected');
  }

  /**
   * Re-establish the connection if it is not genuinely live. Intended for
   * mobile foreground transitions: the OS suspends this socket (and the
   * heartbeat that would detect its death) in the background, so `state` can
   * read `connected` while the socket is actually dead. Force-reconnects when
   * the underlying socket isn't OPEN, bypassing any backoff timer; a no-op when
   * the socket is truly OPEN. A reconnect re-emits `connected` so consumers
   * (e.g. useChatRealtime) can refetch any messages missed while away.
   */
  reconnect(): void {
    if (this.intentionalClose) return;
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

  // ---- Event Subscription ----

  /** Subscribe to a specific room event type. Returns an unsubscribe function. */
  on<T extends RoomEvent['type']>(
    type: T,
    handler: (event: Extract<RoomEvent, { type: T }>) => void,
  ): () => void {
    if (!this.eventHandlers.has(type)) {
      this.eventHandlers.set(type, new Set());
    }
    this.eventHandlers.get(type)!.add(handler);

    return () => {
      const set = this.eventHandlers.get(type);
      if (set) {
        set.delete(handler);
        if (set.size === 0) this.eventHandlers.delete(type);
      }
    };
  }

  // ---- Publishing (Client → Room) ----

  sendMessage(content: string, attachments?: Attachment[]): void {
    this.send({ type: 'message', content, attachments });
  }

  sendChatMessage(content: string, opts?: { threadId?: string; attachments?: Attachment[] }): void {
    this.send({ type: 'message', content, threadId: opts?.threadId, attachments: opts?.attachments });
  }

  sendSupportMessage(content: string, opts?: { senderAvatar?: string }): void {
    this.send({ type: 'message', content, senderAvatar: opts?.senderAvatar });
  }

  addReaction(messageId: string, emoji: string): void {
    this.send({ type: 'reaction:add', messageId, emoji });
  }

  removeReaction(messageId: string, emoji: string): void {
    this.send({ type: 'reaction:remove', messageId, emoji });
  }

  // ---- Presence ----

  enterPresence(data?: Record<string, unknown>): void {
    this.enteredPresenceData = data ?? {};
    this.send({ type: 'presence:enter', data });
  }

  leavePresence(): void {
    this.enteredPresenceData = null;
    this.send({ type: 'presence:leave' });
  }

  onPresence(handler: (members: PresenceMember[]) => void): () => void {
    this.presenceHandlers.add(handler);
    // Immediately call with current state
    handler(this._presence);
    return () => this.presenceHandlers.delete(handler);
  }

  get presence(): PresenceMember[] {
    return this._presence;
  }

  // ---- Call Events ----

  sendHandRaise(): void {
    this.send({ type: 'call:hand-raised' });
  }

  sendHandLower(): void {
    this.send({ type: 'call:hand-lowered' });
  }

  // ---- Typing ----

  startTyping(): void {
    this.send({ type: 'typing:start' });
  }

  stopTyping(): void {
    this.send({ type: 'typing:stop' });
  }

  onTyping(handler: (users: TypingUser[]) => void): () => void {
    this.typingHandlers.add(handler);
    handler(Array.from(this._typing.values()));
    return () => this.typingHandlers.delete(handler);
  }

  get typing(): TypingUser[] {
    return Array.from(this._typing.values());
  }

  // ---- Connection ----

  get isConnected(): boolean {
    return this.state === 'connected';
  }

  get connectionState(): ConnectionState {
    return this.state;
  }

  /** Last message sequence number received from the server on connect. */
  get lastSeq(): number {
    return this._lastSeq;
  }

  onConnectionChange(handler: (state: ConnectionState) => void): () => void {
    this.connectionHandlers.add(handler);
    return () => this.connectionHandlers.delete(handler);
  }

  // ---- Internal ----

  private send(msg: Record<string, unknown>): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  private handleMessage(ev: MessageEvent): void {
    let msg: RoomEvent | { type: 'connected' | 'error' | 'pong'; [k: string]: unknown };
    try {
      msg = JSON.parse(typeof ev.data === 'string' ? ev.data : new TextDecoder().decode(ev.data));
    } catch {
      return;
    }

    // Handle protocol-level messages
    if (msg.type === 'pong' || msg.type === 'connected') return;
    if (msg.type === 'error') {
      console.warn('[Room] Server error:', (msg as any).code, (msg as any).message);
      return;
    }

    // Handle presence updates
    if (msg.type === 'presence:join') {
      const joinMsg = msg as Extract<RoomEvent, { type: 'presence:join' }>;
      this._presence = [
        ...this._presence.filter((m) => m.userId !== joinMsg.member.userId),
        joinMsg.member,
      ];
      this.notifyPresence();
    } else if (msg.type === 'presence:leave') {
      const leaveMsg = msg as Extract<RoomEvent, { type: 'presence:leave' }>;
      this._presence = this._presence.filter((m) => m.userId !== leaveMsg.userId);
      this.notifyPresence();
    }

    // Handle typing updates
    if (msg.type === 'typing') {
      const typingMsg = msg as Extract<RoomEvent, { type: 'typing' }>;
      if (typingMsg.isTyping) {
        this._typing.set(typingMsg.userId, {
          userId: typingMsg.userId,
          userName: typingMsg.userName,
        });
        // Auto-clear after 6s if no stop received
        this.clearTypingTimer(typingMsg.userId);
        this.typingTimers.set(
          typingMsg.userId,
          setTimeout(() => {
            this._typing.delete(typingMsg.userId);
            this.notifyTyping();
          }, 6000),
        );
      } else {
        this._typing.delete(typingMsg.userId);
        this.clearTypingTimer(typingMsg.userId);
      }
      this.notifyTyping();
    }

    // Dispatch to registered handlers
    const handlers = this.eventHandlers.get(msg.type);
    if (handlers) {
      for (const handler of handlers) {
        try {
          handler(msg as any);
        } catch (err) {
          console.error('[Room] Handler error:', err);
        }
      }
    }
  }

  private handleClose(): void {
    this.ws = null;
    this.stopHeartbeat();
    this.clearAllTypingTimers();
    if (!this.intentionalClose) {
      this.scheduleReconnect();
    }
  }

  /**
   * Send `{"type":"ping"}` every 25s to keep the WebSocket alive through
   * edge/proxy idle timeouts. The room DO pairs this with
   * `setWebSocketAutoResponse` so pings don't wake it from hibernation.
   */
  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        try {
          this.ws.send('{"type":"ping"}');
        } catch {
          // Picked up by the close handler.
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

  private setState(state: ConnectionState): void {
    if (this.state === state) return;
    this.state = state;
    for (const handler of this.connectionHandlers) {
      try {
        handler(state);
      } catch (err) {
        console.error('[Room] Connection handler error:', err);
      }
    }
  }

  private notifyPresence(): void {
    for (const handler of this.presenceHandlers) {
      try {
        handler(this._presence);
      } catch (err) {
        console.error('[Room] Presence handler error:', err);
      }
    }
  }

  private notifyTyping(): void {
    const users = Array.from(this._typing.values());
    for (const handler of this.typingHandlers) {
      try {
        handler(users);
      } catch (err) {
        console.error('[Room] Typing handler error:', err);
      }
    }
  }

  private clearTypingTimer(userId: string): void {
    const timer = this.typingTimers.get(userId);
    if (timer) {
      clearTimeout(timer);
      this.typingTimers.delete(userId);
    }
  }

  private clearAllTypingTimers(): void {
    for (const timer of this.typingTimers.values()) {
      clearTimeout(timer);
    }
    this.typingTimers.clear();
    this._typing.clear();
  }
}
