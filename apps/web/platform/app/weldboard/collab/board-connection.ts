import {
  FrameAssembler,
  createBoardClient,
  decodeServer,
  encode,
  toFrames,
  type Board,
  type BoardClientMessage,
  type BoardPeer,
  type BoardPresence,
  type BoardServerMessage,
  type Op,
} from '@weldsuite/board-engine';
import { isApiError } from '@weldsuite/api-client';

export type ConnectionStatus = 'connecting' | 'open' | 'reconnecting' | 'closed';

export interface ConnectionEvents {
  /** The board (re)loaded from the room: `first` on opening, else a resync. */
  onReset(board: Board, info: { canEdit: boolean; lostEdits: boolean; first: boolean }): void;
  /** Someone else's op, as it applies to the local state. */
  onRemoteOp(op: Op): void;
  onPeers(peers: BoardPeer[]): void;
  /** The connection status or the unconfirmed-edits flag changed. */
  onStatus(): void;
  /** The board is gone, or the caller may no longer open it. */
  onGone(): void;
  onRestored?(info: { versionId: string; userId: string; revision: number }): void;
}

export interface ConnectionOptions {
  /** Asks board-api for a session and returns the room socket URL. */
  openSession(): Promise<string>;
  events: ConnectionEvents;
}

const PING_MS = 25_000;
const FIRST_RETRY_MS = 500;
const MAX_RETRY_MS = 30_000;

/**
 * One open board's live link to its room, as DocConnection is for a
 * document: the socket (opened with a fresh session ticket each time),
 * message framing, the engine's collaboration client on top, and
 * reconnecting with backoff. Edits made while disconnected stay queued and
 * go out after the reconnect.
 */
export class BoardConnection {
  readonly client: ReturnType<typeof createBoardClient>;
  status: ConnectionStatus = 'connecting';
  private socket: WebSocket | null = null;
  private assembler = new FrameAssembler();
  private attempts = 0;
  private stopped = false;
  private loaded = false;
  private frameCounter = 0;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private presence: BoardPresence | null = null;

  constructor(private readonly options: ConnectionOptions) {
    const { events } = options;
    this.client = createBoardClient({
      sessionId: crypto.randomUUID(),
      send: (msg) => this.send(msg),
      onReset: (board, info) => {
        const first = !this.loaded;
        this.loaded = true;
        events.onReset(board, { ...info, first });
      },
      onRemoteOp: (op) => events.onRemoteOp(op),
      onAck: () => events.onStatus(),
      onPeers: (peers) => events.onPeers(peers),
      onRestored: (info) => events.onRestored?.(info),
    });
  }

  get pending(): boolean {
    return this.client.hasPending;
  }

  start(): void {
    void this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.clearTimers();
    const socket = this.socket;
    this.socket = null;
    socket?.close(1000, 'closed');
  }

  apply(op: Op): Op {
    const inverse = this.client.apply(op);
    this.options.events.onStatus();
    return inverse;
  }

  setPresence(presence: BoardPresence | null): void {
    this.presence = presence;
    this.client.setPresence(presence);
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    this.setStatus(this.attempts === 0 ? 'connecting' : 'reconnecting');
    let url: string;
    try {
      url = await this.options.openSession();
    } catch (err) {
      if (isApiError(err) && (err.status === 403 || err.status === 404)) {
        this.stopped = true;
        this.setStatus('closed');
        this.options.events.onGone();
      } else {
        this.retry();
      }
      return;
    }
    if (this.stopped) return;

    const socket = new WebSocket(url);
    this.socket = socket;
    this.assembler = new FrameAssembler();
    socket.onopen = () => {
      this.attempts = 0;
      this.setStatus('open');
      this.client.start();
      if (this.presence) this.client.setPresence(this.presence);
      this.pingTimer = setInterval(() => this.send({ type: 'ping' }), PING_MS);
    };
    socket.onmessage = (event: MessageEvent) => {
      if (typeof event.data !== 'string') return;
      const text = this.assembler.accept(event.data);
      const msg = text === null ? null : (decodeServer(text) as BoardServerMessage | null);
      if (msg) this.client.receive(msg);
    };
    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.clearTimers();
      if (!this.stopped) this.retry();
    };
  }

  private retry(): void {
    this.attempts++;
    this.setStatus('reconnecting');
    const backoff = Math.min(MAX_RETRY_MS, FIRST_RETRY_MS * 2 ** Math.min(this.attempts, 6));
    const [random] = crypto.getRandomValues(new Uint32Array(1));
    this.retryTimer = setTimeout(() => void this.connect(), backoff * (0.5 + random! / 2 ** 33));
  }

  private send(msg: BoardClientMessage): void {
    const socket = this.socket;
    if (socket?.readyState !== WebSocket.OPEN) return;
    for (const frame of toFrames(encode(msg), `c${++this.frameCounter}`)) socket.send(frame);
  }

  private setStatus(status: ConnectionStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.options.events.onStatus();
  }

  private clearTimers(): void {
    if (this.pingTimer !== null) clearInterval(this.pingTimer);
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    this.pingTimer = null;
    this.retryTimer = null;
  }
}
