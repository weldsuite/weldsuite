/**
 * Applies ops to an Engine. `applyOp` returns the op's exact inverse,
 * captured from the state it changed, which is what undo replays.
 */

import { MAX_COLS, MAX_ROWS, rangesIntersect, type Range } from '../address';
import { Engine, mapRangeDelete, mapRangeInsert, mapRun, type CellContent, type RewrittenFormula } from '../calc/engine';
import { moveIndexMapper, type Axis } from '../formula/references';
import type { AxisDims } from '../model/axis';
import type { Cell } from '../model/cell-store';
import type { StylePatch } from '../model/styles';
import {
  cloneFilter,
  cloneFormat,
  cloneValidation,
  sameRule,
  sortFormats,
  type ConditionalFormat,
  type DataValidation,
  type SheetFilter,
} from '../model/rules';
import { sheetFromJSON, sheetToJSON, type DefinedName, type Sheet, type SheetProps } from '../model/workbook';
import { cloneChart, type Chart } from '../model/charts';
import { cloneComment, cloneDataTable, type DataTable, type SheetComment } from '../model/anchors';
import { nameKey, normalize, type AxisEntry, type CellPatch, type NameKey, type Op } from './types';

/** Applies `op`, recalculates, and returns its inverse. */
export function applyOp(engine: Engine, op: Op): Op {
  const inverse = applyInner(engine, op);
  engine.recalc();
  return normalize(inverse);
}

function contentOf(cell: Cell | undefined): CellContent | null {
  if (!cell) return null;
  if (cell.f !== undefined) return { f: cell.f };
  return cell.v === null ? null : { v: cell.v };
}

function applyInner(engine: Engine, op: Op): Op {
  switch (op.type) {
    case 'batch': {
      const inverses: Op[] = [];
      for (const o of op.ops) inverses.push(applyInner(engine, o));
      return { type: 'batch', ops: inverses.reverse() };
    }

    case 'setCells':
      return setCells(engine, op);

    case 'formatRanges':
      return formatRanges(engine, op.sheetId, op.ranges, op.patch);

    case 'setStyles':
      return setStyles(engine, op);

    case 'insertDims':
      return restoring(engine, () => insertDims(engine, op));

    case 'deleteDims':
      return restoring(engine, () => deleteDims(engine, op.sheetId, op.axis, op.at, op.count));

    case 'moveDims':
      return restoring(engine, () => moveDims(engine, op));

    case 'resizeDims':
      return resizeDims(engine, op);

    case 'hideDims': {
      const axis = axisOf(engine.workbook.requireSheet(op.sheetId), op.axis);
      const changed = op.indices.filter((i) => axis.isHidden(i) !== op.hidden);
      for (const i of changed) axis.setHidden(i, op.hidden);
      if (changed.length > 0 && op.axis === 'row') engine.visibilityChanged();
      return { type: 'hideDims', sheetId: op.sheetId, axis: op.axis, indices: changed, hidden: !op.hidden };
    }

    case 'addSheet': {
      const sheet = op.snapshot ? sheetFromJSON({ ...op.snapshot, id: op.sheetId, name: op.name }) : undefined;
      engine.addSheet(op.sheetId, op.name, op.index, sheet);
      return { type: 'deleteSheet', sheetId: op.sheetId, sheetName: op.name };
    }

    case 'deleteSheet': {
      const sheet = engine.workbook.requireSheet(op.sheetId);
      const snapshot = sheetToJSON(sheet);
      const names = engine.workbook.names.map((n) => ({ ...n }));
      const rules = captureRules(engine);
      const { index, rewritten } = engine.removeSheet(op.sheetId);
      return {
        type: 'batch',
        ops: [
          { type: 'addSheet', sheetId: op.sheetId, name: snapshot.name, index, snapshot },
          ...restoreFormulas(rewritten, null, 'row', (i) => i),
          namesBack(names, engine.workbook.names),
          ...rulesBack(engine, rules),
        ],
      };
    }

    case 'renameSheet': {
      const sheet = engine.workbook.requireSheet(op.sheetId);
      const old = sheet.name;
      engine.renameSheet(op.sheetId, op.name);
      return { type: 'renameSheet', sheetId: op.sheetId, oldName: op.name, name: old };
    }

    case 'moveSheet': {
      const prev = engine.workbook.sheets.findIndex((s) => s.id === op.sheetId);
      engine.moveSheet(op.sheetId, op.index);
      return { type: 'moveSheet', sheetId: op.sheetId, index: prev };
    }

    case 'setSheetProps':
      return setSheetProps(engine, op);

    case 'setGridSize': {
      const sheet = engine.workbook.requireSheet(op.sheetId);
      const prev = { rowCount: sheet.rowCount, colCount: sheet.colCount };
      if (op.rowCount !== undefined) sheet.rowCount = clamp(op.rowCount, 1, MAX_ROWS);
      if (op.colCount !== undefined) sheet.colCount = clamp(op.colCount, 1, MAX_COLS);
      return { type: 'setGridSize', sheetId: op.sheetId, ...prev };
    }

    case 'merge':
      return merge(engine, op);

    case 'unmerge': {
      const sheet = engine.workbook.requireSheet(op.sheetId);
      const removed = sheet.merges.filter((m) => op.ranges.some((r) => rangesIntersect(m, r)));
      sheet.merges = sheet.merges.filter((m) => !removed.includes(m));
      return { type: 'merge', sheetId: op.sheetId, ranges: removed };
    }

    case 'setFreeze': {
      const sheet = engine.workbook.requireSheet(op.sheetId);
      const prev = { ...sheet.freeze };
      sheet.freeze = { rows: Math.max(0, op.rows), cols: Math.max(0, op.cols) };
      return { type: 'setFreeze', sheetId: op.sheetId, ...prev };
    }

    case 'setNames': {
      const prev = engine.workbook.names.map((n) => ({ ...n }));
      engine.setNames(op.names);
      return { type: 'setNames', names: prev };
    }

    case 'patchNames':
      return patchNames(engine, op);

    case 'setFilter':
    case 'patchConditionalFormats':
    case 'patchValidations':
    case 'patchCharts':
    case 'patchComments':
    case 'patchDataTables':
      return applyRuleOp(engine, op);
  }
}

