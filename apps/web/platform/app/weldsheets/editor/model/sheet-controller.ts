import {
  applyOp,
  delocalizeFormula,
  Engine,
  formatA1,
  formatCategory,
  formatValue,
  isDateFormat,
  isError,
  localizeFormula,
  normalize,
  parseInput,
  Sheet,
  transform,
  translateFormula,
  Workbook,
  type BorderSide,
  type CellPatch,
  type CellStyle,
  type FormatLocale,
  type FormulaLocale,
  type Op,
  type Peer,
  type Presence,
  type Range,
  type Scalar,
  type StylePatch,
  type WorkbookSnapshot,
} from '@weldsuite/sheets-engine';
import {
  cellSelection,
  clampToGrid,
  extendTo,
  isWholeColumns,
  isWholeRows,
  primaryRange,
  type CellPos,
  type Selection,
} from './selection';

export interface EditState {
  row: number;
  col: number;
  text: string;
  /** Where typing happens; both stay in sync. */
  origin: 'cell' | 'bar';
  /** Typed over the cell (arrows commit) rather than opened for editing (arrows move the caret). */
  replace: boolean;
}

interface UndoEntry {
  op: Op;
  inverse: Op;
  sheetId: string;
  selection: Selection;
}

export type BorderKind = 'all' | 'outer' | 'inner' | 'top' | 'bottom' | 'left' | 'right' | 'none';

export interface ControllerOptions {
  locale: FormatLocale;
  formulaLocale: FormulaLocale;
  /** Every local op, after it is applied (autosave in the preview). */
  onOp?: (op: Op) => void;
  /**
   * Applies a local op to the engine and returns its inverse. Co-editing
   * routes it through the room client, which also sends it; without it the
   * op is applied directly.
   */
  applyOp?: (op: Op) => Op;
}

const UNDO_LIMIT = 200;

/**
 * Everything the editor does to a workbook goes through here: it owns the
 * engine, the selection, the in-progress cell edit and the undo stacks, and
 * notifies React through `subscribe` (useSyncExternalStore).
 */
export class SheetController {
  /** Replaced when a co-edited sheet reloads from the room (`replaceEngine`). */
  engine: Engine;
  activeSheetId: string;
  selection: Selection = cellSelection(0, 0);
  editing: EditState | null = null;
  /** Without edit rights (sheets:update) a sheet can be read, selected and copied, not changed. */
  readOnly = false;
  /** Bumped on every change; the React snapshot. */
  version = 0;
  /** Other people in a co-edited sheet, with where they are (drawn on the grid). */
  peers: Peer[] = [];
  /** When each of them last moved (epoch ms): their name shows for a moment after. */
  private readonly peerMoves = new Map<string, number>();

  private undoStack: UndoEntry[] = [];
  private redoStack: UndoEntry[] = [];
  private readonly listeners = new Set<() => void>();
  private readonly selections = new Map<string, Selection>();

  /** `source`: a snapshot to open, an engine someone else keeps (the room client's), or null for a new workbook. */
  constructor(
    source: WorkbookSnapshot | Engine | null,
    readonly options: ControllerOptions,
  ) {
    if (source instanceof Engine) {
      this.engine = source;
      this.activeSheetId = source.workbook.sheets[0]!.id;
      return;
    }
    const snapshot = source;
    let workbook: Workbook;
    if (snapshot) {
      workbook = Workbook.fromJSON(snapshot);
    } else {
      workbook = new Workbook();
      workbook.sheets.push(new Sheet(newSheetId(), 'Sheet1'));
    }
    if (workbook.sheets.length === 0) workbook.sheets.push(new Sheet(newSheetId(), 'Sheet1'));
    this.engine = new Engine(workbook);
    this.activeSheetId = workbook.sheets[0]!.id;
  }

  // -------------------------------------------------------------------------
  // React plumbing
  // -------------------------------------------------------------------------

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getVersion = (): number => this.version;

  private emit(): void {
    this.version++;
    for (const fn of this.listeners) fn();
  }

