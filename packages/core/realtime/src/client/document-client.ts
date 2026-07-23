import type { ConnectionState } from '../types';

export interface DocumentPresenceMember {
  userId: string;
  sessionId: string;
  name: string;
  avatar?: string;
  color: string;
}

export interface DocumentClientConfig {
  /** Base URL, e.g. wss://realtime-test.weldsuite.org */
  baseUrl: string;
  /** Returns a Clerk JWT */
  getToken: () => Promise<string>;
  /** User info for presence */
  userId: string;
  userName: string;
  userAvatar?: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyHandler = (...args: any[]) => void;

const PRESENCE_COLORS = [
  '#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4',
  '#FFEAA7', '#DDA0DD', '#98D8C8', '#F7DC6F',
  '#FF8C42', '#6C5CE7', '#A8E6CF', '#FFB3BA',
];

function colorForUser(userId: string): string {
  let hash = 0;
  for (let i = 0; i < userId.length; i++) {
    hash = userId.charCodeAt(i) + ((hash << 5) - hash);
  }
  return PRESENCE_COLORS[Math.abs(hash) % PRESENCE_COLORS.length]!;
}

/**
 * Client for DocumentRoom Durable Object.
 *
 * Created when opening a document, disposed when leaving.
 * Handles content sync, title updates, cursor broadcasting, and presence.
 * Each instance gets a unique sessionId for multi-tab support.
 */
export class DocumentClient {
  private ws: WebSocket | null = null;
  private pendingWs: WebSocket | null = null;
  private state: ConnectionState = 'disconnected';
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private intentionalClose = false;
  readonly sessionId = `session_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  readonly userColor: string;

  // Presence
  private _presence: DocumentPresenceMember[] = [];
  private presenceHandlers = new Set<(members: DocumentPresenceMember[]) => void>();

  // Content broadcast debouncing
  private pendingContent: string | null = null;
  private contentTimeout: ReturnType<typeof setTimeout> | null = null;
  private contentDebounceMs = 300;

  // Event handlers
  private eventHandlers = new Map<string, Set<AnyHandler>>();
  private connectionHandlers = new Set<(state: ConnectionState) => void>();

  constructor(
    private documentId: string,
    private config: DocumentClientConfig,
  ) {
    this.userColor = colorForUser(config.userId);
  }

  async connect(): Promise<void> {
    if (this.ws && this.state === 'connected') return;

    this.intentionalClose = false;
    this.setState(this.reconnectAttempt > 0 ? 'reconnecting' : 'connecting');

    try {
      const token = await this.config.getToken();
      if (this.intentionalClose) return;

      const url = new URL(`${this.config.baseUrl}/ws/document/${this.documentId}`);
      url.searchParams.set('token', token);
      url.searchParams.set('sessionId', this.sessionId);
      const ws = new WebSocket(url.toString());
      this.pendingWs = ws;

      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          ws.close();
          reject(new Error('Connection timeout'));
        }, 15000);

        ws.addEventListener('message', (ev) => {
          try {
            const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : new TextDecoder().decode(ev.data as ArrayBuffer));
            if (msg.type === 'connected') {
              clearTimeout(timeout);
              if (this.intentionalClose) {
                ws.close();
                reject(new Error('Disconnected during handshake'));
                return;
              }
              this.pendingWs = null;
              this.ws = ws;
              this.reconnectAttempt = 0;
              this.setState('connected');
              // Load initial presence
              if (Array.isArray(msg.presence)) {
                this._presence = msg.presence;
                this.notifyPresence();
              }
              // Enter presence
              this.send({
                type: 'presence:enter',
                name: this.config.userName,
                avatar: this.config.userAvatar,
              });
              resolve();
            }
          } catch { /* ignore */ }
        });

        ws.addEventListener('error', () => { clearTimeout(timeout); reject(new Error('WebSocket error')); });
        ws.addEventListener('close', () => { clearTimeout(timeout); if (this.state !== 'connected') reject(new Error('Closed before connected')); });
      });

      this.ws!.addEventListener('message', (ev) => this.handleMessage(ev));
      this.ws!.addEventListener('close', () => this.handleClose());
      this.ws!.addEventListener('error', () => this.handleClose());

      this.startHeartbeat();
    } catch {
      if (!this.intentionalClose) this.scheduleReconnect();
    }
  }

  disconnect(): void {
    this.intentionalClose = true;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.contentTimeout) { clearTimeout(this.contentTimeout); this.contentTimeout = null; }
    this.stopHeartbeat();
    if (this.pendingWs) { this.pendingWs.close(); this.pendingWs = null; }
    if (this.ws) {
      this.send({ type: 'presence:leave' });
      this.ws.close();
      this.ws = null;
    }
    this._presence = [];
    this.setState('disconnected');
  }

  // ---- Content Operations ----

  /** Broadcast content update (debounced — batches rapid edits) */
  broadcastContentUpdate(content: string): void {
    this.pendingContent = content;
    if (!this.contentTimeout) {
      this.contentTimeout = setTimeout(() => {
        this.contentTimeout = null;
        if (this.pendingContent !== null) {
          this.send({ type: 'content:update', content: this.pendingContent });
          this.pendingContent = null;
        }
      }, this.contentDebounceMs);
    }
  }

  /** Broadcast title update (immediate) */
  broadcastTitleUpdate(title: string): void {
    this.send({ type: 'title:update', title });
  }

  // ---- Event Handlers ----

  onContentUpdate(handler: (content: string, userId: string) => void): () => void {
    return this.addHandler('content:update', handler);
  }

  onTitleUpdate(handler: (title: string, userId: string) => void): () => void {
    return this.addHandler('title:update', handler);
  }

  // ---- Presence ----

  onPresence(handler: (members: DocumentPresenceMember[]) => void): () => void {
    this.presenceHandlers.add(handler);
    handler(this._presence);
    return () => this.presenceHandlers.delete(handler);
  }

  get presence(): DocumentPresenceMember[] {
    return this._presence;
  }

  // ---- Connection ----

  get isConnected(): boolean { return this.state === 'connected'; }
  get connectionState(): ConnectionState { return this.state; }

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
    let msg: any;
    try {
      msg = JSON.parse(typeof ev.data === 'string' ? ev.data : new TextDecoder().decode(ev.data));
    } catch { return; }

    if (msg.type === 'pong' || msg.type === 'connected') return;
    if (msg.type === 'error') {
      console.warn('[Document] Server error:', msg.code, msg.message);
      return;
    }

    switch (msg.type) {
      case 'content:update': {
        const handlers = this.eventHandlers.get('content:update');
        handlers?.forEach(h => h(msg.content, msg.userId));
        break;
      }
      case 'title:update': {
        const handlers = this.eventHandlers.get('title:update');
        handlers?.forEach(h => h(msg.title, msg.userId));
        break;
      }
      case 'presence:join': {
        const member = msg.member as DocumentPresenceMember;
        this._presence = [...this._presence.filter(m => m.sessionId !== member.sessionId), member];
        this.notifyPresence();
        break;
      }
      case 'presence:leave': {
        this._presence = this._presence.filter(m => m.sessionId !== msg.sessionId);
        this.notifyPresence();
        break;
      }
    }
  }

  private handleClose(): void {
    this.ws = null;
    this.stopHeartbeat();
    if (!this.intentionalClose) this.scheduleReconnect();
  }

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
    for (const h of this.connectionHandlers) { try { h(state); } catch { /* */ } }
  }

  private notifyPresence(): void {
    for (const h of this.presenceHandlers) { try { h(this._presence); } catch { /* */ } }
  }

  private addHandler(event: string, handler: AnyHandler): () => void {
    if (!this.eventHandlers.has(event)) this.eventHandlers.set(event, new Set());
    this.eventHandlers.get(event)!.add(handler);
    return () => {
      const set = this.eventHandlers.get(event);
      if (set) { set.delete(handler); if (set.size === 0) this.eventHandlers.delete(event); }
    };
  }
}