type RuleOpType = 'setFilter' | 'patchConditionalFormats' | 'patchValidations' | 'patchCharts' | 'patchComments' | 'patchDataTables';

function applyRuleOp(engine: Engine, op: OpOf<RuleOpType>): Op {
  if (op.type === 'setFilter') {
    const previous = engine.setFilter(op.sheetId, op.filter);
    return { type: 'setFilter', sheetId: op.sheetId, filter: previous ? cloneFilter(previous) : null };
  }
  const sheet = engine.workbook.requireSheet(op.sheetId);
  if (op.type === 'patchConditionalFormats') {
    const { list, back } = patchById(sheet.conditionalFormats, op.set, op.remove, cloneFormat);
    sheet.conditionalFormats = sortFormats(list);
    return { type: 'patchConditionalFormats', sheetId: op.sheetId, ...back };
  }
  if (op.type === 'patchCharts') {
    const { list, back } = patchById(sheet.charts, op.set, op.remove, cloneChart);
    sheet.charts = list;
    return { type: 'patchCharts', sheetId: op.sheetId, ...back };
  }
  if (op.type === 'patchComments') {
    const { list, back } = patchById(sheet.comments, op.set, op.remove, cloneComment);
    sheet.comments = list;
    return { type: 'patchComments', sheetId: op.sheetId, ...back };
  }
  if (op.type === 'patchDataTables') {
    const { list, back } = patchById(sheet.dataTables, op.set, op.remove, cloneDataTable);
    sheet.dataTables = list;
    return { type: 'patchDataTables', sheetId: op.sheetId, ...back };
  }
  const { list, back } = patchById(sheet.validations, op.set, op.remove, cloneValidation);
  sheet.validations = list;
  return { type: 'patchValidations', sheetId: op.sheetId, ...back };
}

