/**
 * The browser half of co-editing, without any I/O (the platform wires `send`
 * to a WebSocket and calls `receive` with what arrives).
 *
 * Local edits apply at once. They go to the room as one batch at a time: the
 * batch in flight, plus a buffer of edits made since it was sent. When
 * someone else's op arrives the client rebases: it takes its own unacked
 * edits off (their inverses), applies the incoming op, and puts its edits
 * back transformed exactly as the room will transform them when they arrive.
 * Every replica therefore runs the same ops in the same order, and the
 * document converges even where transforms are not symmetric.
 */

import type { OtAdapter } from './adapter';
import type { ClientMessage, CommittedOp, Peer, ServerMessage } from './protocol';

interface Unacked<Op> {
  op: Op;
  inverse: Op;
}

export interface CollabClientOptions<State, Op, Presence> {
  send: (msg: ClientMessage<Op, Presence>) => void;
  /**
   * The document was (re)loaded from a snapshot (first load, a resync) or
   * rolled back to the room's state (a rejected batch; same state object).
   * `lostEdits` is true when unacked local edits were dropped.
   */
  onReset?: (state: State, info: { canEdit: boolean; lostEdits: boolean }) => void;
  /**
   * Someone else's op was applied under our own unacked edits. `op` is that
   * op as it applies after them (the current local state), which is what an
   * undo stack is transformed against.
   */
  onRemoteOp?: (op: Op) => void;
  /** Our batch was committed. */
  onAck?: (revision: number) => void;
  onPeers?: (peers: Peer<Presence>[]) => void;
  /**
   * Prefix that makes this client's batch ids unique in the room (it survives
   * reconnects, which get a new client id). The platform passes a random id.
   */
  sessionId: string;
}

export class CollabClient<State, Op, Snapshot, Presence> {
  /** The local document, null until the room's welcome arrives. */
  state: State | null = null;
  clientId = '';
  revision = 0;
  canEdit = false;
  private inflight: { batchId: string; ops: Unacked<Op>[] } | null = null;
  private buffer: Unacked<Op>[] = [];
  private readonly peers = new Map<string, Peer<Presence>>();
  private batchCounter = 0;

  constructor(
    protected readonly adapter: OtAdapter<State, Op, Snapshot, Presence>,
    protected readonly options: CollabClientOptions<State, Op, Presence>,
  ) {}

  /** Edits not yet confirmed by the room (show "saving…" while this is true). */
  get hasPending(): boolean {
    return this.inflight !== null || this.buffer.length > 0;
  }

  /** Call when the socket (re)opens. */
  start(): void {
    this.options.send({ type: 'hello', revision: this.state ? this.revision : null });
  }

  /** Applies a local edit and queues it for the room. Returns its inverse (for undo). */
  apply(op: Op): Op {
    if (!this.state) throw new Error('Not connected');
    const normalized = this.adapter.normalize(op);
    const inverse = this.adapter.apply(this.state, normalized);
    this.buffer.push({ op: normalized, inverse });
    this.flush();
    return inverse;
  }

  setPresence(presence: Presence | null): void {
    this.options.send({ type: 'presence', presence });
  }

  receive(msg: ServerMessage<Op, Snapshot, Presence>): void {
    switch (msg.type) {
      case 'welcome':
        this.welcome(msg);
        return;
      case 'ack':
        this.ack(msg.batchId, msg.revision);
        return;
      case 'op':
        this.remote(msg);
        return;
      case 'resync':
        // After a reject the edits are already rolled back (and reported) there.
        this.reset(msg.snapshot, msg.revision, this.hasPending);
        return;
      case 'reject':
        this.rollBack(msg.batchId);
        return;
      case 'peerJoined':
        this.peers.set(msg.peer.clientId, msg.peer);
        this.options.onPeers?.(this.peerList());
        return;
      case 'peerLeft':
        this.peers.delete(msg.clientId);
        this.options.onPeers?.(this.peerList());
        return;
      case 'presence':
        this.updatePresence(msg.clientId, msg.presence);
        return;
      case 'pong':
        return;
    }
  }

