import type { ConnectionState, PresenceMember } from '../types';

export interface WhiteboardPresenceMember {
  userId: string;
  sessionId: string;
  name: string;
  avatar?: string;
  color: string;
}

export interface WhiteboardCursor {
  userId: string;
  x: number;
  y: number;
  tool?: string;
}

export interface WhiteboardBatchChange {
  adds?: any[];
  updates?: Array<{ id: string; changes: any }>;
  deletes?: string[];
}

export interface WhiteboardClientConfig {
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
 * Client for WhiteboardRoom Durable Object.
 *
 * Created when opening a whiteboard, disposed when leaving.
 * Handles element sync, cursor broadcasting, presence, and selections.
 * Each instance gets a unique sessionId for multi-tab support.
 */
export class WhiteboardClient {
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
  private _presence: WhiteboardPresenceMember[] = [];
  private presenceHandlers = new Set<(members: WhiteboardPresenceMember[]) => void>();

  // Cursors
  private _cursors = new Map<string, WhiteboardCursor>();
  private cursorHandlers = new Set<(cursors: WhiteboardCursor[]) => void>();

  // Cursor throttling
  private lastCursorSend = 0;
  private cursorThrottleMs = 50;
  private pendingCursor: { x: number; y: number; tool?: string } | null = null;
  private cursorTimeout: ReturnType<typeof setTimeout> | null = null;

  // Event handlers
  private eventHandlers = new Map<string, Set<AnyHandler>>();
  private connectionHandlers = new Set<(state: ConnectionState) => void>();

  constructor(
    private whiteboardId: string,
    private config: WhiteboardClientConfig,
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

      const url = new URL(`${this.config.baseUrl}/ws/whiteboard/${this.whiteboardId}`);
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
    if (this.cursorTimeout) { clearTimeout(this.cursorTimeout); this.cursorTimeout = null; }
    this.stopHeartbeat();
    if (this.pendingWs) { this.pendingWs.close(); this.pendingWs = null; }
    if (this.ws) {
      this.send({ type: 'presence:leave' });
      this.ws.close();
      this.ws = null;
    }
    this._presence = [];
    this._cursors.clear();
    this.setState('disconnected');
  }

  // ---- Element Operations ----

  async broadcastElementAdd(element: any): Promise<void> {
    this.send({ type: 'element:add', element, sessionId: this.sessionId });
  }

  async broadcastElementUpdate(elementId: string, changes: any): Promise<void> {
    this.send({ type: 'element:update', elementId, changes, sessionId: this.sessionId });
  }

  async broadcastElementDelete(elementId: string): Promise<void> {
    this.send({ type: 'element:delete', elementId, sessionId: this.sessionId });
  }

  async broadcastBatchChange(batch: WhiteboardBatchChange): Promise<void> {
    this.send({ type: 'element:batch', ...batch, sessionId: this.sessionId });
  }

  // ---- Cursor (throttled) ----

  broadcastCursor(x: number, y: number, tool?: string): void {
    const now = Date.now();
    if (now - this.lastCursorSend >= this.cursorThrottleMs) {
      this.lastCursorSend = now;
      this.send({ type: 'cursor:move', x, y, tool });
      this.pendingCursor = null;
    } else {
      this.pendingCursor = { x, y, tool };
      if (!this.cursorTimeout) {
        this.cursorTimeout = setTimeout(() => {
          this.cursorTimeout = null;
          if (this.pendingCursor) {
            this.lastCursorSend = Date.now();
            this.send({ type: 'cursor:move', ...this.pendingCursor });
            this.pendingCursor = null;
          }
        }, this.cursorThrottleMs);
      }
    }
  }

  // ---- Selection ----

  async broadcastSelectionChange(elementIds: string[]): Promise<void> {
    this.send({ type: 'selection:change', elementIds });
  }

  // ---- Event Handlers ----

  onElementAdd(handler: (element: any, userId: string) => void): () => void {
    return this.addHandler('element:add', handler);
  }

  onElementUpdate(handler: (elementId: string, changes: any, userId: string) => void): () => void {
    return this.addHandler('element:update', handler);
  }

  onElementDelete(handler: (elementId: string, userId: string) => void): () => void {
    return this.addHandler('element:delete', handler);
  }

  onBatchChange(handler: (batch: WhiteboardBatchChange & { userId: string }) => void): () => void {
    return this.addHandler('element:batch', handler);
  }

  // ---- Presence ----

  onPresence(handler: (members: WhiteboardPresenceMember[]) => void): () => void {
    this.presenceHandlers.add(handler);
    handler(this._presence);
    return () => this.presenceHandlers.delete(handler);
  }

  get presence(): WhiteboardPresenceMember[] {
    return this._presence;
  }

  // ---- Cursors ----

  onCursors(handler: (cursors: WhiteboardCursor[]) => void): () => void {
    this.cursorHandlers.add(handler);
    handler(Array.from(this._cursors.values()));
    return () => this.cursorHandlers.delete(handler);
  }

  get cursors(): WhiteboardCursor[] {
    return Array.from(this._cursors.values());
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
      console.warn('[Whiteboard] Server error:', msg.code, msg.message);
      return;
    }

    switch (msg.type) {
      case 'element:add': {
        const handlers = this.eventHandlers.get('element:add');
        handlers?.forEach(h => h(msg.element, msg.userId));
        break;
      }
      case 'element:update': {
        const handlers = this.eventHandlers.get('element:update');
        handlers?.forEach(h => h(msg.elementId, msg.changes, msg.userId));
        break;
      }
      case 'element:delete': {
        const handlers = this.eventHandlers.get('element:delete');
        handlers?.forEach(h => h(msg.elementId, msg.userId));
        break;
      }
      case 'element:batch': {
        const handlers = this.eventHandlers.get('element:batch');
        handlers?.forEach(h => h(msg));
        break;
      }
      case 'cursor:move': {
        this._cursors.set(msg.userId, { userId: msg.userId, x: msg.x, y: msg.y, tool: msg.tool });
        this.notifyCursors();
        break;
      }
      case 'selection:change': {
        // Could track remote selections if needed
        break;
      }
      case 'presence:join': {
        const member = msg.member as WhiteboardPresenceMember;
        this._presence = [...this._presence.filter(m => m.sessionId !== member.sessionId), member];
        this.notifyPresence();
        break;
      }
      case 'presence:leave': {
        this._presence = this._presence.filter(m => m.sessionId !== msg.sessionId);
        this._cursors.delete(msg.userId);
        this.notifyPresence();
        this.notifyCursors();
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

  private notifyCursors(): void {
    const cursors = Array.from(this._cursors.values());
    for (const h of this.cursorHandlers) { try { h(cursors); } catch { /* */ } }
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