/**
 * Upserts and removes rules by id (a new id goes last); `back` puts each
 * touched id back as it was.
 */
function patchById<T extends { id: string }>(
  current: T[],
  set: T[] | undefined,
  remove: string[] | undefined,
  clone: (rule: T) => T,
): { list: T[]; back: { set: T[]; remove: string[] } } {
  const list = [...current];
  const previous = new Map<string, T | null>();
  const touch = (id: string) => {
    if (previous.has(id)) return;
    const existing = list.find((r) => r.id === id);
    previous.set(id, existing ? clone(existing) : null);
  };
  for (const id of remove ?? []) {
    touch(id);
    const i = list.findIndex((r) => r.id === id);
    if (i >= 0) list.splice(i, 1);
  }
  for (const rule of set ?? []) {
    touch(rule.id);
    const i = list.findIndex((r) => r.id === rule.id);
    if (i >= 0) list[i] = clone(rule);
    else list.push(clone(rule));
  }
  const back = {
    set: [...previous.values()].filter((r): r is T => r !== null),
    remove: [...previous].filter(([, r]) => r === null).map(([id]) => id),
  };
  return { list, back };
}

interface SheetRules {
  sheetId: string;
  filter: SheetFilter | null;
  formats: ConditionalFormat[];
  validations: DataValidation[];
  charts: Chart[];
  comments: SheetComment[];
  dataTables: DataTable[];
}

function captureRules(engine: Engine): SheetRules[] {
  return engine.workbook.sheets.map((sheet) => ({
    sheetId: sheet.id,
    filter: sheet.filter ? cloneFilter(sheet.filter) : null,
    formats: sheet.conditionalFormats.map(cloneFormat),
    validations: sheet.validations.map(cloneValidation),
    charts: sheet.charts.map(cloneChart),
    comments: sheet.comments.map(cloneComment),
    dataTables: sheet.dataTables.map(cloneDataTable),
  }));
}

/** Ops that put every sheet's filter and rules back to `before`, touching only what differs. */
function rulesBack(engine: Engine, before: SheetRules[]): Op[] {
  const ops: Op[] = [];
  for (const b of before) {
    const sheet = engine.workbook.getSheet(b.sheetId);
    if (!sheet) continue;
    if (!sameRule(b.filter, sheet.filter)) ops.push({ type: 'setFilter', sheetId: b.sheetId, filter: b.filter });
    const formats = patchBack(b.formats, sheet.conditionalFormats);
    if (formats) ops.push({ type: 'patchConditionalFormats', sheetId: b.sheetId, ...formats });
    const validations = patchBack(b.validations, sheet.validations);
    if (validations) ops.push({ type: 'patchValidations', sheetId: b.sheetId, ...validations });
    const charts = patchBack(b.charts, sheet.charts);
    if (charts) ops.push({ type: 'patchCharts', sheetId: b.sheetId, ...charts });
    const comments = patchBack(b.comments, sheet.comments);
    if (comments) ops.push({ type: 'patchComments', sheetId: b.sheetId, ...comments });
    const dataTables = patchBack(b.dataTables, sheet.dataTables);
    if (dataTables) ops.push({ type: 'patchDataTables', sheetId: b.sheetId, ...dataTables });
  }
  return ops;
}

function patchBack<T extends { id: string }>(before: T[], after: T[]): { set: T[]; remove: string[] } | null {
  const now = new Map(after.map((r) => [r.id, r]));
  const then = new Set(before.map((r) => r.id));
  const set = before.filter((r) => !sameRule(now.get(r.id), r));
  const remove = after.filter((r) => !then.has(r.id)).map((r) => r.id);
  return set.length || remove.length ? { set, remove } : null;
}

type OpOf<T extends Op['type']> = Extract<Op, { type: T }>;

