/**
 * Operations: every change to a document is one of these. They are plain
 * JSON so they can travel over the collaboration socket, sit in the op log
 * and be replayed.
 *
 * Text ops address a story by id and positions in it. Table ops address a
 * table by id, rows and columns by index where order matters (insert,
 * delete) and by id where it does not (formatting), so concurrent edits to
 * different parts of a table never need transforming against each other.
 */

import type { Content, StoryContent } from '../model/content';
import type {
  Anchor,
  CellProps,
  ColPatch,
  DimData,
  DocPropsPatch,
  ObjectPatch,
  RowPatch,
  TableAxis,
  TableData,
  TableProps,
} from '../model/objects';
import type { ListDef, NamedStyle, ParaPatch, Patch, TextStylePatch } from '../model/styles';

/** `[length, patch]`; a null patch leaves that stretch alone. */
export type FormatRun<P> = [number, P | null];

export type Op =
  /** Inserts content (with what its objects own) before position `at`. */
  | { type: 'insert'; story: string; at: number; content: Content }
  /** Deletes [from, to), and whatever the objects in it own. */
  | { type: 'delete'; story: string; from: number; to: number }
  /** Patches the character style of the runs from `at` on. */
  | { type: 'formatText'; story: string; at: number; runs: FormatRun<TextStylePatch>[] }
  /** Patches the properties of the paragraph marks in the runs from `at` on. */
  | { type: 'formatParagraphs'; story: string; at: number; runs: FormatRun<ParaPatch>[] }
  /** Patches the data of the object at `at`. */
  | { type: 'setObject'; story: string; at: number; patch: ObjectPatch }
  /**
   * Inserts rows or columns before index `at`. Their cells start empty; an
   * undo brings back cell formatting (`cells`, keyed `rowId:colId`) and
   * content (`content.stories` by cell story id, and the tables in them).
   */
  | {
      type: 'insertTableDims';
      table: string;
      axis: TableAxis;
      at: number;
      items: DimData[];
      cells?: Record<string, CellProps>;
      content?: Pick<Content, 'tables' | 'stories'>;
    }
  | { type: 'deleteTableDims'; table: string; axis: TableAxis; at: number; count: number }
  /** Patches rows or columns by id. */
  | { type: 'setTableDims'; table: string; axis: TableAxis; dims: [string, RowPatch | ColPatch][] }
  /** Patches cells by `rowId:colId` (merging is setting a span on the top-left cell). */
  | { type: 'setTableCells'; table: string; cells: [string, Patch<CellProps>][] }
  | { type: 'setTable'; table: string; patch: Patch<TableProps> }
  /** Creates a header or footer story (empty, or with `content` for an undo). */
  | { type: 'createStory'; story: string; content?: StoryContent & Pick<Content, 'tables' | 'stories'> }
  | { type: 'deleteStory'; story: string }
  | { type: 'setDocProps'; patch: DocPropsPatch }
  /** Adds or replaces (`set`) and removes named styles, by id. */
  | { type: 'patchStyles'; set?: Record<string, NamedStyle>; remove?: string[] }
  | { type: 'patchLists'; set?: Record<string, ListDef>; remove?: string[] }
  /** Adds or moves (`set`) and removes anchors, by id. */
  | { type: 'patchAnchors'; set?: Anchor[]; remove?: string[] }
  /** Applied in order, atomically. */
  | { type: 'batch'; ops: Op[] };

export type OpType = Op['type'];
export type SimpleOp = Exclude<Op, { type: 'batch' }>;
export type OpOf<T extends OpType> = Extract<Op, { type: T }>;

export const NOOP: Op = { type: 'batch', ops: [] };

export function isNoop(op: Op): boolean {
  return op.type === 'batch' && op.ops.length === 0;
}

/** Flattens nested batches, drops no-ops, and unwraps a batch of one. */
export function normalize(op: Op): Op {
  if (op.type !== 'batch') return isEmptySimple(op) ? NOOP : op;
  const flat: Op[] = [];
  const add = (o: Op) => {
    if (o.type === 'batch') o.ops.forEach(add);
    else if (!isEmptySimple(o)) flat.push(o);
  };
  add(op);
  return flat.length === 1 ? flat[0]! : { type: 'batch', ops: flat };
}

export function batch(ops: Op[]): Op {
  return normalize({ type: 'batch', ops });
}

export function unbatch(op: Op): Op[] {
  const n = normalize(op);
  return n.type === 'batch' ? n.ops : [n];
}

/** Ops that change nothing whatever the document. */
function isEmptySimple(op: SimpleOp): boolean {
  switch (op.type) {
    case 'insert':
      return op.content.text.length === 0;
    case 'delete':
      return op.from >= op.to;
    case 'formatText':
    case 'formatParagraphs':
      return op.runs.every(([len, patch]) => len === 0 || patch === null);
    case 'insertTableDims':
      return op.items.length === 0;
    case 'deleteTableDims':
      return op.count <= 0;
    case 'setTableDims':
      return op.dims.length === 0;
    case 'setTableCells':
      return op.cells.length === 0;
    case 'patchStyles':
    case 'patchLists':
      return Object.keys(op.set ?? {}).length === 0 && (op.remove ?? []).length === 0;
    case 'patchAnchors':
      return (op.set ?? []).length === 0 && (op.remove ?? []).length === 0;
    default:
      return false;
  }
}

/** Total length covered by format runs. */
export function runsLength(runs: FormatRun<unknown>[]): number {
  let n = 0;
  for (const [len] of runs) n += len;
  return n;
}
