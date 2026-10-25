import type { Range } from '../address';
import type { EvalValue, Scalar } from '../values';

/** What the evaluator needs from the workbook it runs in. Implemented by the Engine. */
export interface EvalHost {
  /** The value shown in a cell (spill results included). Blank is null. */
  cellValue(sheetId: string, row: number, col: number): Scalar;
  /**
   * Visits the non-blank values in a range, row-major is not guaranteed.
   * Lets SUM(A:A) touch the used cells instead of a million blanks.
   */
  forEachValue(sheetId: string, range: Range, fn: (row: number, col: number, value: Scalar) => void): void;
  /** Bounding box of the non-blank cells of a sheet, spills included. */
  usedRange(sheetId: string): Range | null;
  sheetIdByName(name: string): string | undefined;
  sheetName(sheetId: string): string | undefined;
  /** Sheet ids in tab order (3D references, SHEET/SHEETS). */
  sheetIds(): string[];
  /** Formula text of a defined name visible from `sheetId`. */
  definedName(name: string, sheetId: string): string | undefined;
  /** Milliseconds since the epoch, fixed for one recalculation pass. */
  now(): number;
  random(): number;
  /** Local timezone offset in minutes (Date#getTimezoneOffset semantics) used by NOW/TODAY. */
  timezoneOffset(): number;
  /**
   * Whether a row is hidden by the sheet's filter, or (with `manual`) by hand
   * too: SUBTOTAL and AGGREGATE skip such rows. Calling it marks the formula
   * being evaluated as depending on row visibility.
   */
  isRowHidden(sheetId: string, row: number, manual: boolean): boolean;
  /** Formula text of a cell, if it holds one (SUBTOTAL skips nested SUBTOTALs). */
  cellFormula(sheetId: string, row: number, col: number): string | undefined;
}

export interface EvalContext {
  host: EvalHost;
  /** The cell being evaluated. */
  sheetId: string;
  row: number;
  col: number;
}

export type Thunk = () => EvalValue;

interface FunctionSpecBase {
  name: string;
  minArgs: number;
  maxArgs: number;
  /** Recalculated on every pass (NOW, RAND, INDIRECT, OFFSET, …). */
  volatile?: boolean;
  /** Reads whether rows are hidden or filtered (SUBTOTAL, AGGREGATE): recalculated when that changes. */
  readsRowVisibility?: boolean;
  /** Its result is a position (ROW, COLUMN): recalculated when rows or columns are inserted, deleted or moved. */
  readsPosition?: boolean;
  /**
   * Argument positions that take a single value. When such an argument is a
   * multi-cell range or an array the function is applied element-wise and
   * returns an array (Excel's dynamic-array lifting). 'all' marks every
   * argument; positions beyond the list are passed through untouched.
   */
  scalarArgs?: 'all' | readonly number[];
}

export interface EagerFunctionSpec extends FunctionSpecBase {
  lazy?: false;
  impl(args: EvalValue[], ctx: EvalContext): EvalValue;
}

/** Arguments arrive unevaluated, for short-circuiting (IF, IFERROR, CHOOSE, …). */
export interface LazyFunctionSpec extends FunctionSpecBase {
  lazy: true;
  impl(args: Thunk[], ctx: EvalContext): EvalValue;
}

export type FunctionSpec = EagerFunctionSpec | LazyFunctionSpec;
