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
  conditionalStyleAt,
  passesValidation,
  validationAt,
  chartData,
  pivotTableAt,
  pivotTablesOn,
  localSerial,
  type BorderSide,
  type CellContent,
  type Chart,
  type ChartData,
  type CellPatch,
  type ConditionalStyle,
  type DataValidation,
  type FormatCache,
  type CellStyle,
  type FormatLocale,
  type FormulaLocale,
  type Op,
  type Peer,
  type PivotTable,
  type PivotTableLayout,
  type Presence,
  type Range,
  type Scalar,
  type StylePatch,
  type WorkbookSnapshot,
} from '@weldsuite/sheets-engine';
import { autofill, lastFilled, type FillCell, type FillOptions } from './autofill';
import {
  cellAfter,
  cellSelection,
  clampToGrid,
  extendTo,
  isWholeColumns,
  isWholeRows,
  primaryRange,
  selectionAfter,
  wholeColumns,
  wholeRows,
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

/** The side panels of the editor. */
export type SidePanel = 'formats' | 'validation' | 'chart' | 'pivot' | 'comments' | 'versions' | 'data' | null;

/** A pivot table on the active sheet, with the number format each of its values shows in. */
type PivotOutput = PivotTableLayout & { formats: (string | undefined)[] };

export interface ControllerOptions {
  locale: FormatLocale;
  formulaLocale: FormulaLocale;
  /** Every local op, after it is applied (autosave in the preview). */
  onOp?: (op: Op) => void;
  /** Who new comments are by (the signed-in person). */
  author?: { id: string; name: string };
  /**
   * The sheet has comments (default true). Their text lives in its WeldChat
   * chat, so a sheet kept only in the browser has none.
   */
  comments?: boolean;
  /** Typed input a strict validation rule refused (the cell keeps its value). */
  onInputRefused?: (rule: DataValidation) => void;
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
  /** The side panel the editor shows. */
  panel: SidePanel = null;
  /** The chart picked on the grid: moved, resized and deleted there, edited in the chart panel. */
  selectedChart: string | null = null;
  /**
   * May add comments while read-only: a commenter (a viewer with
   * `sheets:comment`). Editors always may.
   */
  canComment = false;
  /** The thread the comments panel shows first (picked on the grid or from a link). */
  focusedThread: string | null = null;
  /** A new comment on the active cell was asked for (Ctrl+Alt+M, the menu); the comments panel opens its box. */
  commentRequested = false;
  /** The find bar (Ctrl+F), with replacing (Ctrl+H), when open. */
  find: 'find' | 'replace' | null = null;
  /** Bumped on every change; the React snapshot. */
  version = 0;
  /** Bumped when the workbook changes (not the selection or a panel): what the memos of charts and pivot tables key on. */
  private contentVersion = 0;
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
    // A snapshot saved with its results loads without evaluating every formula.
    this.engine = new Engine(workbook, undefined, snapshot ?? undefined);
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

  /** Rule results for the current version (the renderer asks per visible cell). */
  private ruleMemo: { version: number; formats: FormatCache; styles: Map<number, ConditionalStyle | undefined> } | null = null;
  /** Per sheet: chart ids are only unique within one (an imported file numbers them per sheet). */
  private chartMemo: { version: number; sheetId: string; data: Map<string, ChartData> } | null = null;
  private commentMemo: { version: number; sheetId: string; cells: Map<number, boolean> } | null = null;
  private pivotMemo: { version: number; sheetId: string; tables: PivotOutput[] } | null = null;

  openPanel(panel: SidePanel): void {
    this.panel = panel;
    this.emit();
  }

  /** Opens the find bar (replacing needs edit rights), or closes it with null. */
  openFind(mode: 'find' | 'replace' | null): void {
    this.find = mode === 'replace' && this.readOnly ? 'find' : mode;
    this.emit();
  }

  /** Picks a chart (null: none); the chart panel goes with it. */
  selectChart(id: string | null): void {
    this.selectedChart = id;
    if (id === null && this.panel === 'chart') this.panel = null;
    this.emit();
  }

  /** The picked chart, while it is on the active sheet. */
  get chart(): Chart | undefined {
    return this.selectedChart ? this.sheet.charts.find((c) => c.id === this.selectedChart) : undefined;
  }

  /** What a chart on the active sheet shows now (the renderer asks on every draw). */
  chartData(chart: Chart): ChartData {
    let memo = this.chartMemo;
    if (memo?.version !== this.contentVersion || memo.sheetId !== this.activeSheetId) {
      memo = { version: this.contentVersion, sheetId: this.activeSheetId, data: new Map() };
      this.chartMemo = memo;
    }
    let data = memo.data.get(chart.id);
    if (!data) {
      data = chartData(this.engine, this.activeSheetId, chart);
      memo.data.set(chart.id, data);
    }
    return data;
  }

  /** May write comments: an editor, or a commenter (on a sheet that has comments). */
  get mayComment(): boolean {
    return this.options.comments !== false && (!this.readOnly || this.canComment);
  }

  setCanComment(canComment: boolean): void {
    if (this.canComment === canComment) return;
    this.canComment = canComment;
    this.emit();
  }

  /**
   * Commits a comment op. Comments are not part of undo (as in Google Sheets):
   * the op goes out like anyone's edit and the undo history moves past it.
   */
  commitComments(op: Op): void {
    if (!this.mayComment) return;
    const normalized = normalize(op);
    this.run(normalized);
    this.rebaseHistory(normalized);
    this.options.onOp?.(normalized);
    this.emit();
  }

  /** Opens the comments panel with a box for a new comment on the active cell. */
  startComment(): void {
    if (!this.mayComment) return;
    this.commentRequested = true;
    this.panel = 'comments';
    this.emit();
  }

  /** Opens the comments panel on a thread (null: just the panel). */
  openThread(threadId: string | null): void {
    this.focusedThread = threadId;
    this.panel = 'comments';
    this.emit();
  }

  /** Whether a cell of the active tab has a thread: true for an open one, false for only resolved ones. */
  commentAt(row: number, col: number): boolean | undefined {
    const sheet = this.sheet;
    if (sheet.comments.length === 0) return undefined;
    let memo = this.commentMemo;
    if (memo?.version !== this.contentVersion || memo.sheetId !== this.activeSheetId) {
      const cells = new Map<number, boolean>();
      for (const c of sheet.comments) {
        if (!c.cell) continue;
        const key = c.cell.row * 16_384 + c.cell.col;
        cells.set(key, cells.get(key) === true || !c.resolved);
      }
      memo = { version: this.contentVersion, sheetId: this.activeSheetId, cells };
      this.commentMemo = memo;
    }
    return memo.cells.get(row * 16_384 + col);
  }

  /** The pivot table the active cell holds or shows part of (the pivot editor edits it). */
  get pivot(): PivotTable | null {
    const { row, col } = this.selection.active;
    return pivotTableAt(this.engine, this.activeSheetId, row, col);
  }

  /**
   * A cell's style: its own, over what a pivot table gives its output (bold
   * headings and totals, the number format of the field a value sums).
   */
  cellStyle(row: number, col: number): CellStyle | undefined {
    const own = this.engine.workbook.style(this.sheet, row, col);
    const pivot = this.pivotStyle(row, col);
    return pivot ? { ...pivot, ...own } : own;
  }

  private pivotStyle(row: number, col: number): CellStyle | undefined {
    for (const t of this.pivotTables()) {
      const a = t.area;
      if (row < a.r1 || row > a.r2 || col < a.c1 || col > a.c2) continue;
      const i = row - a.r1;
      const value = t.layout.valueOf[col - a.c1] ?? -1;
      const style: CellStyle = {};
      if (i < t.layout.headerRows || t.layout.totalRows.includes(i)) style.bold = true;
      const numFmt = value >= 0 && i >= t.layout.headerRows ? t.formats[value] : undefined;
      if (numFmt) style.numFmt = numFmt;
      return style;
    }
    return undefined;
  }

  /** The pivot tables on the active sheet with their layout, worked out once per change. */
  private pivotTables(): PivotOutput[] {
    const memo = this.pivotMemo;
    if (memo?.version === this.contentVersion && memo.sheetId === this.activeSheetId) return memo.tables;
    const tables = pivotTablesOn(this.engine, this.activeSheetId).map((t) => ({ ...t, formats: this.valueFormats(t) }));
    this.pivotMemo = { version: this.contentVersion, sheetId: this.activeSheetId, tables };
    return tables;
  }

  /** For each value of a pivot table, the number format of its field's first value (none for counts). */
  private valueFormats(t: PivotTableLayout): (string | undefined)[] {
    const source = t.source!;
    const sheet = this.engine.workbook.getSheet(source.sheetId);
    if (!sheet) return [];
    const { r1, c1, c2 } = source.range;
    const fieldCol = (field: string) => {
      for (let c = c1; c <= c2; c++) {
        const name = this.engine.getValue(source.sheetId, r1, c);
        if (typeof name === 'string' && name.trim().toLowerCase() === field.trim().toLowerCase()) return c;
      }
      return -1;
    };
    return t.spec.values.map((v) => {
      if (v.fn === 'COUNT' || v.fn === 'COUNTA' || v.fn === 'COUNTUNIQUE') return undefined;
      const col = fieldCol(v.field);
      return col < 0 ? undefined : this.engine.workbook.style(sheet, r1 + 1, col)?.numFmt;
    });
  }

  /** The conditional formatting a cell gets right now, if any. */
  conditionalStyle(row: number, col: number): ConditionalStyle | undefined {
    const sheet = this.sheet;
    if (sheet.conditionalFormats.length === 0) return undefined;
    if (this.ruleMemo?.version !== this.version) this.ruleMemo = { version: this.version, formats: new Map(), styles: new Map() };
    const key = row * 16_384 + col;
    const memo = this.ruleMemo.styles;
    if (!memo.has(key)) memo.set(key, conditionalStyleAt(this.engine, sheet, row, col, this.ruleMemo.formats));
    return memo.get(key);
  }

  /** The validation rule a cell on the active sheet follows. */
  validationAt(row: number, col: number): DataValidation | undefined {
    const sheet = this.sheet;
    return sheet.validations.length ? validationAt(sheet, row, col) : undefined;
  }

  /** The cell's value fails its validation rule (shown with a marker). */
  isInvalid(row: number, col: number): boolean {
    const rule = this.validationAt(row, col);
    if (!rule) return false;
    const value = this.engine.getValue(this.activeSheetId, row, col);
    return !passesValidation(this.engine, { sheetId: this.activeSheetId, row, col }, rule, value, this.options.locale);
  }

  /** Ticks or unticks a checkbox cell. */
  toggleCheckbox(row: number, col: number): void {
    if (this.readOnly || this.validationAt(row, col)?.criteria.type !== 'checkbox') return;
    const current = this.engine.getValue(this.activeSheetId, row, col);
    this.apply({ type: 'setCells', sheetId: this.activeSheetId, cells: [[row, col, { v: current !== true }]] });
  }

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
    this.contentVersion++;
    return this.options.applyOp ? this.options.applyOp(op) : applyOp(this.engine, op);
  }

  /**
   * Someone else's op was applied (under this user's unconfirmed edits). Undo
   * and redo entries are moved past it, newest first, so undoing still
   * reverses this user's own change where it now is.
   */
  remoteOp(op: Op): void {
    this.rebaseHistory(op);
    this.followRemote(op);
    this.afterOutsideChange();
  }

  /** Moves the undo and redo entries past an op that is not in them, newest first. */
  private rebaseHistory(op: Op): void {
    for (const stack of [this.undoStack, this.redoStack]) {
      let against = op;
      for (let i = stack.length - 1; i >= 0; i--) {
        const entry = stack[i]!;
        const inverse = transform(entry.inverse, against, true);
        against = transform(against, entry.inverse, false);
        entry.inverse = inverse;
      }
    }
  }

  /**
   * Moves what the user points at through rows and columns the other person
   * inserted, deleted or moved, so a cell being edited is still that cell
   * (Enter must not write into whatever now sits at its old address). An edit
   * whose cell was deleted is dropped.
   */
  private followRemote(op: Op): void {
    this.selection = selectionAfter(op, this.activeSheetId, this.selection);
    for (const [id, sel] of this.selections) this.selections.set(id, selectionAfter(op, id, sel));
    const edit = this.editing;
    if (!edit) return;
    const cell = cellAfter(op, this.activeSheetId, edit);
    this.editing = cell ? { ...edit, row: cell.row, col: cell.col } : null;
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
    this.contentVersion++;
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
    // A refused edit belongs to the sheet being left: drop it.
    if (!this.commitEdit()) this.editing = null;
    this.selections.set(this.activeSheetId, this.selection);
    this.activeSheetId = sheetId;
    this.selection = this.selections.get(sheetId) ?? cellSelection(0, 0);
    this.dropChart();
    this.followPivot();
    this.emit();
  }

  /** Selecting cells puts a picked chart down, and opens the pivot editor on a pivot table. */
  select(selection: Selection): void {
    this.selection = selection;
    this.dropChart();
    this.followPivot();
    this.emit();
  }

  /** The pivot editor comes up on a pivot table's cells and goes off them; other panels stay. */
  private followPivot(): void {
    if (this.panel !== null && this.panel !== 'pivot') return;
    const { row, col } = this.selection.active;
    this.panel = pivotTableAt(this.engine, this.activeSheetId, row, col) ? 'pivot' : null;
  }

  private dropChart(): void {
    if (this.selectedChart === null) return;
    this.selectedChart = null;
    if (this.panel === 'chart') this.panel = null;
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

  /** What the editor shows for a cell (of the active sheet by default): '=' + localized formula, or the value as typed. */
  inputText(row: number, col: number, sheetId = this.activeSheetId): string {
    const cell = this.engine.getCell(sheetId, row, col);
    const sheet = this.engine.workbook.getSheet(sheetId);
    if (!cell || !sheet) return '';
    if (cell.f !== undefined) return `=${localizeFormula(cell.f, this.options.formulaLocale)}`;
    return this.valueAsInput(cell.v, this.engine.workbook.style(sheet, row, col));
  }

  /** Bumped on every change to the workbook (not the selection): what lookups over its cells key on. */
  get contentRevision(): number {
    return this.contentVersion;
  }

  /** Writes typed input into cells of any sheets, as one change (replace all). */
  setInputs(entries: { sheetId: string; row: number; col: number; text: string }[]): void {
    const bySheet = new Map<string, CellPatch[]>();
    for (const e of entries) {
      const cells = bySheet.get(e.sheetId) ?? [];
      cells.push([e.row, e.col, this.contentFor(e.text)]);
      bySheet.set(e.sheetId, cells);
    }
    if (bySheet.size === 0) return;
    this.apply({ type: 'batch', ops: [...bySheet].map(([sheetId, cells]) => ({ type: 'setCells', sheetId, cells }) as Op) });
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

  /**
   * Writes the edit into the cell. Returns false when a strict validation rule
   * refused it: the edit then stays open, with its text, to be corrected.
   */
  commitEdit(): boolean {
    const edit = this.editing;
    if (!edit) return true;
    this.editing = null;
    if (edit.text === this.inputText(edit.row, edit.col)) {
      this.emit();
      return true;
    }
    if (this.setInput(edit.row, edit.col, edit.text)) return true;
    this.editing = { ...edit, replace: false };
    this.emit();
    return false;
  }

  /** Interprets typed text (number, date, %, formula, …) and writes it to a cell; false when a strict rule refused it. */
  setInput(row: number, col: number, text: string): boolean {
    const content = this.contentFor(text);
    // A strict rule refuses a typed value that fails it; a formula's result is only marked.
    const rule = this.validationAt(row, col);
    if (rule?.strict && content?.f === undefined) {
      const value = content?.v ?? null;
      if (!passesValidation(this.engine, { sheetId: this.activeSheetId, row, col }, rule, value, this.options.locale)) {
        this.options.onInputRefused?.(rule);
        this.emit();
        return false;
      }
    }
    const ops: Op[] = [{ type: 'setCells', sheetId: this.activeSheetId, cells: [[row, col, content]] }];
    const numFmt = this.impliedFormat(text, row, col);
    if (numFmt) {
      ops.push({ type: 'formatRanges', sheetId: this.activeSheetId, ranges: [{ r1: row, c1: col, r2: row, c2: col }], patch: { numFmt } });
    }
    this.apply({ type: 'batch', ops });
    return true;
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

  // -------------------------------------------------------------------------
  // Autofill
  // -------------------------------------------------------------------------

  /** A cell as a fill reads it: content, own style and number format. */
  fillCell = (row: number, col: number): FillCell => {
    const cell = this.sheet.cells.get(row, col);
    return { content: contentOf(cell), style: cell?.s ?? null, numFmt: this.engine.workbook.style(this.sheet, row, col)?.numFmt };
  };

  /** The selection a fill starts from: its one range, within the grid; null for several ranges. */
  fillSource(): Range | null {
    if (this.selection.ranges.length !== 1) return null;
    const sheet = this.sheet;
    return clampToGrid(primaryRange(this.selection), sheet.rowCount, sheet.colCount);
  }

  /**
   * The fill handle was let go over `target`: the selection continues into it
   * as a series (`toggle`: Ctrl held, copy instead), or, pulled back inside
   * the selection, the cells it left are cleared. The fill becomes the selection.
   */
  fill(target: Range, toggle = false): void {
    const source = this.fillSource();
    if (!source || this.readOnly) return;
    const sheet = this.sheet;
    const t = capFill(source, clampToGrid(target, sheet.rowCount, sheet.colCount));
    const { anchor, active } = this.selection;
    const inside = (r: Range, row: number, col: number) => row >= r.r1 && row <= r.r2 && col >= r.c1 && col <= r.c2;
    if (inside(source, t.r1, t.c1) && inside(source, t.r2, t.c2)) {
      if (t.r2 === source.r2 && t.c2 === source.c2) return;
      const cells: CellPatch[] = [];
      sheet.cells.forEachInRange(source, (row, col, cell) => {
        if (!inside(t, row, col) && (cell.v !== null || cell.f !== undefined)) cells.push([row, col, null]);
      });
      if (cells.length) this.apply({ type: 'setCells', sheetId: this.activeSheetId, cells });
      const keep = (p: CellPos) => ({ row: Math.min(p.row, t.r2), col: Math.min(p.col, t.c2) });
      this.select({ ranges: [t], active: keep(active), anchor: keep(anchor) });
      return;
    }
    this.applyFill(source, t, { toggle, locale: this.options.locale });
    this.select({ ranges: [t], active, anchor });
  }

  private applyFill(source: Range, target: Range, opts: FillOptions): void {
    const result = autofill(source, target, this.fillCell, opts);
    if (!result || result.setCells.length === 0) return;
    const sheetId = this.activeSheetId;
    this.apply({
      type: 'batch',
      ops: [
        { type: 'setCells', sheetId, cells: result.setCells },
        { type: 'setStyles', sheetId, cells: result.setStyles },
      ],
    });
  }

  /** What the last cell of a fill to `target` would show (the hint next to the dragged handle). */
  fillHint(target: Range, toggle = false): string | null {
    const source = this.fillSource();
    if (!source) return null;
    const vertical = target.r1 !== source.r1 || target.r2 !== source.r2;
    const line = vertical ? this.selection.active.col : this.selection.active.row;
    const last = lastFilled(source, target, line, this.fillCell, { toggle, locale: this.options.locale });
    const v = last?.content?.v;
    if (v === undefined || v === null) return null;
    return formatValue(v, last!.numFmt, this.options.locale).text;
  }

  /**
   * Ctrl+D / Ctrl+R: copies the selection's first row down (first column
   * right) over the rest of it; a single row (column) copies the one above
   * (to the left). Formulas move as they would when pasted.
   */
  fillDown(): void {
    this.fillAlong('row');
  }

  fillRight(): void {
    this.fillAlong('col');
  }

  private fillAlong(axis: 'row' | 'col'): void {
    const sheet = this.sheet;
    const primary = primaryRange(this.selection);
    let r = clampToGrid(primary, sheet.rowCount, sheet.colCount);
    // Whole columns (rows) fill as far as there is data, not a million cells.
    const used = this.engine.usedRange(this.activeSheetId);
    if (axis === 'row' && isWholeColumns(primary)) r = { ...r, r2: Math.max(r.r1, Math.min(r.r2, used?.r2 ?? 0)) };
    if (axis === 'col' && isWholeRows(primary)) r = { ...r, c2: Math.max(r.c1, Math.min(r.c2, used?.c2 ?? 0)) };
    const source = copiedAlong(r, axis);
    if (!source) return;
    const target = axis === 'row' ? { ...r, r1: source.r1 } : { ...r, c1: source.c1 };
    this.applyFill(source, capFill(source, target), { toggle: false, copy: true, locale: this.options.locale });
  }

  /**
   * A double-click on the fill handle: fills down as far as the data in the
   * column next to the selection goes (left, else right), stopping above the
   * first filled cell under the selection.
   */
  fillToAdjacent(): void {
    const source = this.fillSource();
    if (!source || this.readOnly) return;
    const sheet = this.sheet;
    for (const col of [source.c1 - 1, source.c2 + 1]) {
      if (col < 0 || col >= sheet.colCount || !this.hasValue(source.r2 + 1, col)) continue;
      let end = source.r2;
      while (end + 1 < sheet.rowCount && this.hasValue(end + 1, col) && !this.rowHasValue(end + 1, source.c1, source.c2)) end++;
      if (end > source.r2) this.fill({ ...source, r2: end });
      return;
    }
  }

  private rowHasValue(row: number, c1: number, c2: number): boolean {
    for (let c = c1; c <= c2; c++) if (this.hasValue(row, c)) return true;
    return false;
  }

  /** Ctrl+; and Ctrl+Shift+; : today's date or the time now, as a value, into the active cell. */
  insertNow(kind: 'date' | 'time'): void {
    if (this.readOnly) return;
    const now = new Date();
    const serial = localSerial(now.getTime(), now.getTimezoneOffset());
    const v = kind === 'date' ? Math.floor(serial) : serial - Math.floor(serial);
    const numFmt = kind === 'date' ? dateInputCode(this.options.locale) : 'h:mm:ss';
    const { row, col } = this.selection.active;
    const sheetId = this.activeSheetId;
    this.apply({
      type: 'batch',
      ops: [
        { type: 'setCells', sheetId, cells: [[row, col, { v }]] },
        { type: 'formatRanges', sheetId, ranges: [{ r1: row, c1: col, r2: row, c2: col }], patch: { numFmt } },
      ],
    });
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

  /**
   * Moves `count` rows or columns from `from` to before `to` (an index
   * before the move, dragging their headers), and keeps them selected.
   */
  moveDimsTo(axis: 'row' | 'col', from: number, count: number, to: number): void {
    if (to >= from && to <= from + count) return;
    this.apply({ type: 'moveDims', sheetId: this.activeSheetId, sheetName: this.sheet.name, axis, from, count, to });
    const start = to < from ? to : to - count;
    const end = start + count - 1;
    const active = axis === 'col' ? { row: 0, col: start } : { row: start, col: 0 };
    this.select({ ranges: [axis === 'col' ? wholeColumns(start, end) : wholeRows(start, end)], active, anchor: active });
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
    return formatValue(value, this.cellStyle(row, col)?.numFmt, this.options.locale);
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

/** What a cell holds, as a cell write would set it. */
function contentOf(cell: { v: Scalar; f?: string } | undefined): CellContent | null {
  if (!cell) return null;
  if (cell.f !== undefined) return { f: cell.f };
  return cell.v === null ? null : ({ v: cell.v } as CellContent);
}

/**
 * What Ctrl+D (Ctrl+R) copies over `r`: its first row (column), or for a
 * single row the one above it (column: left of it). Null at the sheet's edge.
 */
function copiedAlong(r: Range, axis: 'row' | 'col'): Range | null {
  if (axis === 'row') {
    if (r.r1 !== r.r2) return { ...r, r2: r.r1 };
    return r.r1 === 0 ? null : { ...r, r1: r.r1 - 1, r2: r.r1 - 1 };
  }
  if (r.c1 !== r.c2) return { ...r, c2: r.c1 };
  return r.c1 === 0 ? null : { ...r, c1: r.c1 - 1, c2: r.c1 - 1 };
}

/** Most cells one fill writes; a fill further than that stops short. */
const MAX_FILL_CELLS = 1_000_000;

/** `target` cut back so the cells it adds to `source` stay within MAX_FILL_CELLS. */
function capFill(source: Range, target: Range): Range {
  const across = target.r1 !== source.r1 || target.r2 !== source.r2 ? source.c2 - source.c1 + 1 : source.r2 - source.r1 + 1;
  const most = Math.floor(MAX_FILL_CELLS / across);
  if (target.r2 - source.r2 > most) return { ...target, r2: source.r2 + most };
  if (source.r1 - target.r1 > most) return { ...target, r1: source.r1 - most };
  if (target.c2 - source.c2 > most) return { ...target, c2: source.c2 + most };
  if (source.c1 - target.c1 > most) return { ...target, c1: source.c1 - most };
  return target;
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

