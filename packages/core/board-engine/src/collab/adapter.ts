/**
 * WeldBoard as a document for @weldsuite/collab: the board is the state, a
 * board snapshot the snapshot, and the ops are the engine's own.
 */

import {
  CollabClient,
  RoomCore,
  type ClientMessage,
  type CollabClientOptions,
  type CommittedOp,
  type OtAdapter,
  type Peer,
  type RoomOptions,
  type ServerMessage,
} from '@weldsuite/collab';
import { Board } from '../model/board';
import { isId } from '../model/schema';
import type { BoardSnapshot } from '../model/types';
import { applyOp } from '../ops/apply';
import { isWellFormedOp } from '../ops/shape';
import { transform } from '../ops/transform';
import { batch, normalize, unbatch, type Op } from '../ops/types';
import { validateOp } from '../ops/validate';

/** Where someone is on the board, shown to everyone else. Never persisted. */
export interface BoardPresence {
  /** Pointer position in board units. */
  cursor?: [number, number] | null;
  /** Selected element ids. */
  selection?: string[];
  /** The element whose text they are editing. */
  editing?: string | null;
  /** Caret and selection in the element they are editing. */
  caret?: [number, number] | null;
  /** The visible area, `[x, y, width, height]` in board units (for following). */
  viewport?: [number, number, number, number];
  /** The tool in their hand. */
  tool?: string;
  /** Who they are following. */
  following?: string | null;
  /** Presenting: everyone else is invited to follow them. */
  presenting?: boolean;
  /** The frame they are presenting. */
  slide?: string | null;
  /** A reaction they just sent, with the time they sent it. */
  reaction?: [string, number] | null;
}

export type BoardAdapter = OtAdapter<Board, Op, BoardSnapshot, BoardPresence>;

export function boardAdapter(): BoardAdapter {
  return {
    load: (snapshot) => Board.fromSnapshot(snapshot),
    snapshot: (board) => board.toSnapshot(),
    apply: (board, op) => applyOp(board, op),
    transform: (a, b, aWins) => transform(a, b, aWins),
    normalize: (op) => normalize(op),
    batch: (ops) => batch(ops),
    unbatch: (op) => unbatch(op),
    isWellFormedOp: (v): v is Op => isWellFormedOp(v),
    validate: (board, op) => validateOp(board, op),
    isPresence,
  };
}

export type BoardRoomOptions = RoomOptions<Op, Board, BoardPresence>;
export type BoardClientOptions = CollabClientOptions<Board, Op, BoardPresence>;
export type BoardRoomCore = RoomCore<Board, Op, BoardSnapshot, BoardPresence>;
export type BoardClient = CollabClient<Board, Op, BoardSnapshot, BoardPresence>;

/** A board's room: wrap it in the BoardRoom Durable Object. */
export function createBoardRoom(snapshot: BoardSnapshot, revision: number, options: BoardRoomOptions = {}): BoardRoomCore {
  return new RoomCore(boardAdapter(), snapshot, revision, options);
}

export function restoreBoardRoom(
  snapshot: BoardSnapshot,
  snapshotRevision: number,
  ops: CommittedOp<Op>[],
  options: BoardRoomOptions = {},
): BoardRoomCore {
  return RoomCore.restore(boardAdapter(), snapshot, snapshotRevision, ops, options);
}

export function createBoardClient(options: BoardClientOptions): BoardClient {
  return new CollabClient(boardAdapter(), options);
}

const PRESENCE_KEYS = new Set([
  'cursor', 'selection', 'editing', 'caret', 'viewport', 'tool', 'following', 'presenting', 'slide', 'reaction',
]);

function isNum(v: unknown): boolean {
  return typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= 1e8;
}

function isTuple(v: unknown, n: number): boolean {
  return Array.isArray(v) && v.length === n && v.every(isNum);
}

function isPresence(v: unknown): v is BoardPresence {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const p = v as Record<string, unknown>;
  for (const k of Object.keys(p)) if (!PRESENCE_KEYS.has(k)) return false;
  return (
    (p.cursor === undefined || p.cursor === null || isTuple(p.cursor, 2)) &&
    (p.selection === undefined || (Array.isArray(p.selection) && p.selection.length <= 2000 && p.selection.every(isId))) &&
    (p.editing === undefined || p.editing === null || isId(p.editing)) &&
    (p.caret === undefined || p.caret === null || isTuple(p.caret, 2)) &&
    (p.viewport === undefined || isTuple(p.viewport, 4)) &&
    (p.tool === undefined || (typeof p.tool === 'string' && p.tool.length <= 32)) &&
    (p.following === undefined || p.following === null || (typeof p.following === 'string' && p.following.length <= 128)) &&
    (p.presenting === undefined || typeof p.presenting === 'boolean') &&
    (p.slide === undefined || p.slide === null || isId(p.slide)) &&
    (p.reaction === undefined ||
      p.reaction === null ||
      (Array.isArray(p.reaction) &&
        p.reaction.length === 2 &&
        typeof p.reaction[0] === 'string' &&
        p.reaction[0].length <= 16 &&
        isNum(p.reaction[1])))
  );
}

export type BoardPeer = Peer<BoardPresence>;
export type BoardClientMessage = ClientMessage<Op, BoardPresence>;
export type BoardServerMessage = ServerMessage<Op, BoardSnapshot, BoardPresence>;
export type BoardCommittedOp = CommittedOp<Op>;
