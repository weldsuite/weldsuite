/**
 * A whole file as a new board's first snapshot: an Excalidraw scene, CSV or
 * text lines (as sticky notes), or WeldBoard's own JSON export. board-api's
 * import route and the signed-out preview both use it.
 */

import { Board } from '../model/board';
import { newId } from '../model/defaults';
import { applyOp } from '../ops/apply';
import type { BoardSnapshot } from '../model/types';
import { placeFragment, type Fragment } from './fragment';
import { fromExcalidraw, stickiesFromText } from './import';
import { emptySnapshot, isWellFormedSnapshot } from './snapshot';

export type ImportFormat = 'excalidraw' | 'csv' | 'text' | 'weldboard';

/** The snapshot a file's text makes, with how many of its elements could not come across; null when it cannot be read. */
export function snapshotFromImport(
  format: ImportFormat,
  content: string,
  makeId: () => string = () => newId(),
): { snapshot: BoardSnapshot; skipped: number } | null {
  if (format === 'weldboard') {
    try {
      const v = JSON.parse(content) as { kind?: string; snapshot?: unknown };
      const snapshot = v.kind === 'weldboard' ? v.snapshot : v;
      return isWellFormedSnapshot(snapshot) ? { snapshot: Board.fromSnapshot(snapshot).toSnapshot(), skipped: 0 } : null;
    } catch {
      return null;
    }
  }
  let fragment: Fragment;
  let skipped = 0;
  if (format === 'excalidraw') {
    try {
      const result = fromExcalidraw(JSON.parse(content), makeId);
      fragment = result.fragment;
      skipped = result.skipped;
    } catch {
      return null;
    }
  } else fragment = stickiesFromText(content, makeId);
  const board = Board.fromSnapshot(emptySnapshot());
  applyOp(board, placeFragment(board, fragment, { x: 0, y: 0, makeId }).op);
  return { snapshot: board.toSnapshot(), skipped };
}
