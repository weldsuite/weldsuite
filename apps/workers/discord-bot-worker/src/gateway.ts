import {
  GatewayOpcodes,
  GATEWAY_INTENTS,
  GATEWAY_URL,
  NON_RECONNECTABLE_CODES,
} from './lib/constants';

interface Env {
  DISCORD_BOT_TOKEN: string;
  DISCORD_PUBLIC_KEY: string;
  HELPDESK_WIDGET_API_URL: string;
  ENVIRONMENT: string;
}

interface GatewayPayload {
  op: number;
  d: unknown;
  s: number | null;
  t: string | null;
}

interface ReadyEventData {
  session_id: string;
  resume_gateway_url: string;
}

interface MessageCreateData {
  id: string;
  channel_id: string;
  guild_id?: string;
  author: {
    id: string;
    username: string;
    discriminator?: string;
    bot?: boolean;
    avatar?: string;
  };
  content: string;
  timestamp: string;
}

/**
 * DiscordGateway Durable Object
 *
 * Maintains a persistent WebSocket connection to the Discord Gateway.
 * Handles heartbeats via alarms, resume/reconnect on disconnect,
 * and forwards MESSAGE_CREATE events to helpdesk-widget-api.
 */
export class DiscordGateway implements DurableObject {
  private ws: WebSocket | null = null;
  private heartbeatInterval = 0;
  private heartbeatAcked = true;
  private seq: number | null = null;
  private sessionId: string | null = null;
  private resumeGatewayUrl: string | null = null;
  private pendingAction: 'resume' | 'identify' | null = null;

