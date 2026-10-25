/**
 * The server half of co-editing, without any I/O: one instance per open
 * document, wrapped by a Durable Object (which owns sockets, persistence and
 * auth) and by tests (which wire it to simulated clients).
 *
 * The room orders all edits. A submitted batch was made against
 * `baseRevision`; the room transforms it past everything committed since,
 * checks it, applies it to its own state, gives it the next revision, acks
 * the sender and forwards the committed op to everyone else. A batch it has
 * already committed (re-sent after a reconnect) is acked again, not applied.
 */

import type { OtAdapter } from './adapter';
import type { ClientMessage, CommittedOp, Peer, RejectReason, ServerMessage } from './protocol';

/** A message for one client, or (to: null) for every client except `except`. */
export interface Outgoing<Op, Snapshot, Presence> {
  to: string | null;
  except?: string;
  msg: ServerMessage<Op, Snapshot, Presence>;
}

export interface RoomOptions<Op, State = unknown, Presence = unknown> {
  /** Committed ops kept for late batches and reconnects; a client further behind gets a snapshot. */
  maxLog?: number;
  /** Called after each commit, before acks go out (the Durable Object persists here). */
  onCommit?: (committed: CommittedOp<Op>) => void;
  /**
   * Whether a peer that may only comment (`canComment`, not `canEdit`) may
   * commit `op`: called with the op as it would be applied (transformed and
   * validated) and the document before it. Without it such a peer is read-only.
   */
  mayComment?: (op: Op, peer: Peer<Presence>, state: State) => boolean;
}

const DEFAULT_MAX_LOG = 2000;

export class RoomCore<State, Op, Snapshot, Presence> {
  /** The document as committed so far. */
  readonly state: State;
  revision: number;
  private readonly log: CommittedOp<Op>[] = [];
  private readonly members = new Map<string, Peer<Presence>>();
  /** Members that have said hello (and so receive broadcasts). */
  private readonly ready = new Set<string>();
  /**
   * An op threw while being applied, after the checks passed (an adapter bug).
   * Its batch was rejected and undone as far as possible, but the document may
   * still be half-changed: the owner must rebuild the room from its last
   * checkpoint and log (the Durable Object drops it and reconnects everyone).
   */
  needsReload = false;

  constructor(
    protected readonly adapter: OtAdapter<State, Op, Snapshot, Presence>,
    snapshot: Snapshot,
    revision: number,
    private readonly options: RoomOptions<Op, State, Presence> = {},
  ) {
    this.state = adapter.load(snapshot);
    this.revision = revision;
  }

  /**
   * A room rebuilt after a Durable Object restart: the snapshot at
   * `snapshotRevision`, then `ops` in revision order. Ops at or before the
   * snapshot are not applied again but go back into the log, so clients a
   * little behind still catch up without a full reload.
   */
  static restore<State, Op, Snapshot, Presence>(
    adapter: OtAdapter<State, Op, Snapshot, Presence>,
    snapshot: Snapshot,
    snapshotRevision: number,
    ops: CommittedOp<Op>[],
    options: RoomOptions<Op, State, Presence> = {},
  ): RoomCore<State, Op, Snapshot, Presence> {
    const room = new RoomCore(adapter, snapshot, snapshotRevision, options);
    room.replay(ops);
    return room;
  }

  /**
   * Brings a room just built from a snapshot up to date with the log that
   * followed it (see `restore`). Throws on a gap in the revisions.
   */
  protected replay(ops: CommittedOp<Op>[]): void {
    for (const c of ops) {
      if (c.revision > this.revision + 1) throw new Error(`Op log has a gap after revision ${this.revision}`);
      if (c.revision > this.revision) {
        this.adapter.apply(this.state, c.op);
        this.revision = c.revision;
      }
      this.remember(c);
    }
  }

  get peers(): Peer<Presence>[] {
    return [...this.members.values()];
  }

