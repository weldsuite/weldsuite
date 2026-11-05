/**
 * Importing a file as a new board: Excalidraw scenes, CSV and text (as
 * sticky notes) and WeldBoard's own JSON. In a workspace board-api reads the
 * file; the signed-out preview reads it here with the same engine.
 */

import {
  Board,
  applyOp,
  emptySnapshot,
  fromExcalidraw,
  isWellFormedSnapshot,
  newId,
  placeFragment,
  stickiesFromText,
  type BoardSnapshot,
} from '@weldsuite/board-engine';
import type { ImportBoardInput } from '@weldsuite/app-api-client/schemas/boards';

export const IMPORT_ACCEPT = '.excalidraw,.json,.csv,.tsv,.txt';
export const IMPORT_MAX_BYTES = 20 * 1024 * 1024;

export function importFormat(fileName: string): ImportBoardInput['format'] | null {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.excalidraw')) return 'excalidraw';
  if (lower.endsWith('.weldboard.json') || lower.endsWith('.json')) return 'weldboard';
  if (lower.endsWith('.csv') || lower.endsWith('.tsv')) return 'csv';
  if (lower.endsWith('.txt')) return 'text';
  return null;
}

export function boardName(fileName: string): string {
  return fileName.replace(/\.weldboard\.json$/i, '').replace(/\.[^.]+$/, '').slice(0, 255) || fileName;
}

/** A board snapshot from a file's text (the preview's import; board-api does the same). */
export function snapshotFromFile(format: ImportBoardInput['format'], content: string): { snapshot: BoardSnapshot; skipped: number } | null {
  if (format === 'weldboard') {
    try {
      const v = JSON.parse(content) as { kind?: string; snapshot?: unknown };
      const snapshot = v.kind === 'weldboard' ? v.snapshot : v;
      return isWellFormedSnapshot(snapshot) ? { snapshot, skipped: 0 } : null;
    } catch {
      return null;
    }
  }
  let fragment;
  let skipped = 0;
  if (format === 'excalidraw') {
    try {
      const result = fromExcalidraw(JSON.parse(content), () => newId());
      fragment = result.fragment;
      skipped = result.skipped;
    } catch {
      return null;
    }
  } else fragment = stickiesFromText(content, () => newId());
  const board = Board.fromSnapshot(emptySnapshot());
  applyOp(board, placeFragment(board, fragment, { x: 0, y: 0, makeId: () => newId() }).op);
  return { snapshot: board.toSnapshot(), skipped };
}
