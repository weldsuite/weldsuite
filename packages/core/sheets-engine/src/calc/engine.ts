/**
 * The calculation engine: a Workbook plus everything needed to keep its
 * formula values current.
 *
 * Edits mark work (`pendingCells` for changed values, `pendingFormulas` for
 * changed formulas); `recalc()` then finds every affected formula by walking
 * the dependency graph from those roots with an iterative DFS and evaluates
 * them in reverse post-order, i.e. topologically, without recursion. If the
 * static graph misses something (INDIRECT, OFFSET), reading a still-dirty
 * cell evaluates it on demand. Cycles evaluate to #REF!.
 *
 * Array results spill into the cells below/right of the formula as an
 * overlay; those cells are not stored. A spill that would cover content
 * evaluates to #SPILL! and re-spills once the way is clear.
 *
 * Inserting, deleting or moving rows and columns moves cells and rewrites
 * references so every formula still reads the cells it read. The graph then
 * follows only the formulas that moved or were rewritten, and only those whose
 * result can differ are evaluated (see `followDims`).
 */

import { MAX_COLS, MAX_ROWS, rangesIntersect as rangesOverlap, type Range } from '../address';
import { evaluate, resolveResult } from '../formula/evaluator';
import { getFunction } from '../formula/functions';
import { FormulaSyntaxError, parseFormula, type AstNode } from '../formula/parser';
import {
  adjustForDelete,
  adjustForInsert,
  adjustForMove,
  indexAfterDelete,
  moveIndexMapper,
  removeSheetFromFormula,
  renameSheetInFormula,
  type Axis,
} from '../formula/references';
import type { EvalContext, EvalHost } from '../formula/types';
import type { Cell } from '../model/cell-store';
import { cloneFilter, mapFilterFormulas, mapFormatFormulas, mapValidationFormulas, type SheetFilter } from '../model/rules';
import { Sheet, Workbook, type WorkbookSnapshot } from '../model/workbook';
import { filteredRows } from '../rules/evaluate';
import { err, isError, isMatrix, sameScalar, type CellError, type Scalar } from '../values';
import { DependencyGraph, SHEET_STRIDE, globalKey, splitKey, type Precedent } from './graph';
import { SccWalker } from './scc';
import { anchorAfter, mapChartFormulas } from '../model/charts';
import { commentAfter } from '../model/anchors';

export interface EngineOptions {
  /** Clock for NOW()/TODAY(), epoch ms. */
  now?: () => number;
  random?: () => number;
  /** Minutes, Date#getTimezoneOffset semantics. */
  timezoneOffset?: () => number;
}

/** What a cell holds as typed: a literal value or a formula (without '='). */
export interface CellContent {
  v?: Scalar;
  f?: string;
}

/** A formula whose text a structural change rewrote, with its text before. */
export interface RewrittenFormula {
  sheetId: string;
  row: number;
  col: number;
  before: string;
}

interface SpillRecord {
  anchor: number;
  sheet: number;
  area: Range;
  data: Scalar[][];
}

const CIRCULAR: CellError = err('#REF!', 'Circular dependency');
/** Host name for workbook-wide defined names: matches no sheet, so their unprefixed references never move. */
const NO_SHEET = '\u0000';
const TOO_DEEP: CellError = err('#CALC!', 'Too many levels of formulas depending on each other');
const MAX_PULL_DEPTH = 256;
/** Recalculation passes: extra ones re-run readers of changed spills and of chains cut off at MAX_PULL_DEPTH. */
const MAX_PASSES = 16;
/** Rule formulas kept parsed (conditional formats, validation, filters). */
const MAX_RULE_ASTS = 500;
/**
 * Cell formulas kept parsed. A parsed formula takes a few hundred bytes and
 * parsing one takes about a microsecond, so a big sheet keeps the most recent
 * ones and parses the rest again when they are next evaluated.
 */
const MAX_ASTS = 100_000;

/**
 * The Web Crypto global, present in browsers, Workers and Node 20+. Declared
 * here because the package compiles without the DOM lib.
 */
declare const crypto: { getRandomValues(array: Uint32Array): Uint32Array };

const randomWords = new Uint32Array(2);

/** A uniform number in [0, 1) with 53 random bits, as Math.random gives, from the platform's CSPRNG. */
function secureRandom(): number {
  crypto.getRandomValues(randomWords);
  return (randomWords[0]! * 2 ** 21 + (randomWords[1]! >>> 11)) / 2 ** 53;
}

export class Engine implements EvalHost {
  readonly workbook: Workbook;
  private readonly graph = new DependencyGraph();
  private readonly asts = new Map<number, AstNode | FormulaSyntaxError>();
  private readonly sheetNums = new Map<string, number>();
  private readonly sheetIdsByNum = new Map<number, string>();
  private nextSheetNum = 0;

  private readonly spills = new Map<number, SpillRecord>();
  private readonly spillsBySheet = new Map<number, Set<SpillRecord>>();
  /** Anchors whose spill is blocked, with the area they want. */
  private readonly blocked = new Map<number, { sheet: number; area: Range }>();
  private readonly used = new Map<number, Range | null>();

  private pendingCells: number[] = [];
  private readonly pendingFormulas = new Set<number>();
  private readonly dirty = new Set<number>();
  private readonly computing = new Set<number>();
  private pullDepth = 0;
  /** Formulas that read a value a depth-limited pull left stale; re-run next pass. */
  private readonly truncated = new Set<number>();
  private passNow = 0;
  /** Formulas that read row visibility (SUBTOTAL, AGGREGATE): re-run when rows are hidden, shown or filtered. */
  private readonly visibilityReaders = new Set<number>();
  /** Formulas whose result is a position (ROW, COLUMN): re-run when rows or columns are inserted, deleted or moved. */
  private readonly positionReaders = new Set<number>();
  /** Formulas being evaluated, innermost last (for visibilityReaders). */
  private readonly evaluating: number[] = [];
  /** Sheets whose filter has to be re-applied: their values or their filter changed. */
  private readonly filterStale = new Set<string>();
  /** Parsed rule formulas (filters, conditional formats, validation), by text. */
  private readonly ruleAsts = new Map<string, AstNode | FormulaSyntaxError>();

  /**
   * `calculated`: the snapshot the workbook was read from, when its values are
   * current (`WorkbookSnapshot.calculated`): its spills are put back and only
   * volatile formulas are evaluated. Otherwise every formula is.
   */
  constructor(
    workbook: Workbook = new Workbook(),
    private readonly options: EngineOptions = {},
    calculated?: WorkbookSnapshot,
  ) {
    this.workbook = workbook;
    for (const s of workbook.sheets) this.sheetNum(s.id);
    if (calculated?.calculated) {
      this.rebuild(false);
      this.restoreSpills(calculated);
    } else {
      this.rebuild();
    }
    this.recalc();
  }

  static fromSnapshot(snapshot: WorkbookSnapshot, options?: EngineOptions): Engine {
    return new Engine(Workbook.fromJSON(snapshot), options, snapshot);
  }