function setCells(engine: Engine, op: OpOf<'setCells'>): Op {
  const sheet = engine.workbook.requireSheet(op.sheetId);
  const prev: CellPatch[] = [];
  for (const [row, col, content] of op.cells) {
    prev.push([row, col, contentOf(sheet.cells.get(row, col))]);
    engine.setContent(op.sheetId, row, col, content);
  }
  return { type: 'setCells', sheetId: op.sheetId, cells: prev.reverse() };
}

function setStyles(engine: Engine, op: OpOf<'setStyles'>): Op {
  const sheet = engine.workbook.requireSheet(op.sheetId);
  const prevCells: [number, number, string | null][] = [];
  for (const [row, col, key] of op.cells) {
    prevCells.push([row, col, sheet.cells.get(row, col)?.s ?? null]);
    engine.setStyleKey(op.sheetId, row, col, key ?? undefined);
  }
  const prevRows = setAxisStyles(sheet, 'row', op.rows);
  const prevCols = setAxisStyles(sheet, 'col', op.cols);
  const inverse: Op = { type: 'setStyles', sheetId: op.sheetId, cells: prevCells.reverse() };
  if (prevRows) inverse.rows = prevRows;
  if (prevCols) inverse.cols = prevCols;
  return inverse;
}

function insertDims(engine: Engine, op: OpOf<'insertDims'>): Op {
  const rewritten = engine.insertDims(op.sheetId, op.axis, op.at, op.count);
  const back = (i: number) => (i >= op.at + op.count ? i - op.count : i);
  return {
    type: 'batch',
    ops: [
      { type: 'deleteDims', sheetId: op.sheetId, sheetName: currentName(engine, op.sheetId), axis: op.axis, at: op.at, count: op.count },
      ...restoreFormulas(rewritten, op.sheetId, op.axis, back),
    ],
  };
}

function moveDims(engine: Engine, op: OpOf<'moveDims'>): Op {
  // Dropping a block back onto itself changes nothing, and has nothing to undo.
  if (op.to >= op.from && op.to <= op.from + op.count) return { type: 'batch', ops: [] };
  const sheet = engine.workbook.requireSheet(op.sheetId);
  // The engine unmerges merges a move splits; undo merges them again.
  const forward = moveIndexMapper(op.from, op.count, op.to);
  const split = sheet.merges.filter((m) => {
    const [lo, hi] = op.axis === 'row' ? [m.r1, m.r2] : [m.c1, m.c2];
    return mapRun(lo, hi, forward) === null;
  });
  const rewritten = engine.moveDims(op.sheetId, op.axis, op.from, op.count, op.to);
  const p = op.to < op.from ? op.to : op.to - op.count;
  const backTo = p < op.from ? op.from + op.count : op.from;
  const back = moveIndexMapper(p, op.count, backTo);
  return {
    type: 'batch',
    ops: [
      { type: 'moveDims', sheetId: op.sheetId, sheetName: currentName(engine, op.sheetId), axis: op.axis, from: p, count: op.count, to: backTo },
      ...restoreFormulas(rewritten, op.sheetId, op.axis, back),
      { type: 'merge', sheetId: op.sheetId, ranges: split.map((m) => ({ ...m })) },
    ],
  };
}

/**
 * Runs a structural change and adds to its inverse a patch that puts back the
 * defined names it rewrote (re-inserting rows cannot restore a reference that
 * became #REF!). Only those names: one defined in the meantime survives undo.
 */
/** Runs a structural change; its inverse also puts back the names and sheet rules it rewrote or dropped. */
function restoring(engine: Engine, run: () => Op): Op {
  const names = engine.workbook.names.map((n) => ({ ...n }));
  const rules = captureRules(engine);
  const inverse = run();
  return { type: 'batch', ops: [inverse, namesBack(names, engine.workbook.names), ...rulesBack(engine, rules)] };
}

