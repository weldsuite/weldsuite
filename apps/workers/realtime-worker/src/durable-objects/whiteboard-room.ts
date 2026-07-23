import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../lib/protocol';
import { AUTH_HEADERS } from '../lib/protocol';

interface WhiteboardPresenceMember {
  userId: string;
  sessionId: string;
  name: string;
  avatar?: string;
  color: string;
}

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
  return PRESENCE_COLORS[Math.abs(hash) % PRESENCE_COLORS.length];
}

/**
 * WhiteboardRoom Durable Object
 *
 * One instance per whiteboard. Handles high-frequency real-time
 * collaboration: element sync, cursor broadcasting, presence, selections.
 *
 * No persistence — the database is the source of truth. This DO is
 * purely a real-time fan-out layer for the active editing session.
 *
 * Uses WebSocket Hibernation API for efficient idle handling.
 * Broadcasts use sessionId exclusion so the sender doesn't echo.
 */
export class WhiteboardRoom extends DurableObject<Env> {
  private presence = new Map<string, WhiteboardPresenceMember>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
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

  // ---- WebSocket Hibernation API ----

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const raw = typeof message === 'string' ? message : new TextDecoder().decode(message);

    let msg: { type: string; [key: string]: unknown };
    try {
      msg = JSON.parse(raw);
    } catch {
      ws.send(JSON.stringify({ type: 'error', code: 'invalid_json', message: 'Invalid JSON' }));
      return;
    }

    const tags = this.ctx.getTags(ws);
    const userId = this.getTag(tags, 'user:');
    const sessionId = this.getTag(tags, 'session:');

    switch (msg.type) {
      case 'element:add':
      case 'element:update':
      case 'element:delete':
      case 'element:batch': {
        // Broadcast element operations to all except sender session
        this.broadcastExceptSession(sessionId, JSON.stringify({
          ...msg,
          userId,
          sessionId,
          ts: Date.now(),
        }));
        break;
      }

      case 'cursor:move': {
        // Lightweight passthrough — no storage, just fan-out
        this.broadcastExceptSession(sessionId, JSON.stringify({
          type: 'cursor:move',
          userId,
          x: msg.x,
          y: msg.y,
          tool: msg.tool,
        }));
        break;
      }

      case 'selection:change': {
        this.broadcastExceptSession(sessionId, JSON.stringify({
          type: 'selection:change',
          userId,
          elementIds: msg.elementIds,
        }));
        break;
      }

      case 'presence:enter': {
        const member: WhiteboardPresenceMember = {
          userId,
          sessionId,
          name: (msg.name as string) || this.getTag(tags, 'name:'),
          avatar: msg.avatar as string | undefined,
          color: colorForUser(userId),
        };
        this.presence.set(sessionId, member);
        this.broadcastExceptSession(sessionId, JSON.stringify({
          type: 'presence:join',
          member,
        }));
        break;
      }

      case 'presence:leave': {
        this.presence.delete(sessionId);
        this.broadcastAll(JSON.stringify({ type: 'presence:leave', userId, sessionId }));
        break;
      }

      case 'ping':
        ws.send('{"type":"pong"}');
        break;
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean): Promise<void> {
    const tags = this.ctx.getTags(ws);
    const userId = this.getTag(tags, 'user:');
    const sessionId = this.getTag(tags, 'session:');

    if (sessionId && this.presence.has(sessionId)) {
      this.presence.delete(sessionId);
      this.broadcastAll(JSON.stringify({ type: 'presence:leave', userId, sessionId }));
    }

    ws.close(code, reason);
  }

  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    console.error('[WhiteboardRoom] WebSocket error:', error);
    const tags = this.ctx.getTags(ws);
    const userId = this.getTag(tags, 'user:');
    const sessionId = this.getTag(tags, 'session:');

    if (sessionId) {
      this.presence.delete(sessionId);
      this.broadcastAll(JSON.stringify({ type: 'presence:leave', userId, sessionId }));
    }
    ws.close(1011, 'Internal error');
  }

  // ---- Internal ----

  private handleWebSocketUpgrade(request: Request): Response {
    const userId = request.headers.get(AUTH_HEADERS.USER_ID) || 'unknown';
    const userName = request.headers.get(AUTH_HEADERS.USER_NAME) || 'Unknown';
    // Client provides a unique session ID per tab
    const sessionId = request.headers.get('x-rt-session-id') || crypto.randomUUID();

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    this.ctx.acceptWebSocket(server, [
      `user:${userId}`,
      `name:${userName}`,
      `session:${sessionId}`,
    ]);

    // Send current presence snapshot
    server.send(JSON.stringify({
      type: 'connected',
      connectionId: crypto.randomUUID(),
      presence: Array.from(this.presence.values()),
    }));

    return new Response(null, { status: 101, webSocket: client });
  }

  private async handlePublish(request: Request): Promise<Response> {
    const payload = await request.json();
    this.broadcastAll(JSON.stringify(payload));
    return new Response('ok');
  }

  private broadcastAll(msg: string): void {
    for (const ws of this.ctx.getWebSockets()) {
      try { ws.send(msg); } catch { /* closed */ }
    }
  }

  private broadcastExceptSession(excludeSessionId: string, msg: string): void {
    for (const ws of this.ctx.getWebSockets()) {
      const tags = this.ctx.getTags(ws);
      const sid = this.getTag(tags, 'session:');
      if (sid === excludeSessionId) continue;
      try { ws.send(msg); } catch { /* closed */ }
    }
  }

  private getTag(tags: readonly string[], prefix: string): string {
    for (const tag of tags) {
      if (tag.startsWith(prefix)) return tag.slice(prefix.length);
    }
    return '';
  }
}
