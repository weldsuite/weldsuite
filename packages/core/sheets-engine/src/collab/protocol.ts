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