  /** Earliest revision a client can continue from without a snapshot. */
  get oldestBase(): number {
    return this.log.length ? this.log[0]!.revision - 1 : this.revision;
  }

  /**
   * A socket connected; nothing is sent until it says hello. `ready` re-admits
   * a client that already said hello on this socket (the Durable Object woke
   * from hibernation with its sockets still open).
   */
  join(peer: Peer<Presence>, ready = false): void {
    this.members.set(peer.clientId, peer);
    if (ready) this.ready.add(peer.clientId);
  }

  leave(clientId: string): Outgoing<Op, Snapshot, Presence>[] {
    if (!this.members.delete(clientId)) return [];
    const wasReady = this.ready.delete(clientId);
    return wasReady ? [{ to: null, except: clientId, msg: { type: 'peerLeft', clientId } }] : [];
  }

  /** Clients that receive broadcasts. */
  isReady(clientId: string): boolean {
    return this.ready.has(clientId);
  }

  receive(clientId: string, msg: ClientMessage<Op, Presence>): Outgoing<Op, Snapshot, Presence>[] {
    const peer = this.members.get(clientId);
    if (!peer) return [];
    switch (msg.type) {
      case 'hello':
        return this.hello(peer, msg.revision);
      case 'ping':
        return [{ to: clientId, msg: { type: 'pong' } }];
      case 'presence':
        return this.presence(peer, msg.presence);
      case 'submit':
        // A room waiting to be rebuilt commits nothing more on a document it no longer trusts.
        return this.ready.has(clientId) && !this.needsReload ? this.submit(peer, msg.batchId, msg.baseRevision, msg.op) : [];
    }
  }

  /**
   * Commits an op the server made itself (a data refresh, an agent's write),
   * made against the current revision: checked, applied and logged like a
   * client's batch, under `clientId`, and sent to every client as someone
   * else's op. `refused` says why it was not committed (the document is then
   * unchanged, unless `needsReload` is set).
   */
  commitServer(
    submitted: Op,
    clientId = 'server',
  ): { out: Outgoing<Op, Snapshot, Presence>[]; committed: CommittedOp<Op> | null; refused?: string } {
    if (this.needsReload) return { out: [], committed: null, refused: 'the room is being rebuilt' };
    if (!this.adapter.isWellFormedOp(submitted)) return { out: [], committed: null, refused: 'malformed op' };
    let op: Op;
    try {
      op = this.adapter.normalize(submitted);
    } catch {
      return { out: [], committed: null, refused: 'malformed op' };
    }
    const invalid = this.adapter.validate(this.state, op);
    if (invalid !== null) return { out: [], committed: null, refused: invalid };
    if (!this.applyAtomically(op)) {
      this.needsReload = true;
      return { out: [], committed: null, refused: 'the op failed to apply' };
    }
    this.revision++;
    const committed: CommittedOp<Op> = { revision: this.revision, op, clientId, batchId: `${clientId}:${this.revision}` };
    this.remember(committed);
    this.options.onCommit?.(committed);
    return { out: [{ to: null, msg: { type: 'op', ...committed } }], committed };
  }

  /** Rejects a batch whose message could not even be read (see `refusedBatchId`), with a resync. */
  refuse(clientId: string, batchId: string): Outgoing<Op, Snapshot, Presence>[] {
    return this.members.has(clientId) ? this.reject(clientId, batchId, 'invalid') : [];
  }

  private hello(peer: Peer<Presence>, since: number | null): Outgoing<Op, Snapshot, Presence>[] {
    const first = !this.ready.has(peer.clientId);
    this.ready.add(peer.clientId);
    const canCatchUp = since !== null && since >= this.oldestBase && since <= this.revision;
    const welcome: ServerMessage<Op, Snapshot, Presence> = {
      type: 'welcome',
      clientId: peer.clientId,
      revision: this.revision,
      peers: this.peers.filter((p) => p.clientId !== peer.clientId && this.ready.has(p.clientId)),
      canEdit: peer.canEdit,
      ...(canCatchUp ? { catchUp: this.log.filter((c) => c.revision > since) } : { snapshot: this.adapter.snapshot(this.state) }),
    };
    const out: Outgoing<Op, Snapshot, Presence>[] = [{ to: peer.clientId, msg: welcome }];
    if (first) out.push({ to: null, except: peer.clientId, msg: { type: 'peerJoined', peer } });
    return out;
  }