  /** The workbook, with its spilled arrays and marked `calculated` when nothing is waiting to be recalculated. */
  toSnapshot(): WorkbookSnapshot {
    const snapshot = this.workbook.toJSON();
    if (this.pendingCells.length > 0 || this.pendingFormulas.size > 0) return snapshot;
    snapshot.sheets.forEach((sheet, i) => {
      const records = this.spillsBySheet.get(this.sheetNum(this.workbook.sheets[i]!.id));
      if (!records?.size) return;
      sheet.spills = [...records]
        .map((rec): [number, number, Scalar[][]] => [rec.area.r1, rec.area.c1, rec.data.map((row) => [...row])])
        .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    });
    snapshot.calculated = true;
    return snapshot;
  }

  /**
   * Spills a calculated snapshot stored, put back as they were: each on a
   * formula cell, inside the sheet. One that is not (the snapshot was edited
   * by hand) has its formula evaluated instead.
   */
  private restoreSpills(snapshot: WorkbookSnapshot): void {
    for (const s of snapshot.sheets) {
      const sheet = this.workbook.getSheet(s.id);
      if (!sheet) continue;
      const sheetNum = this.sheetNum(s.id);
      for (const [row, col, data] of s.spills ?? []) {
        const key = globalKey(sheetNum, row, col);
        const area: Range = { r1: row, c1: col, r2: row + data.length - 1, c2: col + (data[0]?.length ?? 1) - 1 };
        if (sheet.cells.get(row, col)?.f === undefined || data.length === 0 || area.r2 >= MAX_ROWS || area.c2 >= MAX_COLS) {
          this.pendingFormulas.add(key);
          continue;
        }
        const rec: SpillRecord = { anchor: key, sheet: sheetNum, area, data };
        this.spills.set(key, rec);
        let set = this.spillsBySheet.get(sheetNum);
        if (!set) {
          set = new Set();
          this.spillsBySheet.set(sheetNum, set);
        }
        set.add(rec);
      }
      // A spill that was blocked has to be told when its way clears: its formula runs again.
      sheet.cells.forEach((row, col, cell) => {
        if (cell.f !== undefined && isError(cell.v) && cell.v.code === '#SPILL!') this.pendingFormulas.add(globalKey(sheetNum, row, col));
      });
    }
  }

  // -------------------------------------------------------------------------
  // Reading
  // -------------------------------------------------------------------------

  getCell(sheetId: string, row: number, col: number): Cell | undefined {
    return this.workbook.getSheet(sheetId)?.cells.get(row, col);
  }

  /** Displayed value, spills included. Call after `recalc()`. */
  getValue(sheetId: string, row: number, col: number): Scalar {
    return this.cellValue(sheetId, row, col);
  }

  /** If (row, col) shows part of a spilled array, the anchor cell. */
  spillAnchorAt(sheetId: string, row: number, col: number): { row: number; col: number } | undefined {
    const rec = this.spillAt(this.sheetNums.get(sheetId), row, col);
    if (!rec) return undefined;
    const { row: r, col: c } = splitKey(rec.anchor);
    return { row: r, col: c };
  }

  /** The arrays spilled on a sheet: each one's formula cell and area. */
  spillsOn(sheetId: string): { row: number; col: number; area: Range }[] {
    const sheetNum = this.sheetNums.get(sheetId);
    if (sheetNum === undefined) return [];
    return [...(this.spillsBySheet.get(sheetNum) ?? [])].map((rec) => {
      const { row, col } = splitKey(rec.anchor);
      return { row, col, area: rec.area };
    });
  }

  /** Area of the array spilled by the formula at (row, col), if it spills. */
  spillArea(sheetId: string, row: number, col: number): Range | undefined {
    const sheet = this.sheetNums.get(sheetId);
    if (sheet === undefined) return undefined;
    return this.spills.get(globalKey(sheet, row, col))?.area;
  }

  // -------------------------------------------------------------------------
  // EvalHost
  // -------------------------------------------------------------------------

  cellValue(sheetId: string, row: number, col: number): Scalar {
    const sheetNum = this.sheetNums.get(sheetId);
    if (sheetNum === undefined) return null;
    const sheet = this.workbook.getSheet(sheetId);
    const cell = sheet?.cells.get(row, col);
    if (cell?.f !== undefined) {
      const key = globalKey(sheetNum, row, col);
      if (this.computing.has(key)) return CIRCULAR;
      if (this.dirty.has(key)) this.pull(key);
      return cell.v;
    }
    // A cell holding only a style is blank: a spilled value can show through it.
    if (cell && cell.v !== null) return cell.v;
    const rec = this.spillAt(sheetNum, row, col);
    if (!rec) return null;
    if (this.dirty.has(rec.anchor)) {
      this.pull(rec.anchor);
      return this.cellValue(sheetId, row, col);
    }
    return rec.data[row - rec.area.r1]?.[col - rec.area.c1] ?? null;
  }

  forEachValue(sheetId: string, range: Range, fn: (row: number, col: number, value: Scalar) => void): void {
    const sheetNum = this.sheetNums.get(sheetId);
    const sheet = this.workbook.getSheet(sheetId);
    if (sheetNum === undefined || !sheet) return;
    sheet.cells.forEachInRange(range, (row, col, cell) => {
      if (cell.f !== undefined) {
        const key = globalKey(sheetNum, row, col);
        if (this.computing.has(key)) {
          fn(row, col, CIRCULAR);
          return;
        }
        if (this.dirty.has(key)) this.pull(key);
      }
      if (cell.v !== null) fn(row, col, cell.v);
    });
    const spills = this.spillsBySheet.get(sheetNum);
    if (!spills) return;
    for (const rec of [...spills]) {
      const a = rec.area;
      if (a.r1 <= range.r2 && a.r2 >= range.r1 && a.c1 <= range.c2 && a.c2 >= range.c1) forEachSpilled(rec, range, fn);
    }
  }

  usedRange(sheetId: string): Range | null {
    const sheetNum = this.sheetNums.get(sheetId);
    if (sheetNum === undefined) return null;
    if (!this.used.has(sheetNum)) {
      let range = this.workbook.getSheet(sheetId)?.cells.usedRange() ?? null;
      for (const rec of this.spillsBySheet.get(sheetNum) ?? []) range = union(range, rec.area);
      this.used.set(sheetNum, range);
    }
    return this.used.get(sheetNum) ?? null;
  }

  sheetIdByName(name: string): string | undefined {
    return this.workbook.getSheetByName(name)?.id;
  }

  sheetName(sheetId: string): string | undefined {
    return this.workbook.getSheet(sheetId)?.name;
  }

  sheetIds(): string[] {
    return this.workbook.sheets.map((s) => s.id);
  }

  definedName(name: string, sheetId: string): string | undefined {
    const lower = name.toLowerCase();
    const scoped = this.workbook.names.find((n) => n.sheetId === sheetId && n.name.toLowerCase() === lower);
    if (scoped) return scoped.formula;
    return this.workbook.names.find((n) => n.sheetId === undefined && n.name.toLowerCase() === lower)?.formula;
  }

