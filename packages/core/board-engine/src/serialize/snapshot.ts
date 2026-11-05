/**
 * Snapshots: the whole board as JSON (checkpoints, version history, a new
 * board's first state). `isWellFormedSnapshot` checks one from an untrusted
 * place (an import, an API caller) before it becomes a board.
 */

import { Board } from '../model/board';
import { isBoardProps, isElement, isId, MAX_ELEMENTS } from '../model/schema';
import { SNAPSHOT_VERSION, type BoardProps, type BoardSnapshot } from '../model/types';

export function emptySnapshot(props: BoardProps = {}): BoardSnapshot {
  return { version: SNAPSHOT_VERSION, props: structuredClone(props), elements: [] };
}

export function isWellFormedSnapshot(v: unknown): v is BoardSnapshot {
  if (typeof v !== 'object' || v === null) return false;
  const s = v as Record<string, unknown>;
  if (s.version !== SNAPSHOT_VERSION || !isBoardProps(s.props) || !Array.isArray(s.elements)) return false;
  if (s.elements.length > MAX_ELEMENTS) return false;
  const ids = new Set<string>();
  for (const el of s.elements) {
    if (!isElement(el) || ids.has(el.id)) return false;
    ids.add(el.id);
  }
  if (s.votes !== undefined) {
    if (typeof s.votes !== 'object' || s.votes === null) return false;
    for (const [user, list] of Object.entries(s.votes)) {
      if (user.length === 0 || user.length > 128 || !Array.isArray(list) || !list.every(isId)) return false;
    }
  }
  return true;
}

/** A board from a snapshot, or null when the snapshot is not one. */
export function loadSnapshot(v: unknown): Board | null {
  return isWellFormedSnapshot(v) ? Board.fromSnapshot(v) : null;
}

/**
 * A board's content as the start of another board (duplicate, start from a
 * template): its comment pins stay with the board they were made on (their
 * threads are that board's), and so do the session's votes, timer, voting
 * round and private mode.
 */
export function copySnapshot(snapshot: BoardSnapshot): BoardSnapshot {
  const { timer: _timer, voting: _voting, privateMode: _private, ...props } = snapshot.props;
  return {
    version: snapshot.version,
    props: structuredClone(props),
    elements: structuredClone(snapshot.elements.filter((el) => el.type !== 'comment')),
  };
}