  private presence(peer: Peer<Presence>, presence: Presence | null): Outgoing<Op, Snapshot, Presence>[] {
    if (presence) peer.presence = presence;
    else delete peer.presence;
    return [{ to: null, except: peer.clientId, msg: { type: 'presence', clientId: peer.clientId, presence } }];
  }

  private submit(peer: Peer<Presence>, batchId: string, baseRevision: number, submitted: Op): Outgoing<Op, Snapshot, Presence>[] {
    const already = this.log.find((c) => c.batchId === batchId);
    if (already) return [{ to: peer.clientId, msg: { type: 'ack', batchId, revision: already.revision } }];
    const mayComment = !peer.canEdit && peer.canComment ? this.options.mayComment : undefined;
    if (!peer.canEdit && !mayComment) return this.reject(peer.clientId, batchId, 'read-only');
    if (baseRevision > this.revision || baseRevision < this.oldestBase) return this.reject(peer.clientId, batchId, 'stale');

    if (!this.adapter.isWellFormedOp(submitted)) return this.reject(peer.clientId, batchId, 'invalid');
    let op: Op;
    try {
      op = this.adapter.normalize(submitted);
      for (const c of this.log) if (c.revision > baseRevision) op = this.adapter.transform(op, c.op, true);
    } catch {
      return this.reject(peer.clientId, batchId, 'invalid');
    }
    if (this.adapter.validate(this.state, op) !== null) return this.reject(peer.clientId, batchId, 'invalid');
    if (mayComment && !mayComment(op, peer, this.state)) return this.reject(peer.clientId, batchId, 'read-only');
    if (!this.applyAtomically(op)) {
      this.needsReload = true;
      // No resync: the document may be half-changed. The sender takes back its
      // unconfirmed edits on the reject, and catches up once the room is rebuilt.
      return [{ to: peer.clientId, msg: { type: 'reject', batchId, reason: 'invalid' } }];
    }
    this.revision++;
    const committed: CommittedOp<Op> = { revision: this.revision, op, clientId: peer.clientId, batchId };
    this.remember(committed);
    this.options.onCommit?.(committed);

    // Even an op transformed into nothing takes a revision, so everyone's count stays in step.
    return [
      { to: peer.clientId, msg: { type: 'ack', batchId, revision: this.revision } },
      { to: null, except: peer.clientId, msg: { type: 'op', ...committed } },
    ];
  }

  /** Applies a batch op by op; if one throws, those before it are undone. False when that happened. */
  private applyAtomically(op: Op): boolean {
    const ops = this.adapter.unbatch(op);
    const inverses: Op[] = [];
    try {
      for (const o of ops) inverses.push(this.adapter.apply(this.state, o));
      return true;
    } catch {
      try {
        for (let i = inverses.length - 1; i >= 0; i--) this.adapter.apply(this.state, inverses[i]!);
      } catch {
        // needsReload covers a document that could not be put back.
      }
      return false;
    }
  }

  private reject(clientId: string, batchId: string, reason: RejectReason): Outgoing<Op, Snapshot, Presence>[] {
    return [
      { to: clientId, msg: { type: 'reject', batchId, reason } },
      { to: clientId, msg: { type: 'resync', revision: this.revision, snapshot: this.adapter.snapshot(this.state) } },
    ];
  }

  private remember(c: CommittedOp<Op>): void {
    this.log.push(c);
    const max = this.options.maxLog ?? DEFAULT_MAX_LOG;
    if (this.log.length > max) this.log.splice(0, this.log.length - max);
  }
}