  constructor(
    private state: DurableObjectState,
    private env: Env,
  ) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    switch (url.pathname) {
      case '/connect':
        return this.handleConnect();
      case '/disconnect':
        return this.handleDisconnect();
      case '/status':
        return this.handleStatus();
      default:
        return new Response('Not found', { status: 404 });
    }
  }

  // ============================================================================
  // HTTP handlers
  // ============================================================================

  private async handleConnect(): Promise<Response> {
    // Load persisted session state (survives DO eviction)
    const fatalError = await this.state.storage.get<string>('error');
    if (fatalError) {
      return Response.json(
        { connected: false, error: fatalError },
        { status: 400 },
      );
    }

    // Restore session state from storage
    this.sessionId = (await this.state.storage.get<string>('session_id')) ?? null;
    this.resumeGatewayUrl = (await this.state.storage.get<string>('resume_gateway_url')) ?? null;
    this.seq = (await this.state.storage.get<number>('seq')) ?? null;

    if (this.ws) {
      return Response.json({ message: 'Already connected' });
    }

    this.connectToGateway();
    return Response.json({ message: 'Connecting...' });
  }

  private async handleDisconnect(): Promise<Response> {
    if (this.ws) {
      this.ws.close(1000, 'Manual disconnect');
      this.ws = null;
    }
    // Cancel pending alarm
    await this.state.storage.deleteAlarm();
    return Response.json({ message: 'Disconnected' });
  }

  private async handleStatus(): Promise<Response> {
    const error = (await this.state.storage.get<string>('error')) ?? null;
    return Response.json({
      connected: this.ws !== null,
      sessionId: this.sessionId,
      seq: this.seq,
      error,
    });
  }

  // ============================================================================
  // Gateway connection
  // ============================================================================

  private connectToGateway(): void {
    const url =
      this.resumeGatewayUrl && this.sessionId
        ? `${this.resumeGatewayUrl}/?v=10&encoding=json`
        : GATEWAY_URL;

    console.log(`[Gateway] Connecting to ${url} (resume: ${!!this.sessionId})`);

    this.ws = new WebSocket(url);
    this.heartbeatAcked = true;

    this.ws.addEventListener('message', (event) => {
      this.handleMessage(event.data as string);
    });

    this.ws.addEventListener('close', (event) => {
      this.handleClose(event.code, event.reason);
    });

    this.ws.addEventListener('error', (event) => {
      console.error('[Gateway] WebSocket error:', event);
    });
  }

  // ============================================================================
  // Message handling
  // ============================================================================

  private handleMessage(raw: string): void {
    let payload: GatewayPayload;
    try {
      payload = JSON.parse(raw);
    } catch {
      console.error('[Gateway] Failed to parse message:', raw.substring(0, 200));
      return;
    }

    switch (payload.op) {
      case GatewayOpcodes.HELLO:
        this.handleHello(payload.d as { heartbeat_interval: number });
        break;

      case GatewayOpcodes.HEARTBEAT_ACK:
        this.heartbeatAcked = true;
        break;

      case GatewayOpcodes.HEARTBEAT:
        // Server-requested heartbeat — send immediately
        this.sendHeartbeat();
        break;

      case GatewayOpcodes.RECONNECT:
        console.log('[Gateway] Server requested reconnect');
        this.ws?.close(4000, 'Reconnect requested');
        break;

      case GatewayOpcodes.INVALID_SESSION:
        this.handleInvalidSession(payload.d as boolean);
        break;

      case GatewayOpcodes.DISPATCH:
        this.handleDispatch(payload);
        break;
    }
  }

  private handleHello(data: { heartbeat_interval: number }): void {
    this.heartbeatInterval = data.heartbeat_interval;
    console.log(`[Gateway] HELLO received, heartbeat interval: ${this.heartbeatInterval}ms`);

    // Schedule first heartbeat with jitter
    const jitter = Math.floor(Math.random() * this.heartbeatInterval);
    this.state.storage.setAlarm(Date.now() + jitter);

    // Send IDENTIFY or RESUME
    if (this.sessionId && this.seq !== null) {
      this.sendResume();
    } else {
      this.sendIdentify();
    }
  }

  private handleInvalidSession(resumable: boolean): void {
    console.log(`[Gateway] INVALID_SESSION (resumable: ${resumable})`);

    if (resumable) {
      // Delay 1-5s then resume
      this.pendingAction = 'resume';
    } else {
      // Clear session state, delay 1-5s then re-identify
      this.sessionId = null;
      this.resumeGatewayUrl = null;
      this.seq = null;
      this.state.storage.delete(['session_id', 'resume_gateway_url', 'seq']);
      this.pendingAction = 'identify';
    }

    const delay = 1000 + Math.floor(Math.random() * 4000);
    this.state.storage.setAlarm(Date.now() + delay);
  }

  private handleDispatch(payload: GatewayPayload): void {
    // Update sequence number
    if (payload.s !== null) {
      this.seq = payload.s;
      // Persist seq periodically (every dispatch)
      this.state.storage.put('seq', this.seq);
    }

    switch (payload.t) {
      case 'READY': {
        const data = payload.d as ReadyEventData;
        this.sessionId = data.session_id;
        this.resumeGatewayUrl = data.resume_gateway_url;
        this.state.storage.put({
          session_id: this.sessionId,
          resume_gateway_url: this.resumeGatewayUrl,
        });
        // Clear any previous error
        this.state.storage.delete('error');
        console.log(`[Gateway] READY — session: ${this.sessionId}`);
        break;
      }

      case 'RESUMED':
        console.log('[Gateway] RESUMED successfully');
        this.state.storage.delete('error');
        break;

      case 'MESSAGE_CREATE':
        this.forwardMessage(payload.d as MessageCreateData);
        break;
    }
  }

  // ============================================================================
  // Alarm — heartbeat engine + pending actions
  // ============================================================================

  async alarm(): Promise<void> {
    // Handle pending action from INVALID_SESSION
    if (this.pendingAction) {
      const action = this.pendingAction;
      this.pendingAction = null;

      if (action === 'resume') {
        this.sendResume();
      } else if (action === 'identify') {
        // Need to reconnect fresh if ws was closed
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
          this.connectToGateway();
        } else {
          this.sendIdentify();
        }
      }
      return;
    }

    // If no WebSocket, try to reconnect
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.log('[Gateway] No connection in alarm, reconnecting...');
      this.connectToGateway();
      return;
    }

    // Zombie connection detection
    if (!this.heartbeatAcked) {
      console.warn('[Gateway] Heartbeat not ACKed — zombie connection, reconnecting');
      this.ws.close(4000, 'Zombie connection');
      return; // Close handler will schedule reconnect
    }

    // Send heartbeat
    this.sendHeartbeat();
    this.heartbeatAcked = false;

    // Schedule next heartbeat
    if (this.heartbeatInterval > 0) {
      this.state.storage.setAlarm(Date.now() + this.heartbeatInterval);
    }
  }

  // ============================================================================
  // Send helpers
  // ============================================================================

  private sendHeartbeat(): void {
    this.send({ op: GatewayOpcodes.HEARTBEAT, d: this.seq });
  }

  private sendIdentify(): void {
    console.log('[Gateway] Sending IDENTIFY');
    this.send({
      op: GatewayOpcodes.IDENTIFY,
      d: {
        token: this.env.DISCORD_BOT_TOKEN,
        intents: GATEWAY_INTENTS,
        properties: {
          os: 'cloudflare',
          browser: 'weldsuite',
          device: 'weldsuite',
        },
      },
    });
  }

  private sendResume(): void {
    console.log(`[Gateway] Sending RESUME (session: ${this.sessionId}, seq: ${this.seq})`);
    this.send({
      op: GatewayOpcodes.RESUME,
      d: {
        token: this.env.DISCORD_BOT_TOKEN,
        session_id: this.sessionId,
        seq: this.seq,
      },
    });
  }

  private send(data: Record<string, unknown>): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    }
  }

  // ============================================================================
  // Message forwarding
  // ============================================================================

  private async forwardMessage(data: MessageCreateData): Promise<void> {
    // Skip bot messages to prevent loops
    if (data.author.bot) return;

    // Skip DMs (no guild_id)
    if (!data.guild_id) return;

    const url = `${this.env.HELPDESK_WIDGET_API_URL}/webhook/discord/message`;

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Bot-Secret': this.env.DISCORD_PUBLIC_KEY,
        },
        body: JSON.stringify({
          id: data.id,
          channel_id: data.channel_id,
          guild_id: data.guild_id,
          author: {
            id: data.author.id,
            username: data.author.username,
            discriminator: data.author.discriminator,
            bot: data.author.bot,
            avatar: data.author.avatar,
          },
          content: data.content,
          timestamp: data.timestamp,
        }),
      });

      console.log(
        `[Gateway] Forwarded MESSAGE_CREATE ${data.id} → ${response.status}`,
      );
    } catch (err) {
      console.error(`[Gateway] Failed to forward message ${data.id}:`, err);
    }
  }

  // ============================================================================
  // Close handler
  // ============================================================================

  private handleClose(code: number, reason: string): void {
    console.log(`[Gateway] WebSocket closed: ${code} ${reason}`);
    this.ws = null;

    if (NON_RECONNECTABLE_CODES.includes(code)) {
      const errorMsg = `Fatal close code ${code}: ${reason}`;
      console.error(`[Gateway] ${errorMsg} — will NOT auto-reconnect`);
      this.state.storage.put('error', errorMsg);
      this.state.storage.deleteAlarm();
      return;
    }

    // Schedule reconnect in 5 seconds
    console.log('[Gateway] Scheduling reconnect in 5s...');
    this.state.storage.setAlarm(Date.now() + 5000);
  }
}
