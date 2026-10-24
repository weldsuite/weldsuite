/**
 * The co-editing protocol between a browser and a document's room (a Durable
 * Object such as SheetRoom). JSON over one WebSocket per open document.
 *
 * Every committed change is one op with the next revision. A client keeps at
 * most one batch in flight: it sends its local ops with the revision they were
 * made against, waits for the ack, and meanwhile collects new local ops into
 * the next batch. See room.ts and client.ts for the two halves.
 *
 * The message shapes are generic over the document's op, snapshot and
 * presence types; what those look like is the adapter's business (adapter.ts).
 */

import type { OtAdapter } from './adapter';

export interface Peer<Presence> {
  clientId: string;
  userId: string;
  name: string;
  /** Avatar URL, when they have one. */
  picture?: string | null;
  color: string;
  /** Can change the document; viewers only watch. */
  canEdit: boolean;
  /** Where they are in the document. Never persisted. */
  presence?: Presence;
}

/** A committed batch as the room logged it. */
export interface CommittedOp<Op> {
  revision: number;
  op: Op;
  clientId: string;
  batchId: string;
}

export type ClientMessage<Op, Presence> =
  /**
   * First message on a connection. `revision` is the state the client already
   * has (a reconnect), or null for a fresh load.
   */
  | { type: 'hello'; revision: number | null }
  /** Local ops made against `baseRevision`, as one atomic batch. */
  | { type: 'submit'; batchId: string; baseRevision: number; op: Op }
  | { type: 'presence'; presence: Presence | null }
  | { type: 'ping' };

export type ServerMessage<Op, Snapshot, Presence> =
  /**
   * Reply to hello: who else is here, and either the document as of
   * `revision` (`snapshot`) or, for a reconnect, the batches committed since
   * the client's revision (`catchUp`, its own included).
   */
  | {
      type: 'welcome';
      clientId: string;
      revision: number;
      peers: Peer<Presence>[];
      canEdit: boolean;
      snapshot?: Snapshot;
      catchUp?: CommittedOp<Op>[];
    }
  /** The sender's batch was committed as `revision`. */
  | { type: 'ack'; batchId: string; revision: number }
  /** Someone else's batch, committed as `revision`, already transformed to apply on `revision - 1`. */
  | ({ type: 'op' } & CommittedOp<Op>)
  | { type: 'peerJoined'; peer: Peer<Presence> }
  | { type: 'peerLeft'; clientId: string }
  | { type: 'presence'; clientId: string; presence: Presence | null }
  /** The batch could not be applied; the client must reload from the snapshot that follows. */
  | { type: 'reject'; batchId: string; reason: RejectReason }
  /** Start over from this state (after a reject, or when the client is too far behind). */
  | { type: 'resync'; revision: number; snapshot: Snapshot }
  | { type: 'pong' };

export type RejectReason = 'read-only' | 'stale' | 'invalid';

/** The part of an adapter `decodeClient` needs: shape checks for untrusted ops and presence. */
export type ShapeChecks<Op, Presence> = Pick<OtAdapter<unknown, Op, unknown, Presence>, 'isWellFormedOp' | 'isPresence'>;

export function encode<Op, Snapshot, Presence>(msg: ClientMessage<Op, Presence> | ServerMessage<Op, Snapshot, Presence>): string {
  return JSON.stringify(msg);
}

/**
 * A client message parsed from the socket, or null when it is not one. The
 * room trusts nothing a browser sends: every field is checked, ops all the
 * way down (`isWellFormedOp`), so applying one cannot throw halfway.
 */
export function decodeClient<Op, Presence>(data: string, checks: ShapeChecks<Op, Presence>): ClientMessage<Op, Presence> | null {
  const msg = decode(data, CLIENT_TYPES) as Record<string, unknown> | null;
  return msg && isClientMessage(msg, checks) ? (msg as unknown as ClientMessage<Op, Presence>) : null;
}

/**
 * The batch id of a submit `decodeClient` refused, so the room can reject
 * that batch instead of leaving the sender waiting for a reply.
 */
