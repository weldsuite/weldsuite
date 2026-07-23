import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../lib/protocol';
import { AUTH_HEADERS } from '../lib/protocol';
import type { PresenceMember } from '@weldsuite/realtime/types';

/**
 * ChatRoom Durable Object
 *
 * One instance per WeldChat channel or DM. Handles bidirectional
 * messaging, reactions, pins, typing indicators, presence, and calls.
 *
 * Uses the WebSocket Hibernation API for efficient idle handling.
 */
export class ChatRoom extends DurableObject<Env> {
  private presence = new Map<string, PresenceMember>();
  private typingTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private messageSeq = -1; // -1 means not yet loaded

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair('{"type":"ping"}', '{"type":"pong"}'),
    );
  }

  private async getSeq(): Promise<number> {
    if (this.messageSeq === -1) {
      this.messageSeq = (await this.ctx.storage.get<number>('messageSeq')) ?? 0;
    }
    return this.messageSeq;
  }

  private async nextSeq(): Promise<number> {
    const seq = (await this.getSeq()) + 1;
    this.messageSeq = seq;
    await this.ctx.storage.put('messageSeq', seq);
    return seq;
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
    const userName = this.getTag(tags, 'name:');

    switch (msg.type) {
      case 'message': {
        const seq = await this.nextSeq();
        const outMsg = JSON.stringify({
          type: 'message',
          id: crypto.randomUUID(),
          content: msg.content,
          senderId: userId,
          senderName: userName,
          ts: Date.now(),
          seq,
          threadId: msg.threadId ?? undefined,
          attachments: msg.attachments ?? undefined,
        });
        this.broadcastExcept(ws, outMsg);
        break;
      }

      case 'reaction:add': {
        this.broadcastExcept(
          ws,
          JSON.stringify({
            type: 'reaction',
            messageId: msg.messageId,
            emoji: msg.emoji,
            userId,
            action: 'add',
          }),
        );
        break;
      }

      case 'reaction:remove': {
        this.broadcastExcept(
          ws,
          JSON.stringify({
            type: 'reaction',
            messageId: msg.messageId,
            emoji: msg.emoji,
            userId,
            action: 'remove',
          }),
        );
        break;
      }

      case 'typing:start': {
        this.broadcastExcept(
          ws,
          JSON.stringify({ type: 'typing', userId, userName, isTyping: true }),
        );
        this.clearTypingTimer(userId);
        this.typingTimers.set(
          userId,
          setTimeout(() => {
            this.typingTimers.delete(userId);
            this.broadcastAll(
              JSON.stringify({ type: 'typing', userId, userName, isTyping: false }),
            );
          }, 5000),
        );
        break;
      }

      case 'typing:stop': {
        this.clearTypingTimer(userId);
        this.broadcastExcept(
          ws,
          JSON.stringify({ type: 'typing', userId, userName, isTyping: false }),
        );
        break;
      }

      case 'presence:enter': {
        const member: PresenceMember = {
          userId,
          userName,
          data: (msg.data as Record<string, unknown>) ?? {},
        };
        this.presence.set(userId, member);
        this.broadcastExcept(ws, JSON.stringify({ type: 'presence:join', member }));
        break;
      }

      case 'presence:leave': {
        this.presence.delete(userId);
        this.broadcastExcept(ws, JSON.stringify({ type: 'presence:leave', userId }));
        break;
      }

      case 'call:hand-raised': {
        this.broadcastExcept(ws, JSON.stringify({ type: 'call:hand-raised', userId }));
        break;
      }

      case 'call:hand-lowered': {
        this.broadcastExcept(ws, JSON.stringify({ type: 'call:hand-lowered', userId }));
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

    if (userId && this.presence.has(userId)) {
      this.presence.delete(userId);
      this.broadcastAll(JSON.stringify({ type: 'presence:leave', userId }));
    }

    if (userId) {
      this.clearTypingTimer(userId);
    }

    ws.close(code, reason);
  }

  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    console.error('[ChatRoom] WebSocket error:', error);
    const tags = this.ctx.getTags(ws);
    const userId = this.getTag(tags, 'user:');
    if (userId) {
      this.presence.delete(userId);
      this.clearTypingTimer(userId);
    }
    ws.close(1011, 'Internal error');
  }

  // ---- Internal ----

  private async handleWebSocketUpgrade(request: Request): Promise<Response> {
    const userId = request.headers.get(AUTH_HEADERS.USER_ID) || 'unknown';
    const userName = request.headers.get(AUTH_HEADERS.USER_NAME) || 'Unknown';
    const role = request.headers.get(AUTH_HEADERS.ROLE) || 'member';
    const canPublish = request.headers.get(AUTH_HEADERS.CAN_PUBLISH) === 'true';

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    this.ctx.acceptWebSocket(server, [
      `user:${userId}`,
      `name:${userName}`,
      `role:${role}`,
      canPublish ? 'can:publish' : 'can:subscribe',
    ]);

    const lastSeq = await this.getSeq();
    server.send(
      JSON.stringify({
        type: 'connected',
        connectionId: crypto.randomUUID(),
        presence: Array.from(this.presence.values()),
        lastSeq,
      }),
    );

    return new Response(null, { status: 101, webSocket: client });
  }

  private async handlePublish(request: Request): Promise<Response> {
    const payload = (await request.json()) as Record<string, unknown>;

    // Assign a sequence number to message events for gap detection
    if (payload.type === 'message') {
      payload.seq = await this.nextSeq();
    }

    this.broadcastAll(JSON.stringify(payload));
    return new Response('ok');
  }

  private broadcastAll(msg: string): void {
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(msg);
      } catch {
        // WebSocket closed
      }
    }
  }

  private broadcastExcept(exclude: WebSocket, msg: string): void {
    for (const ws of this.ctx.getWebSockets()) {
      if (ws !== exclude) {
        try {
          ws.send(msg);
        } catch {
          // WebSocket closed
        }
      }
    }
  }

  private getTag(tags: readonly string[], prefix: string): string {
    for (const tag of tags) {
      if (tag.startsWith(prefix)) return tag.slice(prefix.length);
    }
    return '';
  }

  private clearTypingTimer(userId: string): void {
    const timer = this.typingTimers.get(userId);
    if (timer) {
      clearTimeout(timer);
      this.typingTimers.delete(userId);
    }
  }
}