  peerList(): Peer<Presence>[] {
    return [...this.peers.values()];
  }

  private welcome(msg: Extract<ServerMessage<Op, Snapshot, Presence>, { type: 'welcome' }>): void {
    this.clientId = msg.clientId;
    this.canEdit = msg.canEdit;
    this.peers.clear();
    for (const p of msg.peers) this.peers.set(p.clientId, p);
    this.options.onPeers?.(this.peerList());
    if (msg.snapshot) {
      this.reset(msg.snapshot, msg.revision, this.hasPending);
      return;
    }
    // Reconnect: replay what we missed. Our own batch among it means the ack was lost.
    for (const c of msg.catchUp ?? []) {
      if (this.inflight && c.batchId === this.inflight.batchId) this.ack(c.batchId, c.revision);
      else this.remote(c);
    }
    if (this.inflight) this.send(this.inflight);
    else this.flush();
  }

  private reset(snapshot: Snapshot, revision: number, lostEdits: boolean): void {
    const state = this.adapter.load(snapshot);
    this.state = state;
    this.revision = revision;
    this.inflight = null;
    this.buffer = [];
    this.options.onReset?.(state, { canEdit: this.canEdit, lostEdits });
  }

  /**
   * The room refused our batch. Every unconfirmed edit goes (later ones were
   * made on top of it), which leaves exactly the room's state at our revision.
   * A resync usually follows; when the room is being rebuilt instead, the
   * reconnect catches up from here.
   */
  private rollBack(batchId: string): void {
    const state = this.state;
    if (!state || this.inflight?.batchId !== batchId) return;
    const pending = [...this.inflight.ops, ...this.buffer];
    for (let i = pending.length - 1; i >= 0; i--) this.adapter.apply(state, pending[i]!.inverse);
    this.inflight = null;
    this.buffer = [];
    this.options.onReset?.(state, { canEdit: this.canEdit, lostEdits: true });
  }

  private ack(batchId: string, revision: number): void {
    if (!this.inflight || this.inflight.batchId !== batchId) return;
    this.revision = revision;
    this.inflight = null;
    this.options.onAck?.(revision);
    this.flush();
  }

  private remote(c: CommittedOp<Op>): void {
    const state = this.state;
    if (!state || c.revision !== this.revision + 1) return;
    const pending = [...(this.inflight?.ops ?? []), ...this.buffer];
    for (let i = pending.length - 1; i >= 0; i--) this.adapter.apply(state, pending[i]!.inverse);
    this.adapter.apply(state, c.op);
    this.revision = c.revision;

    // Put our edits back as the room will transform them.
    let against = c.op;
    const rebased = pending.map((p) => {
      const op = this.adapter.transform(p.op, against, true);
      against = this.adapter.transform(against, p.op, false);
      return { op, inverse: this.adapter.apply(state, op) };
    });
    const inflightCount = this.inflight?.ops.length ?? 0;
    if (this.inflight) this.inflight = { batchId: this.inflight.batchId, ops: rebased.slice(0, inflightCount) };
    this.buffer = rebased.slice(inflightCount);
    this.options.onRemoteOp?.(against);
  }

  private flush(): void {
    if (this.inflight || this.buffer.length === 0 || !this.state) return;
    this.inflight = { batchId: this.nextBatchId(), ops: this.buffer };
    this.buffer = [];
    this.send(this.inflight);
  }

  private send(batch: { batchId: string; ops: Unacked<Op>[] }): void {
    const op = this.adapter.normalize(this.adapter.batch(batch.ops.map((u) => u.op)));
    this.options.send({ type: 'submit', batchId: batch.batchId, baseRevision: this.revision, op });
  }

  private nextBatchId(): string {
    this.batchCounter++;
    return `${this.options.sessionId}:${this.batchCounter}`;
  }

  private updatePresence(clientId: string, presence: Presence | null): void {
    const peer = this.peers.get(clientId);
    if (!peer) return;
    if (presence) peer.presence = presence;
    else delete peer.presence;
    this.options.onPeers?.(this.peerList());
  }
}