  get sheet(): Sheet {
    return this.engine.workbook.getSheet(this.activeSheetId) ?? this.engine.workbook.sheets[0]!;
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  // -------------------------------------------------------------------------
  // Applying ops
  // -------------------------------------------------------------------------

  setPeers(peers: Peer[], now = Date.now()): void {
    const before = new Map(this.peers.map((p) => [p.clientId, p.presence]));
    for (const p of peers) {
      if (p.presence && !samePlace(before.get(p.clientId), p.presence)) this.peerMoves.set(p.clientId, now);
    }
    for (const id of this.peerMoves.keys()) if (!peers.some((p) => p.clientId === id)) this.peerMoves.delete(id);
    this.peers = peers;
    this.emit();
  }

  /** When this person last moved to another cell or sheet, or started or stopped typing; undefined if never seen moving. */
  peerMovedAt(clientId: string): number | undefined {
    return this.peerMoves.get(clientId);
  }

  /** Jumps to a cell, on another sheet if need be (following someone in the sheet). */
  goTo(sheetId: string, row: number, col: number): void {
    this.setActiveSheet(sheetId);
    if (this.activeSheetId !== sheetId) return;
    const sheet = this.sheet;
    this.select(cellSelection(Math.min(row, sheet.rowCount - 1), Math.min(col, sheet.colCount - 1)));
  }

  setReadOnly(readOnly: boolean): void {
    if (this.readOnly === readOnly) return;
    this.readOnly = readOnly;
    if (readOnly) this.editing = null;
    this.emit();
  }

  /** Applies a local op and records it for undo. Read-only sheets ignore it. */
  apply(op: Op): void {
    if (this.readOnly) return;
    const normalized = normalize(op);
    const before = this.selection;
    const sheetId = this.activeSheetId;
    const inverse = this.run(normalized);
    this.undoStack.push({ op: normalized, inverse, sheetId, selection: before });
    if (this.undoStack.length > UNDO_LIMIT) this.undoStack.shift();
    this.redoStack = [];
    this.ensureActiveSheet();
    this.options.onOp?.(normalized);
    this.emit();
  }

  undo(): void {
    if (this.readOnly) return;
    const entry = this.undoStack.pop();
    if (!entry) return;
    const redoInverse = this.run(entry.inverse);
    this.redoStack.push({ op: entry.inverse, inverse: redoInverse, sheetId: entry.sheetId, selection: this.selection });
    this.options.onOp?.(entry.inverse);
    this.restore(entry);
  }

  redo(): void {
    if (this.readOnly) return;
    const entry = this.redoStack.pop();
    if (!entry) return;
    const inverse = this.run(entry.inverse);
    this.undoStack.push({ op: entry.inverse, inverse, sheetId: entry.sheetId, selection: this.selection });
    this.options.onOp?.(entry.inverse);
    this.restore(entry);
  }

  private run(op: Op): Op {
    return this.options.applyOp ? this.options.applyOp(op) : applyOp(this.engine, op);
  }

  /**
   * Someone else's op was applied (under this user's unconfirmed edits). Undo
   * and redo entries are moved past it, newest first, so undoing still
   * reverses this user's own change where it now is.
   */
  remoteOp(op: Op): void {
    for (const stack of [this.undoStack, this.redoStack]) {
      let against = op;
      for (let i = stack.length - 1; i >= 0; i--) {
        const entry = stack[i]!;
        const inverse = transform(entry.inverse, against, true);
        against = transform(against, entry.inverse, false);
        entry.inverse = inverse;
      }
    }
    this.afterOutsideChange();
  }

  /** The room sent a fresh copy of the workbook (first load is the constructor). Undo history no longer applies. */
  replaceEngine(engine: Engine): void {
    this.engine = engine;
    this.undoStack = [];
    this.redoStack = [];
    this.editing = null;
    this.afterOutsideChange();
  }

  /** Keeps the active sheet and selection valid after a change this user did not make. */
  private afterOutsideChange(): void {
    this.ensureActiveSheet();
    const sheet = this.sheet;
    const { active } = this.selection;
    if (active.row >= sheet.rowCount || active.col >= sheet.colCount) {
      // Rows or columns under the selection were deleted.
      this.selection = cellSelection(Math.min(active.row, sheet.rowCount - 1), Math.min(active.col, sheet.colCount - 1));
      this.editing = null;
    }
    this.emit();
  }

  private restore(entry: UndoEntry): void {
    this.editing = null;
    if (this.engine.workbook.getSheet(entry.sheetId)) {
      this.activeSheetId = entry.sheetId;
      this.selection = entry.selection;
    }
    this.ensureActiveSheet();
    this.emit();
  }

  private ensureActiveSheet(): void {
    if (!this.engine.workbook.getSheet(this.activeSheetId)) {
      this.activeSheetId = this.engine.workbook.sheets[0]!.id;
      this.selection = this.selections.get(this.activeSheetId) ?? cellSelection(0, 0);
      // An edit open on the vanished sheet would otherwise be committed into this one.
      this.editing = null;
    }
  }

  // -------------------------------------------------------------------------
  // Selection and navigation
  // -------------------------------------------------------------------------

  setActiveSheet(sheetId: string): void {
    if (sheetId === this.activeSheetId || !this.engine.workbook.getSheet(sheetId)) return;
    this.commitEdit();
    this.selections.set(this.activeSheetId, this.selection);
    this.activeSheetId = sheetId;
    this.selection = this.selections.get(sheetId) ?? cellSelection(0, 0);
    this.emit();
  }

  select(selection: Selection): void {
    this.selection = selection;
    this.emit();
  }

  /** Arrow keys: move (or with `extend`, grow the selection); `jump` goes to the edge of the data. */
  move(dRow: number, dCol: number, opts: { extend?: boolean; jump?: boolean } = {}): void {
    const sheet = this.sheet;
    const from = opts.extend ? this.extentCorner() : this.selection.active;
    const [r, c] = opts.jump ? this.dataEdge(from.row, from.col, dRow, dCol) : [from.row + dRow, from.col + dCol];
    let to = { row: clamp(r, 0, sheet.rowCount - 1), col: clamp(c, 0, sheet.colCount - 1) };
    if (!opts.extend) to = this.stepOverMerge(from, to, dRow, dCol);
    this.selection = opts.extend ? extendTo(this.selection, to) : cellSelection(to.row, to.col);
    this.emit();
  }

  /** Moving into a merged cell lands on its top-left; moving out of one leaves from its far edge. */
  private stepOverMerge(from: CellPos, to: CellPos, dRow: number, dCol: number): CellPos {
    const sheet = this.sheet;
    const merge = sheet.mergeAt(to.row, to.col);
    if (!merge || (dRow === 0 && dCol === 0)) return to;
    if (merge.r1 !== from.row || merge.c1 !== from.col) return { row: merge.r1, col: merge.c1 };
    return {
      row: dRow > 0 ? Math.min(sheet.rowCount - 1, merge.r2 + 1) : to.row,
      col: dCol > 0 ? Math.min(sheet.colCount - 1, merge.c2 + 1) : to.col,
    };
  }

  /** Enter/Tab inside a multi-cell selection walks through it instead of leaving it. */
  advance(dRow: number, dCol: number): void {
    const r = primaryRange(this.selection);
    const single = r.r1 === r.r2 && r.c1 === r.c2 && this.selection.ranges.length === 1;
    if (single) {
      this.move(dRow, dCol);
      return;
    }
    this.selection = { ...this.selection, active: walkRange(r, this.selection.active, dRow, dCol) };
    this.emit();
  }

  /** The corner of the primary range opposite the anchor (what shift+arrow moves). */
  private extentCorner(): CellPos {
    const r = primaryRange(this.selection);
    const a = this.selection.anchor;
    return { row: a.row === r.r1 ? r.r2 : r.r1, col: a.col === r.c1 ? r.c2 : r.c1 };
  }

  private hasValue(row: number, col: number): boolean {
    return this.engine.getValue(this.activeSheetId, row, col) !== null;
  }

  /** Ctrl+arrow: to the last filled cell of a block, or the next filled cell, or the sheet edge. */
  private dataEdge(row: number, col: number, dRow: number, dCol: number): [number, number] {
    const sheet = this.sheet;
    const inBounds = (r: number, c: number) => r >= 0 && c >= 0 && r < sheet.rowCount && c < sheet.colCount;
    let r = row;
    let c = col;
    if (!inBounds(r + dRow, c + dCol)) return [r, c];
    if (this.hasValue(r, c) && this.hasValue(r + dRow, c + dCol)) {
      while (inBounds(r + dRow, c + dCol) && this.hasValue(r + dRow, c + dCol)) {
        r += dRow;
        c += dCol;
      }
      return [r, c];
    }
    r += dRow;
    c += dCol;
    while (inBounds(r + dRow, c + dCol) && !this.hasValue(r, c)) {
      r += dRow;
      c += dCol;
    }
    return [r, c];
  }

  // -------------------------------------------------------------------------
  // Cell editing
  // -------------------------------------------------------------------------

  /** What the editor shows for a cell: '=' + localized formula, or the value as typed. */
  inputText(row: number, col: number): string {
    const cell = this.engine.getCell(this.activeSheetId, row, col);
    if (!cell) return '';
    if (cell.f !== undefined) return `=${localizeFormula(cell.f, this.options.formulaLocale)}`;
    return this.valueAsInput(cell.v, this.engine.workbook.style(this.sheet, row, col));
  }

  private valueAsInput(v: Scalar, style: CellStyle | undefined): string {
    if (v === null) return '';
    if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
    if (isError(v)) return v.code;
    if (typeof v === 'string') {
      // Text that would read back as something else keeps a leading apostrophe.
      const parsed = parseInput(v, { locale: this.options.locale });
      return parsed.kind === 'value' && parsed.value === v ? v : `'${v}`;
    }
    return this.numberAsInput(v, style?.numFmt);
  }

  /** Dates edit as dates, percentages as "12%", everything else as a plain number. */
  private numberAsInput(v: number, fmt: string | undefined): string {
    if (fmt && isDateFormat(fmt)) {
      const hasDate = Math.floor(v) !== 0;
      const hasTime = v % 1 !== 0;
      const code = [hasDate ? dateInputCode(this.options.locale) : '', hasTime ? 'h:mm:ss' : ''].filter(Boolean).join(' ');
      return formatValue(v, code || dateInputCode(this.options.locale), this.options.locale).text;
    }
    if (fmt && formatCategory(fmt) === 'percent') {
      return `${formatValue(v * 100, 'General', this.options.locale).text}%`;
    }
    return formatValue(v, 'General', this.options.locale).text;
  }

  beginEdit(opts: { text?: string; origin?: 'cell' | 'bar' } = {}): void {
    if (this.readOnly) return;
    const { row, col } = this.selection.active;
    const replace = opts.text !== undefined;
    this.editing = {
      row,
      col,
      text: opts.text ?? this.inputText(row, col),
      origin: opts.origin ?? 'cell',
      replace,
    };
    this.emit();
  }

  updateEdit(text: string, origin?: 'cell' | 'bar'): void {
    if (!this.editing) return;
    this.editing = { ...this.editing, text, origin: origin ?? this.editing.origin };
    this.emit();
  }

  cancelEdit(): void {
    if (!this.editing) return;
    this.editing = null;
    this.emit();
  }

  /** Writes the edit into the cell; returns whether there was one. */
  commitEdit(): boolean {
    const edit = this.editing;
    if (!edit) return false;
    this.editing = null;
    if (edit.text !== this.inputText(edit.row, edit.col)) {
      this.setInput(edit.row, edit.col, edit.text);
    } else {
      this.emit();
    }
    return true;
  }

  /** Interprets typed text (number, date, %, formula, …) and writes it to a cell. */
  setInput(row: number, col: number, text: string): void {
    const ops: Op[] = [{ type: 'setCells', sheetId: this.activeSheetId, cells: [[row, col, this.contentFor(text)]] }];
    const numFmt = this.impliedFormat(text, row, col);
    if (numFmt) {
      ops.push({ type: 'formatRanges', sheetId: this.activeSheetId, ranges: [{ r1: row, c1: col, r2: row, c2: col }], patch: { numFmt } });
    }
    this.apply({ type: 'batch', ops });
  }

  /** Writes the same input into every cell of the selection (ctrl+enter). */
  fillSelection(text: string): void {
    const cells: CellPatch[] = [];
    const sheet = this.sheet;
    const anchor = this.selection.active;
    for (const r of this.selection.ranges) {
      const g = clampToGrid(r, sheet.rowCount, sheet.colCount);
      for (let row = g.r1; row <= g.r2; row++) {
        for (let col = g.c1; col <= g.c2; col++) {
          const content = this.contentFor(text);
          if (content?.f !== undefined) content.f = translateFormula(content.f, row - anchor.row, col - anchor.col);
          cells.push([row, col, content]);
        }
      }
    }
    this.editing = null;
    this.apply({ type: 'setCells', sheetId: this.activeSheetId, cells });
  }

  private contentFor(text: string): CellPatch[2] {
    const parsed = parseInput(text, { locale: this.options.locale });
    if (parsed.kind === 'formula') return { f: delocalizeFormula(parsed.formula, this.options.formulaLocale) };
    return parsed.value === null ? null : { v: parsed.value };
  }

  /** The number format typing implies ("12%", "€ 5", a date), unless the cell already has one. */
  private impliedFormat(text: string, row: number, col: number): string | undefined {
    const parsed = parseInput(text, { locale: this.options.locale });
    if (parsed.kind !== 'value' || !parsed.numFmt) return undefined;
    const current = this.engine.workbook.style(this.sheet, row, col)?.numFmt;
    if (current && current !== 'General') return undefined;
    return parsed.numFmt;
  }

  // -------------------------------------------------------------------------
  // Commands on the selection
  // -------------------------------------------------------------------------

  clearContents(): void {
    const cells: CellPatch[] = [];
    for (const r of this.selection.ranges) {
      this.sheet.cells.forEachInRange(r, (row, col, cell) => {
        if (cell.v !== null || cell.f !== undefined) cells.push([row, col, null]);
      });
    }
    if (cells.length) this.apply({ type: 'setCells', sheetId: this.activeSheetId, cells });
  }

  format(patch: StylePatch): void {
    this.apply({ type: 'formatRanges', sheetId: this.activeSheetId, ranges: this.selection.ranges, patch });
  }

  /** Effective style of the active cell (toolbar state). */
  activeStyle(): CellStyle {
    const { row, col } = this.selection.active;
    return this.engine.workbook.style(this.sheet, row, col) ?? {};
  }

  /** Bold/italic/… toggles follow the active cell, like every spreadsheet. */
  toggle(key: 'bold' | 'italic' | 'underline' | 'strike'): void {
    this.format({ [key]: this.activeStyle()[key] ? null : true });
  }

  /** Adds or removes decimals on the active cell's number format. */
  changeDecimals(delta: 1 | -1): void {
    const style = this.activeStyle();
    const { row, col } = this.selection.active;
    const value = this.engine.getValue(this.activeSheetId, row, col);
    let fmt = style.numFmt && style.numFmt !== 'General' ? style.numFmt : undefined;
    if (!fmt) {
      const decimals = typeof value === 'number' ? decimalsOf(value) : 0;
      fmt = decimals > 0 ? `0.${'0'.repeat(decimals)}` : '0';
    }
    this.format({ numFmt: adjustDecimals(fmt, delta) });
  }

  clearFormatting(): void {
    const sheet = this.sheet;
    const ops: Op[] = [];
    for (const r of this.selection.ranges) {
      const cells: [number, number, string | null][] = [];
      sheet.cells.forEachInRange(r, (row, col, cell) => {
        if (cell.s !== undefined) cells.push([row, col, null]);
      });
      // Formatting whole columns or rows is kept on the column or row itself.
      const cols = isWholeColumns(r) ? styledIn(sheet.cols.styles, r.c1, r.c2) : [];
      const rows = isWholeRows(r) ? styledIn(sheet.rows.styles, r.r1, r.r2) : [];
      ops.push({ type: 'setStyles', sheetId: this.activeSheetId, cells, rows, cols });
    }
    this.apply({ type: 'batch', ops });
  }

  setBorders(kind: BorderKind, side: BorderSide = { style: 'thin' }): void {
    const sheet = this.sheet;
    const r = clampToGrid(primaryRange(this.selection), sheet.rowCount, sheet.colCount);
    const strip = (r1: number, c1: number, r2: number, c2: number, patch: StylePatch): Op | null =>
      r1 > r2 || c1 > c2 ? null : { type: 'formatRanges', sheetId: this.activeSheetId, ranges: [{ r1, c1, r2, c2 }], patch };
    const strips: (Op | null)[] = [];
    const top = () => strips.push(strip(r.r1, r.c1, r.r1, r.c2, { borderTop: side }));
    const bottom = () => strips.push(strip(r.r2, r.c1, r.r2, r.c2, { borderBottom: side }));
    const left = () => strips.push(strip(r.r1, r.c1, r.r2, r.c1, { borderLeft: side }));
    const right = () => strips.push(strip(r.r1, r.c2, r.r2, r.c2, { borderRight: side }));
    const inner = () => {
      strips.push(strip(r.r1, r.c1, r.r2 - 1, r.c2, { borderBottom: side }));
      strips.push(strip(r.r1, r.c1, r.r2, r.c2 - 1, { borderRight: side }));
    };
    const actions: Record<BorderKind, () => void> = {
      all: () => strips.push(strip(r.r1, r.c1, r.r2, r.c2, { borderTop: side, borderRight: side, borderBottom: side, borderLeft: side })),
      outer: () => [top, bottom, left, right].forEach((f) => f()),
      inner,
      top,
      bottom,
      left,
      right,
      none: () =>
        strips.push(strip(r.r1, r.c1, r.r2, r.c2, { borderTop: null, borderRight: null, borderBottom: null, borderLeft: null })),
    };
    actions[kind]();
    this.apply({ type: 'batch', ops: strips.filter((o): o is Op => o !== null) });
  }

  /**
   * The Σ menu: on a single cell, start typing the function; on a range,
   * write =FN(range) into the cell below it (or right of a single row).
   */
  insertFunction(name: string): void {
    const sheet = this.sheet;
    const r = clampToGrid(primaryRange(this.selection), sheet.rowCount, sheet.colCount);
    if (r.r1 === r.r2 && r.c1 === r.c2) {
      this.beginEdit({ text: `=${name}(` });
      return;
    }
    const ref = `${formatA1(r.r1, r.c1)}:${formatA1(r.r2, r.c2)}`;
    const target = r.r1 === r.r2 ? { row: r.r1, col: Math.min(r.c2 + 1, sheet.colCount - 1) } : { row: Math.min(r.r2 + 1, sheet.rowCount - 1), col: r.c1 };
    this.apply({ type: 'setCells', sheetId: this.activeSheetId, cells: [[target.row, target.col, { f: `${name}(${ref})` }]] });
    this.select(cellSelection(target.row, target.col));
  }

  insertDims(axis: 'row' | 'col', where: 'before' | 'after'): void {
    const r = primaryRange(this.selection);
    const [lo, hi] = axis === 'row' ? [r.r1, r.r2] : [r.c1, r.c2];
    const count = Math.min(hi - lo + 1, 1000);
    const at = where === 'before' ? lo : hi + 1;
    this.apply({ type: 'insertDims', sheetId: this.activeSheetId, sheetName: this.sheet.name, axis, at, count });
  }

  deleteDims(axis: 'row' | 'col'): void {
    const r = clampToGrid(primaryRange(this.selection), this.sheet.rowCount, this.sheet.colCount);
    const [lo, hi] = axis === 'row' ? [r.r1, r.r2] : [r.c1, r.c2];
    this.apply({ type: 'deleteDims', sheetId: this.activeSheetId, sheetName: this.sheet.name, axis, at: lo, count: hi - lo + 1 });
    const { row, col } = this.selection.active;
    this.select(cellSelection(axis === 'row' ? Math.min(lo, this.sheet.rowCount - 1) : row, axis === 'col' ? Math.min(lo, this.sheet.colCount - 1) : col));
  }

  resize(axis: 'row' | 'col', indices: number[], size: number | null): void {
    this.apply({ type: 'resizeDims', sheetId: this.activeSheetId, axis, entries: indices.map((i) => [i, size]) });
  }

  /** Indices of the selected whole rows/columns, or of the active cell's row/column. */
  selectedIndices(axis: 'row' | 'col'): number[] {
    const out = new Set<number>();
    const grid = this.sheet;
    for (const r of this.selection.ranges) {
      const g = clampToGrid(r, grid.rowCount, grid.colCount);
      const [lo, hi] = axis === 'row' ? [g.r1, g.r2] : [g.c1, g.c2];
      for (let i = lo; i <= hi; i++) out.add(i);
    }
    return [...out].sort((a, b) => a - b);
  }

  setHidden(axis: 'row' | 'col', hidden: boolean): void {
    this.apply({ type: 'hideDims', sheetId: this.activeSheetId, axis, indices: this.selectedIndices(axis), hidden });
  }

  toggleMerge(): void {
    const r = primaryRange(this.selection);
    const merged = this.sheet.merges.some((m) => m.r1 <= r.r2 && r.r1 <= m.r2 && m.c1 <= r.c2 && r.c1 <= m.c2);
    if (merged) {
      this.apply({ type: 'unmerge', sheetId: this.activeSheetId, ranges: [r] });
      return;
    }
    if (isWholeColumns(r) || isWholeRows(r) || (r.r1 === r.r2 && r.c1 === r.c2)) return;
    // Merging keeps the top-left value, as in every spreadsheet.
    const clear: CellPatch[] = [];
    this.sheet.cells.forEachInRange(r, (row, col, cell) => {
      if ((row !== r.r1 || col !== r.c1) && (cell.v !== null || cell.f !== undefined)) clear.push([row, col, null]);
    });
    this.apply({
      type: 'batch',
      ops: [
        { type: 'setCells', sheetId: this.activeSheetId, cells: clear },
        { type: 'merge', sheetId: this.activeSheetId, ranges: [r] },
      ],
    });
    this.select({ ...this.selection, active: { row: r.r1, col: r.c1 } });
  }

  /** Freeze up to (not including) the active cell's row/column; 0 unfreezes. */
  setFreeze(rows: number, cols: number): void {
    this.apply({ type: 'setFreeze', sheetId: this.activeSheetId, rows, cols });
  }

  // -------------------------------------------------------------------------
  // Sheets
  // -------------------------------------------------------------------------

  addSheet(): void {
    const id = newSheetId();
    const name = this.uniqueSheetName('Sheet');
    this.apply({ type: 'addSheet', sheetId: id, name, index: this.engine.workbook.sheets.length });
    this.setActiveSheet(id);
  }

  duplicateSheet(sheetId: string): void {
    const source = this.engine.workbook.getSheet(sheetId);
    if (!source) return;
    const index = this.engine.workbook.sheets.indexOf(source) + 1;
    const id = newSheetId();
    const snapshot = this.engine.workbook.toJSON().sheets.find((s) => s.id === sheetId)!;
    this.apply({ type: 'addSheet', sheetId: id, name: this.uniqueSheetName(`${source.name} copy`, true), index, snapshot });
    this.setActiveSheet(id);
  }

  renameSheet(sheetId: string, name: string): boolean {
    const sheet = this.engine.workbook.getSheet(sheetId);
    const trimmed = name.trim();
    if (!sheet || !trimmed || trimmed === sheet.name) return false;
    if (/[\\/?*[\]:]/.test(trimmed) || trimmed.length > 100) return false;
    const clash = this.engine.workbook.getSheetByName(trimmed);
    if (clash && clash.id !== sheetId) return false;
    this.apply({ type: 'renameSheet', sheetId, oldName: sheet.name, name: trimmed });
    return true;
  }

  deleteSheet(sheetId: string): void {
    const sheet = this.engine.workbook.getSheet(sheetId);
    if (!sheet || this.engine.workbook.sheets.length <= 1) return;
    this.apply({ type: 'deleteSheet', sheetId, sheetName: sheet.name });
  }

  moveSheet(sheetId: string, index: number): void {
    this.apply({ type: 'moveSheet', sheetId, index });
  }

  setTabColor(sheetId: string, color: string | null): void {
    this.apply({ type: 'setSheetProps', sheetId, props: { tabColor: color } });
  }

  private uniqueSheetName(base: string, exactFirst = false): string {
    const taken = (n: string) => !!this.engine.workbook.getSheetByName(n);
    if (exactFirst && !taken(base)) return base;
    for (let i = exactFirst ? 2 : this.engine.workbook.sheets.length + 1; ; i++) {
      const name = exactFirst ? `${base} ${i}` : `${base}${i}`;
      if (!taken(name)) return name;
    }
  }

  // -------------------------------------------------------------------------
  // Read helpers for the UI
  // -------------------------------------------------------------------------

  /** The text a cell shows and its colour from the number format. */
  displayText(row: number, col: number): { text: string; color?: string } {
    const value = this.engine.getValue(this.activeSheetId, row, col);
    if (value === null) return { text: '' };
    const style = this.engine.workbook.style(this.sheet, row, col);
    return formatValue(value, style?.numFmt, this.options.locale);
  }

  /** Sum / average / count of the numbers in the selection (status bar). */
  selectionStats(): { count: number; numbers: number; sum: number; min: number; max: number } | null {
    const ranges = this.selection.ranges;
    if (ranges.length === 1) {
      const r = ranges[0]!;
      if (r.r1 === r.r2 && r.c1 === r.c2) return null;
    }
    let count = 0;
    let numbers = 0;
    let sum = 0;
    let min = Infinity;
    let max = -Infinity;
    for (const r of ranges) {
      this.engine.forEachValue(this.activeSheetId, r, (_row, _col, v) => {
        count++;
        if (typeof v === 'number') {
          numbers++;
          sum += v;
          if (v < min) min = v;
          if (v > max) max = v;
        }
      });
    }
    return { count, numbers, sum, min, max };
  }

  snapshot(): WorkbookSnapshot {
    return this.engine.toSnapshot();
  }
}

/** Entries clearing the row or column styles set between `from` and `to`. */
function styledIn(styles: ReadonlyMap<number, string>, from: number, to: number): [number, null][] {
  return [...styles.keys()].filter((i) => i >= from && i <= to).map((i) => [i, null]);
}

/** Same sheet, same active cell, same typing state (a selection drag alone is not a move). */
function samePlace(a: Presence | undefined, b: Presence): boolean {
  return !!a && a.sheetId === b.sheetId && a.active.row === b.active.row && a.active.col === b.active.col && !!a.editing === !!b.editing;
}

export function newSheetId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return `sh_${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

/** One step through a range: Tab runs along rows, Enter down columns, wrapping at the edges. */
export function walkRange(r: Range, pos: CellPos, dRow: number, dCol: number): CellPos {
  if (dCol !== 0) {
    const [col, carry] = wrapStep(pos.col + dCol, r.c1, r.c2);
    return { row: carry === 0 ? pos.row : wrapStep(pos.row + carry, r.r1, r.r2)[0], col };
  }
  const [row, carry] = wrapStep(pos.row + dRow, r.r1, r.r2);
  return { row, col: carry === 0 ? pos.col : wrapStep(pos.col + carry, r.c1, r.c2)[0] };
}

/** `v` wrapped into [lo, hi], with the carry (+1 past the end, -1 before the start). */
function wrapStep(v: number, lo: number, hi: number): [number, number] {
  if (v > hi) return [lo, 1];
  if (v < lo) return [hi, -1];
  return [v, 0];
}

function decimalsOf(n: number): number {
  const s = String(n);
  const i = s.indexOf('.');
  return i < 0 || s.includes('e') ? 0 : Math.min(10, s.length - i - 1);
}

/** "0.00" → "0.000" (delta 1) or "0.0" (delta -1), applied to every section of the code. */
export function adjustDecimals(code: string, delta: 1 | -1): string {
  return code
    .split(';')
    .map((section) => adjustSectionDecimals(section, delta))
    .join(';');
}

const isPlaceholder = (ch: string | undefined) => ch === '0' || ch === '#' || ch === '?';

/** Changes the decimals of the first number placeholder run, skipping quoted text and [tags]. */
function adjustSectionDecimals(section: string, delta: 1 | -1): string {
  let i = 0;
  while (i < section.length) {
    const ch = section[i]!;
    if (ch === '"') i = skipPast(section, i, '"');
    else if (ch === '[') i = skipPast(section, i, ']');
    else if (isPlaceholder(ch)) return withDecimals(section, i, delta);
    else i++;
  }
  return section;
}

function withDecimals(section: string, start: number, delta: 1 | -1): string {
  let end = start;
  while (isPlaceholder(section[end]) || section[end] === ',') end++;
  let fracEnd = end;
  if (section[end] === '.') {
    fracEnd = end + 1;
    while (isPlaceholder(section[fracEnd])) fracEnd++;
  }
  const decimals = Math.max(0, fracEnd - end - 1);
  const next = Math.max(0, decimals + delta);
  const fraction = next > 0 ? `.${'0'.repeat(next)}` : '';
  return section.slice(0, end) + fraction + section.slice(fracEnd);
}

function skipPast(s: string, from: number, close: string): number {
  const end = s.indexOf(close, from + 1);
  return end < 0 ? s.length : end + 1;
}

function dateInputCode(locale: FormatLocale): string {
  switch (locale.dateOrder) {
    case 'dmy':
      return 'd-m-yyyy';
    case 'ymd':
      return 'yyyy-mm-dd';
    default:
      return 'm/d/yyyy';
  }
}

