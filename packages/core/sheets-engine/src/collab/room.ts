/**
 * The server half of co-editing, without any I/O: one instance per open
 * spreadsheet, wrapped by the SheetRoom Durable Object (which owns sockets,
 * persistence and auth) and by tests (which wire it to simulated clients).
 *
 * The room orders all edits. A submitted batch was made against
 * `baseRevision`; the room transforms it past everything committed since,
 * checks it, applies it to its own engine, gives it the next revision, acks
 * the sender and forwards the committed op to everyone else. A batch it has
 * already committed (re-sent after a reconnect) is acked again, not applied.
 */

import { Engine, type EngineOptions } from '../calc/engine';
import type { WorkbookSnapshot } from '../model/workbook';
import { applyOp } from '../ops/apply';
import { transform } from '../ops/transform';
import { normalize, type Op } from '../ops/types';
import { validateOp } from '../ops/validate';
import type { ClientMessage, CommittedOp, Peer, Presence, RejectReason, ServerMessage } from './protocol';

/** A message for one client, or (to: null) for every client except `except`. */
export interface Outgoing {
  to: string | null;
  except?: string;
  msg: ServerMessage;
}

export interface RoomOptions {
  /** Committed ops kept for late batches and reconnects; a client further behind gets a snapshot. */
  maxLog?: number;
  engine?: EngineOptions;
  /** Called after each commit, before acks go out (the Durable Object persists here). */
  onCommit?: (committed: CommittedOp) => void;
}

const DEFAULT_MAX_LOG = 2000;

export class RoomCore {
  readonly engine: Engine;
  revision: number;
  private readonly log: CommittedOp[] = [];
  private readonly members = new Map<string, Peer>();
  /** Members that have said hello (and so receive broadcasts). */
  private readonly ready = new Set<string>();

  constructor(
    snapshot: WorkbookSnapshot,
    revision: number,
    private readonly options: RoomOptions = {},
  ) {
    this.engine = Engine.fromSnapshot(snapshot, options.engine);
    this.revision = revision;
  }

  /**
   * A room rebuilt after a Durable Object restart: the snapshot at
   * `snapshotRevision`, then `ops` in revision order. Ops at or before the
   * snapshot are not applied again but go back into the log, so clients a
   * little behind still catch up without a full reload.
   */
  static restore(snapshot: WorkbookSnapshot, snapshotRevision: number, ops: CommittedOp[], options: RoomOptions = {}): RoomCore {
    const room = new RoomCore(snapshot, snapshotRevision, { ...options, onCommit: undefined });
    for (const c of ops) {
      if (c.revision > room.revision + 1) throw new Error(`Op log has a gap after revision ${room.revision}`);
      if (c.revision > room.revision) {
        applyOp(room.engine, c.op);
        room.revision = c.revision;
      }
      room.remember(c);
    }
    room.options.onCommit = options.onCommit;
    return room;
  }

  get peers(): Peer[] {
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
  join(peer: Peer, ready = false): void {
    this.members.set(peer.clientId, peer);
    if (ready) this.ready.add(peer.clientId);
  }

  leave(clientId: string): Outgoing[] {
    if (!this.members.delete(clientId)) return [];
    const wasReady = this.ready.delete(clientId);
    return wasReady ? [{ to: null, except: clientId, msg: { type: 'peerLeft', clientId } }] : [];
  }

  /** Clients that receive broadcasts. */
  isReady(clientId: string): boolean {
    return this.ready.has(clientId);
  }

  receive(clientId: string, msg: ClientMessage): Outgoing[] {
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
        return this.ready.has(clientId) ? this.submit(peer, msg.batchId, msg.baseRevision, msg.op) : [];
    }
  }

  private hello(peer: Peer, since: number | null): Outgoing[] {
    const first = !this.ready.has(peer.clientId);
    this.ready.add(peer.clientId);
    const canCatchUp = since !== null && since >= this.oldestBase && since <= this.revision;
    const welcome: ServerMessage = {
      type: 'welcome',
      clientId: peer.clientId,
      revision: this.revision,
      peers: this.peers.filter((p) => p.clientId !== peer.clientId && this.ready.has(p.clientId)),
      canEdit: peer.canEdit,
      ...(canCatchUp ? { catchUp: this.log.filter((c) => c.revision > since) } : { snapshot: this.engine.toSnapshot() }),
    };
    const out: Outgoing[] = [{ to: peer.clientId, msg: welcome }];
    if (first) out.push({ to: null, except: peer.clientId, msg: { type: 'peerJoined', peer } });
    return out;
  }

  private presence(peer: Peer, presence: Presence | null): Outgoing[] {
    if (presence) peer.presence = presence;
    else delete peer.presence;
    return [{ to: null, except: peer.clientId, msg: { type: 'presence', clientId: peer.clientId, presence } }];
  }

  private submit(peer: Peer, batchId: string, baseRevision: number, submitted: Op): Outgoing[] {
    const already = this.log.find((c) => c.batchId === batchId);
    if (already) return [{ to: peer.clientId, msg: { type: 'ack', batchId, revision: already.revision } }];
    if (!peer.canEdit) return this.reject(peer.clientId, batchId, 'read-only');
    if (baseRevision > this.revision || baseRevision < this.oldestBase) return this.reject(peer.clientId, batchId, 'stale');

    let op = normalize(submitted);
    for (const c of this.log) if (c.revision > baseRevision) op = transform(op, c.op, true);
    if (validateOp(this.engine.workbook, op) !== null) return this.reject(peer.clientId, batchId, 'invalid');

    applyOp(this.engine, op);
    this.revision++;
    const committed: CommittedOp = { revision: this.revision, op, clientId: peer.clientId, batchId };
    this.remember(committed);
    this.options.onCommit?.(committed);

    // Even an op transformed into nothing takes a revision, so everyone's count stays in step.
    return [
      { to: peer.clientId, msg: { type: 'ack', batchId, revision: this.revision } },
      { to: null, except: peer.clientId, msg: { type: 'op', ...committed } },
    ];
  }

  private reject(clientId: string, batchId: string, reason: RejectReason): Outgoing[] {
    return [
      { to: clientId, msg: { type: 'reject', batchId, reason } },
      { to: clientId, msg: { type: 'resync', revision: this.revision, snapshot: this.engine.toSnapshot() } },
    ];
  }

  private remember(c: CommittedOp): void {
    this.log.push(c);
    const max = this.options.maxLog ?? DEFAULT_MAX_LOG;
    if (this.log.length > max) this.log.splice(0, this.log.length - max);
  }
}