  now(): number {
    return this.passNow || (this.options.now?.() ?? Date.now());
  }

  random(): number {
    return this.options.random?.() ?? secureRandom();
  }

  timezoneOffset(): number {
    return this.options.timezoneOffset?.() ?? new Date().getTimezoneOffset();
  }

  isRowHidden(sheetId: string, row: number, manual: boolean): boolean {
    const reader = this.evaluating.at(-1);
    if (reader !== undefined) this.visibilityReaders.add(reader);
    const rows = this.workbook.getSheet(sheetId)?.rows;
    return !!rows && (rows.isFiltered(row) || (manual && rows.isHidden(row)));
  }

  cellFormula(sheetId: string, row: number, col: number): string | undefined {
    return this.workbook.getSheet(sheetId)?.cells.get(row, col)?.f;
  }

  /**
   * Formula text evaluated as if it were in (row, col) of `sheetId`, storing
   * nothing: the formulas of filters, conditional formats and validation.
   */
  evaluateFormula(sheetId: string, row: number, col: number, formula: string): Scalar | Scalar[][] {
    let ast = this.ruleAsts.get(formula);
    if (!ast) {
      try {
        ast = parseFormula(formula);
      } catch (e) {
        ast = e instanceof FormulaSyntaxError ? e : new FormulaSyntaxError(String(e), 0);
      }
      if (this.ruleAsts.size >= MAX_RULE_ASTS) this.ruleAsts.clear();
      this.ruleAsts.set(formula, ast);
    }
    if (ast instanceof FormulaSyntaxError) return err('#NAME?', `Formula parse error: ${ast.message}`);
    const ctx: EvalContext = { host: this, sheetId, row, col };
    try {
      const result = resolveResult(evaluate(ast, ctx), ctx);
      return isMatrix(result) ? result.data : result;
    } catch (e) {
      return err('#CALC!', e instanceof Error ? e.message : 'Calculation failed');
    }
  }

  // -------------------------------------------------------------------------
  // Writing cells
  // -------------------------------------------------------------------------

  /** Sets what a cell holds (keeping its style); `null` clears it. */
  setContent(sheetId: string, row: number, col: number, content: CellContent | null): void {
    const sheet = this.workbook.requireSheet(sheetId);
    const sheetNum = this.sheetNum(sheetId);
    const key = globalKey(sheetNum, row, col);
    const existing = sheet.cells.get(row, col);
    const formula = content?.f;
    const value = content?.v ?? null;

    if (formula !== undefined) {
      const cell: Cell = {
        v: existing?.f === formula ? existing.v : null,
        f: formula,
      };
      if (existing?.s !== undefined) cell.s = existing.s;
      sheet.cells.set(row, col, cell);
      this.asts.delete(key);
      // The old result's spill goes now, or the new formula would read it as its own input.
      this.clearSpill(key);
      this.registerFormula(key, formula, sheetNum);
      this.pendingFormulas.add(key);
    } else {
      if (existing?.f !== undefined) this.unregisterFormula(key);
      if (value === null && existing?.s === undefined) {
        sheet.cells.set(row, col, undefined);
      } else {
        const cell: Cell = { v: value };
        if (existing?.s !== undefined) cell.s = existing.s;
        sheet.cells.set(row, col, cell);
      }
      this.pendingCells.push(key);
    }
    this.touch(sheetNum, row, col);
  }

  /** Sets a cell's own style key (`undefined` removes it). */
  setStyleKey(sheetId: string, row: number, col: number, key: string | undefined): void {
    const sheet = this.workbook.requireSheet(sheetId);
    const existing = sheet.cells.get(row, col);
    if (!existing) {
      if (key !== undefined) sheet.cells.set(row, col, { v: null, s: key });
      return;
    }
    if (key === undefined) {
      if (existing.v === null && existing.f === undefined) {
        sheet.cells.set(row, col, undefined);
        return;
      }
      delete existing.s;
    } else {
      existing.s = key;
    }
  }

