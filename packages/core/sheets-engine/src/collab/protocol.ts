/**
 * The co-editing protocol between a browser and a sheet's room (the SheetRoom
 * Durable Object). JSON over one WebSocket per open spreadsheet.
 *
 * Every committed change is one op with the next revision. A client keeps at
 * most one batch in flight: it sends its local ops with the revision they were
 * made against, waits for the ack, and meanwhile collects new local ops into
 * the next batch. See room.ts and client.ts for the two halves.
 */

import type { Range } from '../address';
import type { WorkbookSnapshot } from '../model/workbook';
import type { Op } from '../ops/types';

/** Where someone is in the workbook, shown to everyone else. Never persisted. */
export interface Presence {
  sheetId: string;
  active: { row: number; col: number };
  ranges: Range[];
  /** True while they are typing into the active cell. */
  editing?: boolean;
}

export interface Peer {
  clientId: string;
  userId: string;
  name: string;
  /** Avatar URL, when they have one. */
  picture?: string | null;
  color: string;
  /** Can change the workbook; viewers only watch. */
  canEdit: boolean;
  presence?: Presence;
}

/** A committed batch as the room logged it. */
export interface CommittedOp {
  revision: number;
  op: Op;
  clientId: string;
  batchId: string;
}

export type ClientMessage =
  /**
   * First message on a connection. `revision` is the state the client already
   * has (a reconnect), or null for a fresh load.
   */
  | { type: 'hello'; revision: number | null }
  /** Local ops made against `baseRevision`, as one atomic batch. */
  | { type: 'submit'; batchId: string; baseRevision: number; op: Op }
  | { type: 'presence'; presence: Presence | null }
  | { type: 'ping' };

export type ServerMessage =
  /**
   * Reply to hello: who else is here, and either the workbook as of
   * `revision` (`snapshot`) or, for a reconnect, the batches committed since
   * the client's revision (`catchUp`, its own included).
   */
  | {
      type: 'welcome';
      clientId: string;
      revision: number;
      peers: Peer[];
      canEdit: boolean;
      snapshot?: WorkbookSnapshot;
      catchUp?: CommittedOp[];
    }
  /** The sender's batch was committed as `revision`. */
  | { type: 'ack'; batchId: string; revision: number }
  /** Someone else's batch, committed as `revision`, already transformed to apply on `revision - 1`. */
  | ({ type: 'op' } & CommittedOp)
  | { type: 'peerJoined'; peer: Peer }
  | { type: 'peerLeft'; clientId: string }
  | { type: 'presence'; clientId: string; presence: Presence | null }
  /** The batch could not be applied; the client must reload from the snapshot that follows. */
  | { type: 'reject'; batchId: string; reason: RejectReason }
  /** Start over from this state (after a reject, or when the client is too far behind). */
  | { type: 'resync'; revision: number; snapshot: WorkbookSnapshot }
  | { type: 'pong' };

export type RejectReason = 'read-only' | 'stale' | 'invalid';

export function encode(msg: ClientMessage | ServerMessage): string {
  return JSON.stringify(msg);
}

export function decodeClient(data: string): ClientMessage | null {
  return decode(data, CLIENT_TYPES) as ClientMessage | null;
}

export function decodeServer(data: string): ServerMessage | null {
  return decode(data, SERVER_TYPES) as ServerMessage | null;
}

/**
 * Longest WebSocket message either side sends. Cloudflare refuses messages
 * over 1 MiB, and a workbook snapshot or a large paste can be far bigger, so
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
