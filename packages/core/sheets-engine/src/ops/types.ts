/**
 * Operations: every change to a workbook is one of these. They are plain JSON
 * so they can be sent over the collaboration socket, stored in the op log
 * and replayed.
 *
 * Ops that refer to a sheet by name inside formulas carry the sheet's name as
 * it was when the op was made (`sheetName`, `oldName`); `transform` keeps
 * those names current when it moves an op past a rename.
 */

import type { Range } from '../address';
import type { CellContent } from '../calc/engine';
import type { Axis } from '../formula/references';
import type { StylePatch } from '../model/styles';
import type { DefinedName, SheetProps, SheetSnapshot } from '../model/workbook';

/** [row, col, content]; `null` content clears the cell's value/formula (style stays). */
export type CellPatch = [number, number, CellContent | null];

/** [index, value]; `null` restores the default. */
export type AxisEntry<T> = [number, T | null];

export type Op =
  | { type: 'setCells'; sheetId: string; cells: CellPatch[] }
  /** Patch the style of every cell in `ranges`; whole rows/columns also patch the row/column style. */
  | { type: 'formatRanges'; sheetId: string; ranges: Range[]; patch: StylePatch }
  /** Set explicit style keys (paste, undo). */
  | {
      type: 'setStyles';
      sheetId: string;
      cells: [number, number, string | null][];
      rows?: AxisEntry<string>[];
      cols?: AxisEntry<string>[];
    }
  | { type: 'insertDims'; sheetId: string; sheetName: string; axis: Axis; at: number; count: number }
  | { type: 'deleteDims'; sheetId: string; sheetName: string; axis: Axis; at: number; count: number }
  /** Moves [from, from+count) to before index `to` (numbered before the move). */
  | { type: 'moveDims'; sheetId: string; sheetName: string; axis: Axis; from: number; count: number; to: number }
  | { type: 'resizeDims'; sheetId: string; axis: Axis; entries: AxisEntry<number>[] }
  | { type: 'hideDims'; sheetId: string; axis: Axis; indices: number[]; hidden: boolean }
  | { type: 'addSheet'; sheetId: string; name: string; index: number; snapshot?: SheetSnapshot }
  | { type: 'deleteSheet'; sheetId: string; sheetName: string }
  | { type: 'renameSheet'; sheetId: string; oldName: string; name: string }
  | { type: 'moveSheet'; sheetId: string; index: number }
  | { type: 'setSheetProps'; sheetId: string; props: { [K in keyof SheetProps]?: SheetProps[K] | null } }
  | { type: 'setGridSize'; sheetId: string; rowCount?: number; colCount?: number }
  | { type: 'merge'; sheetId: string; ranges: Range[] }
  | { type: 'unmerge'; sheetId: string; ranges: Range[] }
  | { type: 'setFreeze'; sheetId: string; rows: number; cols: number }
  /** Replaces the whole list of defined names. */
  | { type: 'setNames'; names: DefinedName[] }
  /**
   * Adds or replaces (`set`) and removes individual names, matched by name
   * (case-insensitive) and scope; names it does not mention are left alone.
   */
  | { type: 'patchNames'; set?: DefinedName[]; remove?: NameKey[] }
  /** Applied in order, atomically. */
  | { type: 'batch'; ops: Op[] };

export type OpType = Op['type'];

/** Identifies a defined name: its text and the sheet it is scoped to (none = workbook). */
export interface NameKey {
  name: string;
  sheetId?: string;
}

/** The key two names collide on: same scope, same name ignoring case (names cannot contain '!'). */
export function nameKey(n: NameKey): string {
  return `${n.sheetId ?? ''}!${n.name.toLowerCase()}`;
}

export const NOOP: Op = { type: 'batch', ops: [] };

export function isNoop(op: Op): boolean {
  return op.type === 'batch' && op.ops.every(isNoop);
}

/** Flattens nested batches and drops empty ops. */
export function normalize(op: Op): Op {
  const flat: Op[] = [];
  const walk = (o: Op) => {
    if (o.type === 'batch') o.ops.forEach(walk);
    else if (!isEmpty(o)) flat.push(o);
  };
  walk(op);
  return flat.length === 1 ? flat[0]! : { type: 'batch', ops: flat };
}

function isEmpty(op: Op): boolean {
  switch (op.type) {
    case 'setCells':
      return op.cells.length === 0;
    case 'formatRanges':
    case 'merge':
    case 'unmerge':
      return op.ranges.length === 0;
    case 'setStyles':
      return op.cells.length === 0 && !op.rows?.length && !op.cols?.length;
    case 'insertDims':
    case 'deleteDims':
    case 'moveDims':
      return op.count <= 0;
    case 'resizeDims':
      return op.entries.length === 0;
    case 'hideDims':
      return op.indices.length === 0;
    case 'patchNames':
      return !op.set?.length && !op.remove?.length;
    default:
      return false;
  }
}