/** A patch from `after` back to `before`, touching only the names that differ. */
function namesBack(before: DefinedName[], after: DefinedName[]): Op {
  const now = new Map(after.map((n) => [nameKey(n), n]));
  const then = new Set(before.map(nameKey));
  const set = before.filter((n) => now.get(nameKey(n))?.formula !== n.formula).map((n) => ({ ...n }));
  const remove = after.filter((n) => !then.has(nameKey(n))).map(({ name, sheetId }) => keyOf({ name, sheetId }));
  return { type: 'patchNames', set, remove };
}

/** Upserts and removes names by key; the inverse puts each touched key back as it was. */
function patchNames(engine: Engine, op: OpOf<'patchNames'>): Op {
  const names = engine.workbook.names.map((n) => ({ ...n }));
  const previous = new Map<string, DefinedName | null>();
  const touch = (key: NameKey) => {
    const k = nameKey(key);
    if (previous.has(k)) return;
    const existing = names.find((n) => nameKey(n) === k);
    previous.set(k, existing ? { ...existing } : null);
  };
  for (const key of op.remove ?? []) {
    touch(key);
    const k = nameKey(key);
    const i = names.findIndex((n) => nameKey(n) === k);
    if (i >= 0) names.splice(i, 1);
  }
  for (const name of op.set ?? []) {
    touch(name);
    const k = nameKey(name);
    const i = names.findIndex((n) => nameKey(n) === k);
    if (i >= 0) names[i] = { ...name };
    else names.push({ ...name });
  }
  engine.setNames(names);
  const set: DefinedName[] = [];
  const remove: NameKey[] = [];
  for (const [k, prev] of previous) {
    if (prev) set.push(prev);
    else remove.push(keyOf([...(op.set ?? []), ...(op.remove ?? [])].find((n) => nameKey(n) === k)!));
  }
  return { type: 'patchNames', set, remove };
}

function keyOf(n: NameKey): NameKey {
  return n.sheetId === undefined ? { name: n.name } : { name: n.name, sheetId: n.sheetId };
}

function resizeDims(engine: Engine, op: OpOf<'resizeDims'>): Op {
  const axis = axisOf(engine.workbook.requireSheet(op.sheetId), op.axis);
  const prev: AxisEntry<number>[] = [];
  for (const [i, size] of op.entries) {
    prev.push([i, axis.storedSize(i) ?? null]);
    axis.setSize(i, size ?? undefined);
  }
  return { type: 'resizeDims', sheetId: op.sheetId, axis: op.axis, entries: prev.reverse() };
}

function setSheetProps(engine: Engine, op: OpOf<'setSheetProps'>): Op {
  const sheet = engine.workbook.requireSheet(op.sheetId);
  const prev: { [K in keyof SheetProps]?: SheetProps[K] | null } = {};
  const props = sheet.props as Record<string, unknown>;
  for (const [k, v] of Object.entries(op.props)) {
    (prev as Record<string, unknown>)[k] = props[k] ?? null;
    if (v === null || v === undefined) delete props[k];
    else props[k] = v;
  }
  return { type: 'setSheetProps', sheetId: op.sheetId, props: prev };
}

function merge(engine: Engine, op: OpOf<'merge'>): Op {
  const sheet = engine.workbook.requireSheet(op.sheetId);
  const removed = sheet.merges.filter((m) => op.ranges.some((r) => rangesIntersect(m, r)));
  sheet.merges = sheet.merges.filter((m) => !removed.includes(m));
  const added = op.ranges.filter((r) => r.r1 !== r.r2 || r.c1 !== r.c2).map((r) => ({ ...r }));
  sheet.merges.push(...added);
  return {
    type: 'batch',
    ops: [
      { type: 'unmerge', sheetId: op.sheetId, ranges: added },
      { type: 'merge', sheetId: op.sheetId, ranges: removed },
    ],
  };
}

function currentName(engine: Engine, sheetId: string): string {
  return engine.workbook.getSheet(sheetId)?.name ?? '';
}

function axisOf(sheet: Sheet, axis: Axis) {
  return axis === 'row' ? sheet.rows : sheet.cols;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Math.trunc(n)));
}

