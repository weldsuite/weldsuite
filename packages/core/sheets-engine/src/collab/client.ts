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
 * workbook converges even where transforms are not symmetric.
 */

import { Engine, type EngineOptions } from '../calc/engine';
import type { WorkbookSnapshot } from '../model/workbook';
import { applyOp } from '../ops/apply';
import { transform } from '../ops/transform';
import { normalize, type Op } from '../ops/types';
import type { ClientMessage, CommittedOp, Peer, Presence, ServerMessage } from './protocol';

interface Unacked {
  op: Op;
  inverse: Op;
}

export interface CollabClientOptions {
  send: (msg: ClientMessage) => void;
  engine?: EngineOptions;
  /**
   * The workbook was (re)loaded from a snapshot (first load, a resync) or
   * rolled back to the room's state (a rejected batch; same engine).
   * `lostEdits` is true when unacked local edits were dropped.
   */
  onReset?: (engine: Engine, info: { canEdit: boolean; lostEdits: boolean }) => void;
  /**
   * Someone else's op was applied under our own unacked edits. `op` is that
   * op as it applies after them (the current local state), which is what an
   * undo stack is transformed against.
   */
  onRemoteOp?: (op: Op) => void;
  /** Our batch was committed. */
  onAck?: (revision: number) => void;
  onPeers?: (peers: Peer[]) => void;
  /**
   * Prefix that makes this client's batch ids unique in the room (it survives
   * reconnects, which get a new client id). The platform passes a random id.
   */
  sessionId: string;
}

export class CollabClient {
  engine: Engine | null = null;
  clientId = '';
  revision = 0;
  canEdit = false;
  private inflight: { batchId: string; ops: Unacked[] } | null = null;
  private buffer: Unacked[] = [];
  private readonly peers = new Map<string, Peer>();
  private batchCounter = 0;

  constructor(private readonly options: CollabClientOptions) {}

  /** Edits not yet confirmed by the room (show "saving…" while this is true). */
  get hasPending(): boolean {
    return this.inflight !== null || this.buffer.length > 0;
  }

  /** Call when the socket (re)opens. */
  start(): void {
    this.options.send({ type: 'hello', revision: this.engine ? this.revision : null });
  }

  /** Applies a local edit and queues it for the room. Returns its inverse (for undo). */
  apply(op: Op): Op {
    if (!this.engine) throw new Error('Not connected');
    const normalized = normalize(op);
    const inverse = applyOp(this.engine, normalized);
    this.buffer.push({ op: normalized, inverse });
    this.flush();
    return inverse;
  }

  setPresence(presence: Presence | null): void {
    this.options.send({ type: 'presence', presence });
  }

  receive(msg: ServerMessage): void {
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

  peerList(): Peer[] {
    return [...this.peers.values()];
  }

  private welcome(msg: Extract<ServerMessage, { type: 'welcome' }>): void {
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

  private reset(snapshot: WorkbookSnapshot, revision: number, lostEdits: boolean): void {
    this.engine = Engine.fromSnapshot(snapshot, this.options.engine);
    this.revision = revision;
    this.inflight = null;
    this.buffer = [];
    this.options.onReset?.(this.engine, { canEdit: this.canEdit, lostEdits });
  }

  /**
   * The room refused our batch. Every unconfirmed edit goes (later ones were
   * made on top of it), which leaves exactly the room's state at our revision.
   * A resync usually follows; when the room is being rebuilt instead, the
   * reconnect catches up from here.
   */
  private rollBack(batchId: string): void {
    const engine = this.engine;
    if (!engine || this.inflight?.batchId !== batchId) return;
    const pending = [...this.inflight.ops, ...this.buffer];
    for (let i = pending.length - 1; i >= 0; i--) applyOp(engine, pending[i]!.inverse);
    this.inflight = null;
    this.buffer = [];
    this.options.onReset?.(engine, { canEdit: this.canEdit, lostEdits: true });
  }

  private ack(batchId: string, revision: number): void {
    if (!this.inflight || this.inflight.batchId !== batchId) return;
    this.revision = revision;
    this.inflight = null;
    this.options.onAck?.(revision);
    this.flush();
  }

  private remote(c: CommittedOp): void {
    const engine = this.engine;
    if (!engine || c.revision !== this.revision + 1) return;
    const pending = [...(this.inflight?.ops ?? []), ...this.buffer];
    for (let i = pending.length - 1; i >= 0; i--) applyOp(engine, pending[i]!.inverse);
    applyOp(engine, c.op);
    this.revision = c.revision;

    // Put our edits back as the room will transform them.
    let against = c.op;
    const rebased = pending.map((p) => {
      const op = transform(p.op, against, true);
      against = transform(against, p.op, false);
      return { op, inverse: applyOp(engine, op) };
    });
    const inflightCount = this.inflight?.ops.length ?? 0;
    if (this.inflight) this.inflight = { batchId: this.inflight.batchId, ops: rebased.slice(0, inflightCount) };
    this.buffer = rebased.slice(inflightCount);
    this.options.onRemoteOp?.(against);
  }

  private flush(): void {
    if (this.inflight || this.buffer.length === 0 || !this.engine) return;
    this.inflight = { batchId: this.nextBatchId(), ops: this.buffer };
    this.buffer = [];
    this.send(this.inflight);
  }

  private send(batch: { batchId: string; ops: Unacked[] }): void {
    const op = normalize({ type: 'batch', ops: batch.ops.map((u) => u.op) });
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