  /** Expands the cached used range and wakes spills that this position affects. */
  private touch(sheetNum: number, row: number, col: number): void {
    this.staleFilter(sheetNum);
    const cached = this.used.get(sheetNum);
    if (cached !== undefined) this.used.set(sheetNum, union(cached, { r1: row, c1: col, r2: row, c2: col }));
    const rec = this.spillAt(sheetNum, row, col);
    if (rec && rec.anchor !== globalKey(sheetNum, row, col)) this.pendingFormulas.add(rec.anchor);
    for (const [anchor, b] of this.blocked) {
      if (b.sheet === sheetNum && row >= b.area.r1 && row <= b.area.r2 && col >= b.area.c1 && col <= b.area.c2) {
        this.pendingFormulas.add(anchor);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Recalculation
  // -------------------------------------------------------------------------

  /** Recalculates everything affected by edits since the last call. Returns the number of formulas evaluated. */
  recalc(): number {
    this.passNow = this.options.now?.() ?? Date.now();
    let evaluated = 0;
    try {
      evaluated += this.runPasses(true);
      // Filters follow the values, and formulas that skip hidden rows follow the filters.
      for (let round = 0; round < 2 && this.refreshFilters(); round++) {
        for (const key of this.visibilityReaders) this.pendingFormulas.add(key);
        evaluated += this.runPasses(false);
      }
    } finally {
      this.dirty.clear();
      this.passNow = 0;
    }
    return evaluated;
  }

  private runPasses(withVolatile: boolean): number {
    let evaluated = 0;
    for (let pass = 0; pass < MAX_PASSES; pass++) {
      const roots = this.pendingCells;
      const formulas = [...this.pendingFormulas];
      if (pass === 0 && withVolatile) formulas.push(...this.graph.volatile);
      this.pendingCells = [];
      this.pendingFormulas.clear();
      if (roots.length === 0 && formulas.length === 0) break;

      const { order, cyclic } = this.topoOrder(roots, formulas);
      for (const key of order) this.dirty.add(key);
      for (const key of order) {
        if (cyclic.has(key)) {
          this.dirty.delete(key);
          // Its last array is no longer its result: the cells it spilled into go blank.
          this.clearSpill(key);
          this.storeValue(key, CIRCULAR);
        } else if (this.dirty.has(key)) {
          this.evaluateCell(key);
        }
        evaluated++;
      }
      this.retryTruncated(pass === MAX_PASSES - 1);
    }
    return evaluated;
  }

  /** Re-applies stale filters; true when the rows any of them hides changed. */
  private refreshFilters(): boolean {
    let changed = false;
    for (const id of this.filterStale) {
      const sheet = this.workbook.getSheet(id);
      if (!sheet) continue;
      const rows = sheet.filter ? filteredRows(this, id, sheet.filter, sheet.rowCount) : new Set<number>();
      if (sheet.rows.setFiltered(rows)) changed = true;
    }
    this.filterStale.clear();
    return changed;
  }

  private staleFilter(sheetNum: number): void {
    const id = this.sheetIdsByNum.get(sheetNum);
    if (id !== undefined && this.workbook.getSheet(id)?.filter) this.filterStale.add(id);
  }

  /** Rows were hidden or shown by hand: formulas that skip hidden rows recalculate. */
  visibilityChanged(): void {
    for (const key of this.visibilityReaders) this.pendingFormulas.add(key);
    this.recalc();
  }

  /** Sets or removes the sheet's filter and re-applies it. Returns the previous one. */
  setFilter(sheetId: string, filter: SheetFilter | null): SheetFilter | null {
    const sheet = this.workbook.requireSheet(sheetId);
    const previous = sheet.filter;
    sheet.filter = filter ? cloneFilter(filter) : null;
    this.filterStale.add(sheetId);
    this.recalc();
    return previous;
  }

  /** Re-evaluates every formula (after load from a file, or a structural change). */
  recalcAll(): number {
    for (const key of this.graph.formulaKeys()) this.pendingFormulas.add(key);
    return this.recalc();
  }

  /**
   * Formulas affected by changes at `roots` (positions) and the formulas in
   * `formulas`, in evaluation order, with the members of every cycle.
   *
   * Strongly connected components of the dependents graph (Tarjan, iterative
   * so a million-long chain cannot overflow the stack). A component with more
   * than one formula, or a formula reading itself, is a cycle; every member is
   * cyclic whatever order the cells were entered in. Tarjan finishes a
   * component after everything that reads it, so the reversed finish order is
   * the evaluation order.
   */
  private topoOrder(roots: number[], formulas: number[]): { order: number[]; cyclic: Set<number> } {
    const scc = new SccWalker((key) => this.dependentsOfFormula(key));
    // Starting points are visited last-first so that formulas without edges
    // between them (INDIRECT chains) come out in the order they were written.
    const starts = formulas.filter((key) => this.graph.hasFormula(key));
    for (const pos of roots) {
      const { sheet, row, col } = splitKey(pos);
      this.graph.dependentsOf(sheet, row, col, (d) => starts.push(d));
    }
    for (let i = starts.length - 1; i >= 0; i--) scc.visit(starts[i]!);
    return scc.result();
  }

  /**
   * Formulas that read the cell a formula sits in, or any cell it spills into.
   * A blocked spill writes nothing, so its area's readers are not dependents
   * (it is woken through `touch` and `markChanged` when the area changes).
   */
  private dependentsOfFormula(key: number): number[] {
    const out: number[] = [];
    const { sheet, row, col } = splitKey(key);
    this.graph.dependentsOf(sheet, row, col, (d) => out.push(d));
    const rec = this.spills.get(key);
    if (rec) this.graph.dependentsOfRange(sheet, rec.area, (d) => out.push(d));
    return out;
  }

  /**
   * A pull that hit the depth limit left stale values in the formulas that were
   * evaluating (dynamic chains such as INDIRECT have no static edges to order
   * them). They run again next pass, now that more of the chain is computed;
   * on the last pass they get an error rather than a silently wrong number.
   */
  private retryTruncated(lastPass: boolean): void {
    if (this.truncated.size === 0) return;
    for (const key of this.truncated) {
      if (lastPass) this.storeValue(key, TOO_DEEP);
      else this.pendingFormulas.add(key);
    }
    this.truncated.clear();
  }

  private pull(key: number): void {
    if (this.pullDepth >= MAX_PULL_DEPTH) {
      for (const k of this.computing) this.truncated.add(k);
      return;
    }
    this.pullDepth++;
    try {
      this.evaluateCell(key);
    } finally {
      this.pullDepth--;
    }
  }

  private evaluateCell(key: number): void {
    this.dirty.delete(key);
    const { sheet: sheetNum, row, col } = splitKey(key);
    const sheetId = this.sheetIdsByNum.get(sheetNum);
    const cell = sheetId ? this.workbook.getSheet(sheetId)?.cells.get(row, col) : undefined;
    if (!sheetId || cell?.f === undefined) return;

    const ast = this.ast(key, cell.f);
    let result: Scalar | ReturnType<typeof resolveResult>;
    if (ast instanceof FormulaSyntaxError) {
      result = err('#NAME?', `Formula parse error: ${ast.message}`);
    } else {
      const ctx: EvalContext = { host: this, sheetId, row, col };
      this.computing.add(key);
      this.evaluating.push(key);
      try {
        result = resolveResult(evaluate(ast, ctx), ctx);
      } catch (e) {
        result = err('#CALC!', e instanceof Error ? e.message : 'Calculation failed');
      } finally {
        this.computing.delete(key);
        this.evaluating.pop();
      }
    }

    if (isMatrix(result)) {
      this.storeValue(key, this.spill(key, sheetNum, row, col, result.data));
    } else {
      this.clearSpill(key);
      this.storeValue(key, result);
    }
  }

  private storeValue(key: number, value: Scalar): void {
    const { sheet: sheetNum, row, col } = splitKey(key);
    const sheetId = this.sheetIdsByNum.get(sheetNum);
    const cell = sheetId ? this.workbook.getSheet(sheetId)?.cells.get(row, col) : undefined;
    if (!cell) return;
    // An empty result shows as 0, as in Excel.
    cell.v = value === null ? 0 : value;
    this.staleFilter(sheetNum);
  }

  // -------------------------------------------------------------------------
  // Spills
  // -------------------------------------------------------------------------

  /** Places an array result; returns the anchor's own value (top-left or #SPILL!). */
  private spill(key: number, sheetNum: number, row: number, col: number, data: Scalar[][]): Scalar {
    const rows = data.length;
    const cols = data[0]?.length ?? 0;
    const area: Range = {
      r1: row,
      c1: col,
      r2: row + rows - 1,
      c2: col + cols - 1,
    };
    if (area.r2 >= MAX_ROWS || area.c2 >= MAX_COLS) {
      this.clearSpill(key);
      this.blocked.set(key, {
        sheet: sheetNum,
        area: {
          ...area,
          r2: Math.min(area.r2, MAX_ROWS - 1),
          c2: Math.min(area.c2, MAX_COLS - 1),
        },
      });
      return err('#SPILL!', 'Spill range runs off the sheet');
    }
    if (this.spillBlocked(key, sheetNum, area)) {
      this.clearSpill(key);
      this.blocked.set(key, { sheet: sheetNum, area });
      return err('#SPILL!', "Spill range isn't blank");
    }
    this.blocked.delete(key);

    const prev = this.spills.get(key);
    if (prev && sameArea(prev.area, area) && sameData(prev.data, data)) return data[0]![0] ?? null;
    if (prev) this.markChanged(sheetNum, prev.area);
    this.removeSpillRecord(key);
    const rec: SpillRecord = { anchor: key, sheet: sheetNum, area, data };
    this.spills.set(key, rec);
    let set = this.spillsBySheet.get(sheetNum);
    if (!set) {
      set = new Set();
      this.spillsBySheet.set(sheetNum, set);
    }
    set.add(rec);
    const cached = this.used.get(sheetNum);
    if (cached !== undefined) this.used.set(sheetNum, union(cached, area));
    this.markChanged(sheetNum, area);
    return data[0]![0] ?? null;
  }

  private spillBlocked(key: number, sheetNum: number, area: Range): boolean {
    const sheetId = this.sheetIdsByNum.get(sheetNum)!;
    const sheet = this.workbook.getSheet(sheetId)!;
    let blocked = false;
    sheet.cells.forEachInRange(area, (r, c, cell) => {
      if (blocked || (r === area.r1 && c === area.c1)) return;
      if (cell.f !== undefined || cell.v !== null) blocked = true;
    });
    if (blocked) return true;
    for (const other of this.spillsBySheet.get(sheetNum) ?? []) {
      if (other.anchor === key) continue;
      const o = other.area;
      if (o.r1 <= area.r2 && area.r1 <= o.r2 && o.c1 <= area.c2 && area.c1 <= o.c2) return true;
    }
    return false;
  }

  private clearSpill(key: number): void {
    this.blocked.delete(key);
    const rec = this.spills.get(key);
    if (!rec) return;
    this.removeSpillRecord(key);
    this.markChanged(rec.sheet, rec.area);
    this.used.delete(rec.sheet);
  }

  private removeSpillRecord(key: number): void {
    const rec = this.spills.get(key);
    if (!rec) return;
    this.spills.delete(key);
    this.spillsBySheet.get(rec.sheet)?.delete(rec);
  }

  /** Spilled cells changed: their readers, and spills they may have blocked, need another pass. */
  private markChanged(sheetNum: number, area: Range): void {
    this.graph.dependentsOfRange(sheetNum, area, (d) => {
      if (!this.dirty.has(d)) this.pendingFormulas.add(d);
    });
    for (const [anchor, b] of this.blocked) {
      if (b.sheet === sheetNum && !this.dirty.has(anchor) && rangesOverlap(b.area, area)) this.pendingFormulas.add(anchor);
    }
  }

  private spillAt(sheetNum: number | undefined, row: number, col: number): SpillRecord | undefined {
    if (sheetNum === undefined) return undefined;
    const set = this.spillsBySheet.get(sheetNum);
    if (!set) return undefined;
    for (const rec of set) {
      const a = rec.area;
      if (row >= a.r1 && row <= a.r2 && col >= a.c1 && col <= a.c2) return rec;
    }
    return undefined;
  }

  // -------------------------------------------------------------------------
  // Formula registration
  // -------------------------------------------------------------------------

  private ast(key: number, formula: string): AstNode | FormulaSyntaxError {
    let ast = this.asts.get(key);
    if (!ast) {
      try {
        ast = parseFormula(formula);
      } catch (e) {
        ast = e instanceof FormulaSyntaxError ? e : new FormulaSyntaxError(String(e), 0);
      }
      if (this.asts.size >= MAX_ASTS) this.asts.clear();
      this.asts.set(key, ast);
    }
    return ast;
  }

  private registerFormula(key: number, formula: string, sheetNum: number): void {
    const ast = this.ast(key, formula);
    if (ast instanceof FormulaSyntaxError) {
      this.graph.setFormula(key, [], false);
      return;
    }
    const precedents: Precedent[] = [];
    const state: FormulaTraits = { volatile: false, visibility: false, position: false };
    this.analyze(ast, sheetNum, precedents, state, 0);
    this.graph.setFormula(key, precedents, state.volatile);
    // Known before it is evaluated, so a load that evaluates nothing still knows.
    if (state.visibility) this.visibilityReaders.add(key);
    else this.visibilityReaders.delete(key);
    if (state.position) this.positionReaders.add(key);
    else this.positionReaders.delete(key);
  }

  private unregisterFormula(key: number): void {
    this.visibilityReaders.delete(key);
    this.positionReaders.delete(key);
    this.graph.removeFormula(key);
    this.asts.delete(key);
    this.clearSpill(key);
  }

  private analyze(
    node: AstNode,
    sheetNum: number,
    out: Precedent[],
    state: FormulaTraits,
    depth: number,
  ): void {
    switch (node.type) {
      case 'ref': {
        const target = node.ref.sheet === null ? sheetNum : this.sheetNumByName(node.ref.sheet);
        if (target !== undefined) {
          out.push({
            sheet: target,
            r1: node.ref.r1,
            c1: node.ref.c1,
            r2: node.ref.r2,
            c2: node.ref.c2,
          });
        }
        return;
      }
      case 'name': {
        const sheetId = this.sheetIdsByNum.get(sheetNum) ?? '';
        const formula = this.definedName(node.name, sheetId);
        if (formula === undefined || depth > 16) return;
        try {
          this.analyze(parseFormula(formula), sheetNum, out, state, depth + 1);
        } catch {
          // An invalid name evaluates to #NAME?; it has no precedents.
        }
        return;
      }
      case 'call':
        noteFunction(node.name, state);
        for (const a of node.args) this.analyze(a, sheetNum, out, state, depth);
        return;
      case 'unary':
      case 'percent':
        this.analyze(node.arg, sheetNum, out, state, depth);
        return;
      case 'binary':
        this.analyze(node.left, sheetNum, out, state, depth);
        this.analyze(node.right, sheetNum, out, state, depth);
        return;
      default:
        return;
    }
  }

  private sheetNum(sheetId: string): number {
    let n = this.sheetNums.get(sheetId);
    if (n === undefined) {
      n = this.nextSheetNum++;
      this.sheetNums.set(sheetId, n);
      this.sheetIdsByNum.set(n, sheetId);
    }
    return n;
  }

  private sheetNumByName(name: string): number | undefined {
    const id = this.sheetIdByName(name);
    return id === undefined ? undefined : this.sheetNums.get(id);
  }

  /**
   * Re-derives the graph from the formulas in the workbook. With `markDirty`
   * every formula is queued for evaluation.
   */
  rebuild(markDirty = true): void {
    this.graph.clear();
    this.asts.clear();
    this.spills.clear();
    this.spillsBySheet.clear();
    this.blocked.clear();
    this.used.clear();
    this.visibilityReaders.clear();
    this.positionReaders.clear();
    for (const sheet of this.workbook.sheets) {
      this.filterStale.add(sheet.id);
      const sheetNum = this.sheetNum(sheet.id);
      sheet.cells.forEach((row, col, cell) => {
        if (cell.f === undefined) return;
        const key = globalKey(sheetNum, row, col);
        this.registerFormula(key, cell.f, sheetNum);
        if (markDirty) this.pendingFormulas.add(key);
      });
    }
  }

  // -------------------------------------------------------------------------
  // Structural changes. Each returns the formulas whose text it rewrote (at
  // their new positions) so the op layer can build an exact inverse.
  // -------------------------------------------------------------------------

  /**
   * Applies `rewrite` to every formula and defined name. `hostName` is the
   * sheet an unprefixed reference belongs to: the cell's sheet, a scoped name's
   * sheet, or for a workbook-wide name a name no sheet has (its unprefixed
   * references are read on whichever sheet uses the name, so no change moves
   * them; `transform` treats them the same way).
   */
  private rewriteAllFormulas(rewrite: (formula: string, hostName: string) => string): RewrittenFormula[] {
    const rewritten: RewrittenFormula[] = [];
    for (const sheet of this.workbook.sheets) {
      sheet.cells.forEach((row, col, cell) => {
        if (cell.f === undefined) return;
        const next = rewrite(cell.f, sheet.name);
        if (next !== cell.f) {
          rewritten.push({ sheetId: sheet.id, row, col, before: cell.f });
          cell.f = next;
        }
      });
    }
    for (const name of this.workbook.names) {
      const scope = name.sheetId ? this.workbook.getSheet(name.sheetId) : undefined;
      name.formula = rewrite(name.formula, scope?.name ?? NO_SHEET);
    }
    for (const sheet of this.workbook.sheets) {
      const fn = (f: string) => rewrite(f, sheet.name);
      if (sheet.filter) sheet.filter = mapFilterFormulas(sheet.filter, fn);
      sheet.conditionalFormats = sheet.conditionalFormats.map((cf) => mapFormatFormulas(cf, fn));
      sheet.validations = sheet.validations.map((dv) => mapValidationFormulas(dv, fn));
      sheet.charts = sheet.charts.map((c) => mapChartFormulas(c, fn));
    }
    return rewritten;
  }

  /** Moves a sheet's filter and rule ranges for a row/column change; a rule left without cells goes. */
  private mapRules(sheet: Sheet, axis: Axis, mapRange: (r: Range) => Range | null, mapIndex: (i: number) => number): void {
    const max = axis === 'row' ? MAX_ROWS : MAX_COLS;
    const [lo, hi] = axis === 'row' ? (['r1', 'r2'] as const) : (['c1', 'c2'] as const);
    const fit = (r: Range): Range | null => {
      const m = mapRange(r);
      if (!m || m[lo] > max - 1) return null;
      return { ...m, [hi]: Math.min(m[hi], max - 1) };
    };
    if (sheet.filter) {
      const range = fit(sheet.filter.range);
      const columns = sheet.filter.columns.flatMap((c) => {
        const col = axis === 'col' ? mapIndex(c.col) : c.col;
        return col < 0 ? [] : [{ ...c, col }];
      });
      sheet.filter = range ? { range, columns } : null;
    }
    const all = (ranges: Range[]) => ranges.map(fit).filter((r): r is Range => r !== null);
    sheet.conditionalFormats = sheet.conditionalFormats.flatMap((cf) => {
      const ranges = all(cf.ranges);
      return ranges.length ? [{ ...cf, ranges }] : [];
    });
    sheet.validations = sheet.validations.flatMap((dv) => {
      const ranges = all(dv.ranges);
      return ranges.length ? [{ ...dv, ranges }] : [];
    });
    sheet.charts = sheet.charts.map((c) => ({ ...c, anchor: anchorAfter(c.anchor, axis, mapIndex, max) }));
    sheet.comments = sheet.comments.map((c) => commentAfter(c, axis, mapIndex, max));
    sheet.dataTables = sheet.dataTables.flatMap((t) => {
      const range = fit(t.range);
      return range ? [{ ...t, range }] : [];
    });
  }

  insertDims(sheetId: string, axis: Axis, at: number, count: number): RewrittenFormula[] {
    const sheet = this.workbook.requireSheet(sheetId);
    const change = { sheet: sheet.name, axis, at, count };
    const names = namesKey(this.workbook);
    // Rewrite first, at the old positions, then move the cells.
    const rewritten = this.rewriteAllFormulas((f, host) => adjustForInsert(f, host, change));
    const shift = (i: number) => (i >= at ? i + count : i);
    const max = axis === 'row' ? MAX_ROWS : MAX_COLS;
    sheet.cells.remap((r, c) => {
      const nr = axis === 'row' ? shift(r) : r;
      const nc = axis === 'col' ? shift(c) : c;
      const moved = axis === 'row' ? nr : nc;
      return moved < max ? [nr, nc] : null;
    });
    (axis === 'row' ? sheet.rows : sheet.cols).insert(at, count);
    sheet.merges = sheet.merges.map((m) => mapRangeInsert(m, axis, at, count));
    this.mapRules(sheet, axis, (r) => mapRangeInsert(r, axis, at, count), shift);
    if (axis === 'row') {
      if (at < sheet.freeze.rows) sheet.freeze.rows += count;
      sheet.rowCount = Math.min(MAX_ROWS, sheet.rowCount + count);
    } else {
      if (at < sheet.freeze.cols) sheet.freeze.cols += count;
      sheet.colCount = Math.min(MAX_COLS, sheet.colCount + count);
    }
    for (const r of rewritten) if (r.sheetId === sheetId) [r.row, r.col] = shiftPos(r.row, r.col, axis, shift);
    const moved = (i: number) => (shift(i) < max ? shift(i) : -1);
    this.followDims(
      {
        sheetId,
        axis,
        map: moved,
        // A range across the insertion grows; one reaching the cells pushed off the sheet loses them.
        cuts: (lo, hi) => (lo < at && at <= hi) || moved(hi) < 0,
      },
      rewritten,
      names,
    );
    return rewritten;
  }

  deleteDims(sheetId: string, axis: Axis, at: number, count: number): RewrittenFormula[] {
    const sheet = this.workbook.requireSheet(sheetId);
    const change = { sheet: sheet.name, axis, at, count };
    const names = namesKey(this.workbook);
    const rewritten = this.rewriteAllFormulas((f, host) => adjustForDelete(f, host, change));
    const shift = (i: number) => indexAfterDelete(i, at, count, -1);
    sheet.cells.remap((r, c) => {
      const i = shift(axis === 'row' ? r : c);
      if (i < 0) return null;
      return axis === 'row' ? [i, c] : [r, i];
    });
    (axis === 'row' ? sheet.rows : sheet.cols).delete(at, count);
    sheet.merges = sheet.merges.flatMap((m) => {
      const next = mapRangeDelete(m, axis, at, count);
      return next && (next.r1 !== next.r2 || next.c1 !== next.c2) ? [next] : [];
    });
    this.mapRules(sheet, axis, (r) => mapRangeDelete(r, axis, at, count), shift);
    const frozen = axis === 'row' ? 'rows' : 'cols';
    const f = sheet.freeze[frozen];
    if (at < f) sheet.freeze[frozen] = Math.max(at, f - Math.min(count, f - at));
    if (axis === 'row') sheet.rowCount = Math.max(1, sheet.rowCount - count);
    else sheet.colCount = Math.max(1, sheet.colCount - count);
    const kept: RewrittenFormula[] = [];
    for (const r of rewritten) {
      if (r.sheetId !== sheetId) {
        kept.push(r);
        continue;
      }
      const i = shift(axis === 'row' ? r.row : r.col);
      if (i < 0) continue; // the formula itself was deleted; the op layer restores it with the rows
      if (axis === 'row') r.row = i;
      else r.col = i;
      kept.push(r);
    }
    // A range that lost cells shrinks (or turns into #REF!).
    this.followDims({ sheetId, axis, map: shift, cuts: (lo, hi) => lo < at + count && hi >= at }, kept, names);
    return kept;
  }

  /** Moves rows/columns [from, from+count) to before index `to` (pre-move numbering). */
  moveDims(sheetId: string, axis: Axis, from: number, count: number, to: number): RewrittenFormula[] {
    const sheet = this.workbook.requireSheet(sheetId);
    const move = { sheet: sheet.name, axis, from, count, to };
    const names = namesKey(this.workbook);
    const rewritten = this.rewriteAllFormulas((f, host) => adjustForMove(f, host, move));
    const map = moveIndexMapper(from, count, to);
    sheet.cells.remap((r, c) => (axis === 'row' ? [map(r), c] : [r, map(c)]));
    (axis === 'row' ? sheet.rows : sheet.cols).remap(map);
    // A merge moves when it stays in one piece; a move that splits it unmerges it.
    sheet.merges = sheet.merges.flatMap((m) => {
      const run = mapRun(axis === 'row' ? m.r1 : m.c1, axis === 'row' ? m.r2 : m.c2, map);
      if (!run) return [];
      return [axis === 'row' ? { ...m, r1: run[0], r2: run[1] } : { ...m, c1: run[0], c2: run[1] }];
    });
    // A rule range a move splits keeps the span its cells now cover.
    this.mapRules(
      sheet,
      axis,
      (r) => {
        const [lo, hi] = axis === 'row' ? [r.r1, r.r2] : [r.c1, r.c2];
        const [a, b] = mapRun(lo, hi, map) ?? mappedBounds(lo, hi, map);
        return axis === 'row' ? { ...r, r1: a, r2: b } : { ...r, c1: a, c2: b };
      },
      map,
    );
    for (const r of rewritten) if (r.sheetId === sheetId) [r.row, r.col] = shiftPos(r.row, r.col, axis, map);
    // Inside the stretch whose order changed, a range may hold other cells or the same ones in another order.
    const lo = Math.min(from, to);
    const hi = Math.max(from + count, to) - 1;
    this.followDims({ sheetId, axis, map, cuts: (a, b) => a <= hi && b >= lo }, rewritten, names);
    return rewritten;
  }

  /**
   * Brings the graph, the spills and the values up to date after rows or
   * columns of one sheet were inserted, deleted or moved: its cells have moved
   * and formula text is rewritten, so every formula still reads the cells it
   * read, and its result is unchanged unless
   *
   * - a range it reads was cut through (it grew, shrank or now holds its
   *   cells in another order), or a cell it reads was deleted;
   * - it reads a position (ROW, COLUMN);
   * - it spills on that sheet, or reads cells a formula spilled there (spills
   *   are an overlay that does not move with the cells);
   * - a defined name was rewritten (then every formula is re-read and
   *   evaluated, as before this was incremental).
   *
   * Those are evaluated, with whatever reads them. The graph re-reads only the
   * formulas that moved or were rewritten; the rest keep their entries.
   */
  private followDims(change: DimsChange, rewritten: RewrittenFormula[], namesBefore: string): void {
    if (namesKey(this.workbook) !== namesBefore) {
      this.rebuild();
      this.recalc();
      return;
    }
    const sheetNum = this.sheetNum(change.sheetId);
    const base = globalKey(sheetNum, 0, 0);
    const { axis, map } = change;
    /** A formula's key once its cell has moved (-1: the cell was deleted). Arithmetic only: it runs for every formula. */
    const moved = (key: number): number => {
      if (key < base || key >= base + SHEET_STRIDE) return key;
      const row = Math.floor((key - base) / MAX_COLS);
      const col = key - base - row * MAX_COLS;
      const i = map(axis === 'row' ? row : col);
      if (i < 0) return -1;
      return axis === 'row' ? base + i * MAX_COLS + col : base + row * MAX_COLS + i;
    };

    // Worked out on the graph as it was (old keys), before it follows the cells.
    const formulas = [...this.graph.formulaKeys()];
    const evaluate = this.affectedByDims(formulas, sheetNum, change);
    this.rereadMoved(formulas, moved, rewritten);
    for (const key of evaluate) {
      const next = moved(key);
      if (next >= 0) this.pendingFormulas.add(next);
    }
    this.staleFilter(sheetNum);
    this.recalc();
  }

  /**
   * Formulas (old keys) whose result a row/column change can alter. The
   * sheet's spills are dropped on the way: their formulas spill again.
   */
  private affectedByDims(formulas: number[], sheetNum: number, change: DimsChange): number[] {
    const evaluate: number[] = [...this.positionReaders];
    for (const key of formulas) if (this.readsAcross(key, sheetNum, change)) evaluate.push(key);
    for (const rec of this.spillsBySheet.get(sheetNum) ?? []) {
      evaluate.push(rec.anchor);
      this.graph.dependentsOfRange(sheetNum, rec.area, (d) => evaluate.push(d));
      this.spills.delete(rec.anchor);
    }
    this.spillsBySheet.delete(sheetNum);
    for (const [anchor, b] of this.blocked) {
      if (b.sheet !== sheetNum) continue;
      evaluate.push(anchor);
      this.blocked.delete(anchor);
    }
    this.used.delete(sheetNum);
    return evaluate;
  }

  /** Formulas that moved leave their old place in the graph; those and the rewritten ones are read again. */
  private rereadMoved(formulas: number[], moved: (key: number) => number, rewritten: RewrittenFormula[]): void {
    const reread = new Set<number>();
    for (const key of formulas) {
      const next = moved(key);
      if (next === key) continue;
      this.graph.removeFormula(key);
      this.asts.delete(key);
      this.visibilityReaders.delete(key);
      this.positionReaders.delete(key);
      if (next >= 0) reread.add(next);
    }
    for (const r of rewritten) reread.add(globalKey(this.sheetNum(r.sheetId), r.row, r.col));
    for (const key of reread) {
      this.asts.delete(key);
      const { sheet, row, col } = splitKey(key);
      const formula = this.workbook.getSheet(this.sheetIdsByNum.get(sheet) ?? '')?.cells.get(row, col)?.f;
      if (formula === undefined) this.unregisterFormula(key);
      else this.registerFormula(key, formula, sheet);
    }
  }

  /** Whether formula `key` reads a range `change` cuts through, or a cell it deletes. */
  private readsAcross(key: number, sheetNum: number, change: DimsChange): boolean {
    const base = globalKey(sheetNum, 0, 0);
    for (const pk of this.graph.pointsOf(key)) {
      if (pk < base || pk >= base + SHEET_STRIDE) continue;
      const row = Math.floor((pk - base) / MAX_COLS);
      if (change.map(change.axis === 'row' ? row : pk - base - row * MAX_COLS) < 0) return true;
    }
    for (const r of this.graph.rangesOf(key)) {
      if (r.sheet !== sheetNum) continue;
      if (change.axis === 'row' ? change.cuts(r.r1, r.r2) : change.cuts(r.c1, r.c2)) return true;
    }
    return false;
  }

  addSheet(sheetId: string, name: string, index: number, sheet?: Sheet): Sheet {
    if (this.workbook.getSheet(sheetId)) throw new Error(`Sheet ${sheetId} exists`);
    const s = sheet ?? new Sheet(sheetId, name);
    s.name = name;
    this.workbook.sheets.splice(Math.max(0, Math.min(index, this.workbook.sheets.length)), 0, s);
    this.sheetNum(sheetId);
    this.rebuild();
    this.recalc();
    return s;
  }

  removeSheet(sheetId: string): {
    sheet: Sheet;
    index: number;
    rewritten: RewrittenFormula[];
  } {
    const index = this.workbook.sheets.findIndex((s) => s.id === sheetId);
    if (index < 0) throw new Error(`Unknown sheet ${sheetId}`);
    const sheet = this.workbook.sheets[index]!;
    this.workbook.sheets.splice(index, 1);
    const rewritten = this.rewriteAllFormulas((f) => removeSheetFromFormula(f, sheet.name));
    this.workbook.names = this.workbook.names.filter((n) => n.sheetId !== sheetId);
    this.rebuild();
    this.recalc();
    return { sheet, index, rewritten };
  }

  renameSheet(sheetId: string, name: string): RewrittenFormula[] {
    const sheet = this.workbook.requireSheet(sheetId);
    const old = sheet.name;
    if (old === name) return [];
    const rewritten = this.rewriteAllFormulas((f) => renameSheetInFormula(f, old, name));
    sheet.name = name;
    this.rebuild();
    this.recalc();
    return rewritten;
  }

  moveSheet(sheetId: string, index: number): void {
    const from = this.workbook.sheets.findIndex((s) => s.id === sheetId);
    if (from < 0) throw new Error(`Unknown sheet ${sheetId}`);
    const [sheet] = this.workbook.sheets.splice(from, 1);
    this.workbook.sheets.splice(Math.max(0, Math.min(index, this.workbook.sheets.length)), 0, sheet!);
  }

  /** Restores formula text directly (undo of a structural change); no reference adjustment. */
  restoreFormulas(entries: { sheetId: string; row: number; col: number; formula: string }[]): void {
    for (const e of entries) this.setContent(e.sheetId, e.row, e.col, { f: e.formula });
  }

  setNames(names: Workbook['names']): void {
    this.workbook.names = names.map((n) => ({ ...n }));
    this.rebuild();
    this.recalc();
  }
}

/** What a formula's functions say about when it must run again. */
interface FormulaTraits {
  volatile: boolean;
  /** Reads hidden and filtered rows (SUBTOTAL, AGGREGATE). */
  visibility: boolean;
  /** Its result is a position (ROW, COLUMN). */
  position: boolean;
}

function noteFunction(name: string, traits: FormulaTraits): void {
  const spec = getFunction(name);
  if (spec?.volatile) traits.volatile = true;
  if (spec?.readsRowVisibility) traits.visibility = true;
  if (spec?.readsPosition) traits.position = true;
}

/** A row/column change on one sheet, as `followDims` needs it. */
interface DimsChange {
  sheetId: string;
  axis: Axis;
  /** Where an index along `axis` went (-1: deleted). */
  map: (i: number) => number;
  /** Whether a span [lo, hi] along `axis` no longer covers the same cells in the same order. */
  cuts: (lo: number, hi: number) => boolean;
}

/** The defined names as text, to tell whether a change rewrote any. */
function namesKey(workbook: Workbook): string {
  return workbook.names.map((n) => `${n.sheetId ?? ''}\u0000${n.name}\u0000${n.formula}`).join('\u0001');
}

/** The non-blank values a spill shows inside `range`, its anchor (a stored cell) excluded. */
function forEachSpilled(rec: SpillRecord, range: Range, fn: (row: number, col: number, value: Scalar) => void): void {
  const a = rec.area;
  for (let r = Math.max(a.r1, range.r1); r <= Math.min(a.r2, range.r2); r++) {
    for (let c = Math.max(a.c1, range.c1); c <= Math.min(a.c2, range.c2); c++) {
      if (r === a.r1 && c === a.c1) continue;
      const v = rec.data[r - a.r1]?.[c - a.c1] ?? null;
      if (v !== null) fn(r, c, v);
    }
  }
}

function union(a: Range | null, b: Range): Range {
  if (!a) return { ...b };
  return {
    r1: Math.min(a.r1, b.r1),
    c1: Math.min(a.c1, b.c1),
    r2: Math.max(a.r2, b.r2),
    c2: Math.max(a.c2, b.c2),
  };
}

function sameArea(a: Range, b: Range): boolean {
  return a.r1 === b.r1 && a.c1 === b.c1 && a.r2 === b.r2 && a.c2 === b.c2;
}

function sameData(a: Scalar[][], b: Scalar[][]): boolean {
  if (a.length !== b.length) return false;
  for (let r = 0; r < a.length; r++) {
    const x = a[r]!;
    const y = b[r]!;
    if (x.length !== y.length) return false;
    for (let c = 0; c < x.length; c++) if (!sameScalar(x[c]!, y[c]!)) return false;
  }
  return true;
}

function shiftPos(row: number, col: number, axis: Axis, map: (i: number) => number): [number, number] {
  return axis === 'row' ? [map(row), col] : [row, map(col)];
}

/** The smallest and largest index [lo, hi] maps to. */
function mappedBounds(lo: number, hi: number, map: (i: number) => number): [number, number] {
  let min = Infinity;
  let max = -Infinity;
  for (let i = lo; i <= hi; i++) {
    const j = map(i);
    if (j < min) min = j;
    if (j > max) max = j;
  }
  return [min, max];
}

/** [lo, hi] mapped index by index; null when the result is not contiguous. */
export function mapRun(lo: number, hi: number, map: (i: number) => number): [number, number] | null {
  let min = Infinity;
  let max = -Infinity;
  for (let i = lo; i <= hi; i++) {
    const j = map(i);
    if (j < min) min = j;
    if (j > max) max = j;
  }
  return max - min === hi - lo ? [min, max] : null;
}

export function mapRangeInsert(r: Range, axis: Axis, at: number, count: number): Range {
  if (axis === 'row') {
    return {
      ...r,
      r1: r.r1 >= at ? r.r1 + count : r.r1,
      r2: r.r2 >= at ? r.r2 + count : r.r2,
    };
  }
  return {
    ...r,
    c1: r.c1 >= at ? r.c1 + count : r.c1,
    c2: r.c2 >= at ? r.c2 + count : r.c2,
  };
}

export function mapRangeDelete(r: Range, axis: Axis, at: number, count: number): Range | null {
  const [lo, hi] = axis === 'row' ? [r.r1, r.r2] : [r.c1, r.c2];
  const nlo = indexAfterDelete(lo, at, count, at);
  const nhi = indexAfterDelete(hi, at, count, at - 1);
  if (nlo > nhi) return null;
  return axis === 'row' ? { ...r, r1: nlo, r2: nhi } : { ...r, c1: nlo, c2: nhi };
}