function setAxisStyles(sheet: Sheet, axis: Axis, entries: AxisEntry<string>[] | undefined): AxisEntry<string>[] | undefined {
  if (!entries?.length) return undefined;
  const styles = axisOf(sheet, axis).styles;
  const prev: AxisEntry<string>[] = [];
  for (const [i, key] of entries) {
    prev.push([i, styles.get(i) ?? null]);
    if (key === null) styles.delete(i);
    else styles.set(i, key);
  }
  return prev.reverse();
}

/**
 * setCells ops that put back formula text a structural change rewrote.
 * `map` takes an index on `axis` from where the formula is now to where it
 * will be once the inverse's own structural op has run.
 */
function restoreFormulas(
  rewritten: RewrittenFormula[],
  sheetId: string | null,
  axis: Axis,
  map: (i: number) => number,
): Op[] {
  const bySheet = new Map<string, CellPatch[]>();
  for (const r of rewritten) {
    let row = r.row;
    let col = r.col;
    if (r.sheetId === sheetId) {
      if (axis === 'row') row = map(row);
      else col = map(col);
    }
    let list = bySheet.get(r.sheetId);
    if (!list) {
      list = [];
      bySheet.set(r.sheetId, list);
    }
    list.push([row, col, { f: r.before }]);
  }
  return [...bySheet].map(([id, cells]) => ({ type: 'setCells', sheetId: id, cells }));
}

type KeyPatch = (key: string | undefined) => string | undefined;

function formatRanges(engine: Engine, sheetId: string, ranges: Range[], patch: StylePatch): Op {
  const sheet = engine.workbook.requireSheet(sheetId);
  const styles = engine.workbook.styles;
  const patchKey: KeyPatch = (key) => styles.patch(key, patch);
  const cells = new CellStylePatcher(engine, sheetId, patchKey);
  const prevRows: AxisEntry<string>[] = [];
  const prevCols: AxisEntry<string>[] = [];

  for (const r of ranges) {
    const wholeCols = r.r1 === 0 && r.r2 === MAX_ROWS - 1;
    const wholeRows = r.c1 === 0 && r.c2 === MAX_COLS - 1;
    if (wholeCols) patchAxisStyles(sheet.cols, r.c1, r.c2, patchKey, prevCols);
    else if (wholeRows) patchAxisStyles(sheet.rows, r.r1, r.r2, patchKey, prevRows);
    else cells.block(r);
    // Cells with their own style don't inherit the row/column style: patch them too.
    if (wholeCols || wholeRows) cells.ownStyled(r);
    // Rows with their own style would win over the new column style.
    if (wholeCols) cells.rowStyled(r.c1, r.c2);
  }

  const inverse: Op = { type: 'setStyles', sheetId, cells: cells.prev.reverse() };
  if (prevRows.length) inverse.rows = prevRows.reverse();
  if (prevCols.length) inverse.cols = prevCols.reverse();
  return inverse;
}

/** Patches the row or column styles [lo, hi] of `dims`, recording the old ones in `prev`. */
function patchAxisStyles(dims: AxisDims, lo: number, hi: number, patchKey: KeyPatch, prev: AxisEntry<string>[]): void {
  for (let i = lo; i <= hi; i++) {
    prev.push([i, dims.styles.get(i) ?? null]);
    const next = patchKey(dims.styles.get(i));
    if (next === undefined) dims.styles.delete(i);
    else dims.styles.set(i, next);
  }
}

/** Gives cells their own patched style, each cell at most once, recording what each had in `prev`. */
class CellStylePatcher {
  readonly prev: [number, number, string | null][] = [];
  private readonly seen = new Set<number>();
  private readonly sheet: Sheet;

  constructor(
    private readonly engine: Engine,
    private readonly sheetId: string,
    private readonly patchKey: KeyPatch,
  ) {
    this.sheet = engine.workbook.requireSheet(sheetId);
  }