export function refusedBatchId(data: string): string | null {
  const msg = decode(data, CLIENT_TYPES) as { type: string; batchId?: unknown } | null;
  return msg?.type === 'submit' && isText(msg.batchId, MAX_BATCH_ID) ? (msg.batchId as string) : null;
}

/** A server message parsed from the socket, or null when it is not one. The client trusts its room, so only the type is checked. */
export function decodeServer<Op, Snapshot, Presence>(data: string): ServerMessage<Op, Snapshot, Presence> | null {
  return decode(data, SERVER_TYPES) as ServerMessage<Op, Snapshot, Presence> | null;
}

/**
 * Longest WebSocket message either side sends. Cloudflare refuses messages
 * over 1 MiB, and a document snapshot or a large paste can be far bigger, so
 * a longer message goes as numbered parts that the receiver joins again.
 */
export const MAX_FRAME = 256 * 1024;

/** The frames to send for one encoded message: the message itself, or its parts. */
export function toFrames(text: string, id: string, max = MAX_FRAME): string[] {
  if (text.length <= max) return [text];
  const count = Math.ceil(text.length / max);
  const frames: string[] = [];
  for (let index = 0; index < count; index++) {
    // Same key order every time: FrameAssembler recognises parts by this prefix.
    frames.push(JSON.stringify({ type: 'part', id, index, count, data: text.slice(index * max, (index + 1) * max) }));
  }
  return frames;
}

const PART_PREFIX = '{"type":"part"';

/** Joins the parts `toFrames` produced. One per connection. */
export class FrameAssembler {
  private readonly pending = new Map<string, string[]>();

  /** @param maxParts Parts one message may have; more is treated as garbage. */
  constructor(private readonly maxParts = 512) {}

  /** The text of a whole message, or null while its parts are still arriving (or the frame is bad). */
  accept(frame: string): string | null {
    if (!frame.startsWith(PART_PREFIX)) return frame;
    let part: { id: string; index: number; count: number; data: string };
    try {
      part = JSON.parse(frame) as typeof part;
    } catch {
      return null;
    }
    const { id, index, count, data } = part;
    if (!Number.isInteger(count) || count < 1 || count > this.maxParts || !Number.isInteger(index) || index < 0 || index >= count) {
      return null;
    }
    let parts = this.pending.get(id);
    if (!parts) {
      // Parts of one message arrive back to back; anything older was abandoned.
      this.pending.clear();
      parts = [];
      this.pending.set(id, parts);
    }
    parts[index] = data;
    if (parts.filter((p) => p !== undefined).length < count) return null;
    this.pending.delete(id);
    return parts.join('');
  }
}

const CLIENT_TYPES = new Set(['hello', 'submit', 'presence', 'ping']);
const SERVER_TYPES = new Set(['welcome', 'ack', 'op', 'peerJoined', 'peerLeft', 'presence', 'reject', 'resync', 'pong']);

const MAX_BATCH_ID = 200;

function isClientMessage<Op, Presence>(msg: Record<string, unknown>, checks: ShapeChecks<Op, Presence>): boolean {
  switch (msg.type) {
    case 'hello':
      return msg.revision === null || isCount(msg.revision);
    case 'submit':
      return isText(msg.batchId, MAX_BATCH_ID) && isCount(msg.baseRevision) && checks.isWellFormedOp(msg.op);
    case 'presence':
      return msg.presence === null || checks.isPresence(msg.presence);
    default:
      return true;
  }
}

function isCount(v: unknown): boolean {
  return Number.isInteger(v) && (v as number) >= 0;
}

function isText(v: unknown, max: number): boolean {
  return typeof v === 'string' && v.length > 0 && v.length <= max;
}

function decode(data: string, types: Set<string>): { type: string } | null {
  try {
    const msg = JSON.parse(data) as { type?: unknown };
    return typeof msg === 'object' && msg !== null && typeof msg.type === 'string' && types.has(msg.type)
      ? (msg as { type: string })
      : null;
  } catch {
    return null;
  }
}