  cell(row: number, col: number): void {
    const k = row * MAX_COLS + col;
    if (this.seen.has(k)) return;
    this.seen.add(k);
    const own = this.sheet.cells.get(row, col)?.s;
    this.prev.push([row, col, own ?? null]);
    this.engine.setStyleKey(this.sheetId, row, col, this.patchKey(this.sheet.styleKeyAt(row, col)));
  }

  /** Every cell of `r`. */
  block(r: Range): void {
    for (let row = r.r1; row <= r.r2; row++) for (let col = r.c1; col <= r.c2; col++) this.cell(row, col);
  }

  /** The cells of `r` that have a style of their own. */
  ownStyled(r: Range): void {
    this.sheet.cells.forEachInRange(r, (row, col, cell) => {
      if (cell.s !== undefined) this.cell(row, col);
    });
  }

  /** Columns c1..c2 of every row that has a row style. */
  rowStyled(c1: number, c2: number): void {
    for (const row of this.sheet.rows.styles.keys()) for (let c = c1; c <= c2; c++) this.cell(row, c);
  }
}

function deleteDims(engine: Engine, sheetId: string, axis: Axis, at: number, count: number): Op {
  const sheet = engine.workbook.requireSheet(sheetId);
  const end = at + count;
  const band: Range =
    axis === 'row' ? { r1: at, c1: 0, r2: end - 1, c2: MAX_COLS - 1 } : { r1: 0, c1: at, r2: MAX_ROWS - 1, c2: end - 1 };

  const contents: CellPatch[] = [];
  const cellStyles: [number, number, string | null][] = [];
  sheet.cells.forEachInRange(band, (row, col, cell) => {
    const content = contentOf(cell);
    if (content) contents.push([row, col, content]);
    if (cell.s !== undefined) cellStyles.push([row, col, cell.s]);
  });
  const dims = axisOf(sheet, axis);
  const sizes: AxisEntry<number>[] = [];
  const hidden: number[] = [];
  const axisStyles: AxisEntry<string>[] = [];
  for (let i = at; i < end; i++) {
    const size = dims.storedSize(i);
    if (size !== undefined) sizes.push([i, size]);
    if (dims.isHidden(i)) hidden.push(i);
    const s = dims.styles.get(i);
    if (s !== undefined) axisStyles.push([i, s]);
  }
  const merges = sheet.merges.filter((m) => rangesIntersect(m, band)).map((m) => ({ ...m }));
  const freeze = { ...sheet.freeze };
  const grid = { rowCount: sheet.rowCount, colCount: sheet.colCount };
  const sheetName = sheet.name;

  const rewritten = engine.deleteDims(sheetId, axis, at, count);

  // Merges that survive shrunk come back shrunk after re-insertion; swap them for the originals.
  const shrunk = merges.flatMap((m) => {
    const after = mapRangeDelete(m, axis, at, count);
    if (!after || (after.r1 === after.r2 && after.c1 === after.c2)) return [];
    const back = mapRangeInsert(after, axis, at, count);
    return back.r1 === m.r1 && back.r2 === m.r2 && back.c1 === m.c1 && back.c2 === m.c2 ? [] : [back];
  });

  const back = (i: number) => (i >= at ? i + count : i);
  const styleOp: Op = { type: 'setStyles', sheetId, cells: cellStyles };
  if (axisStyles.length) {
    if (axis === 'row') styleOp.rows = axisStyles;
    else styleOp.cols = axisStyles;
  }
  return {
    type: 'batch',
    ops: [
      { type: 'insertDims', sheetId, sheetName, axis, at, count },
      { type: 'resizeDims', sheetId, axis, entries: sizes },
      { type: 'hideDims', sheetId, axis, indices: hidden, hidden: true },
      styleOp,
      { type: 'setCells', sheetId, cells: contents },
      ...restoreFormulas(rewritten, sheetId, axis, back),
      { type: 'unmerge', sheetId, ranges: shrunk },
      { type: 'merge', sheetId, ranges: merges },
      { type: 'setFreeze', sheetId, ...freeze },
      { type: 'setGridSize', sheetId, ...grid },
    ],
  };
}
