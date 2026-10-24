/**
 * @weldsuite/sheets-engine: the WeldSheets spreadsheet engine.
 *
 * Pure TypeScript with no dependencies, so the same code runs in the browser,
 * in a Web Worker, in the SheetRoom Durable Object and in any worker that
 * reads or writes sheets. See docs/plans/weldsheets.md.
 */

import './formula/functions';

export * from './address';
export * from './values';

export { Workbook, Sheet, sheetFromJSON, sheetToJSON, DEFAULT_COL_WIDTH, DEFAULT_ROW_HEIGHT } from './model/workbook';
export type { DefinedName, SheetProps, SheetSnapshot, WorkbookSnapshot } from './model/workbook';
export type { Cell } from './model/cell-store';
export { StyleTable, applyStylePatch, styleKey } from './model/styles';
export type { BorderSide, CellStyle, StylePatch } from './model/styles';
export { AxisDims } from './model/axis';

export { Engine } from './calc/engine';
export type { CellContent, EngineOptions, RewrittenFormula } from './calc/engine';

export { parseFormula, FormulaSyntaxError } from './formula/parser';
export { CANONICAL_FORMULA_LOCALE, delocalizeFormula, localizeFormula } from './formula/locale';
export type { FormulaLocale } from './formula/locale';
export type { AstNode } from './formula/parser';
export { tokenize } from './formula/lexer';
export type { RefToken, Token } from './formula/lexer';
export { collectRefs, printRef, translateFormula } from './formula/references';
export type { Axis } from './formula/references';
export { functionNames, getFunction, registerFunctions } from './formula/functions';
export type { EvalContext, EvalHost, FunctionSpec } from './formula/types';

export * from './format/date';

export { applyOp } from './ops/apply';
export { transform, transformList } from './ops/transform';
export { NOOP, isNoop, nameKey, normalize } from './ops/types';
export type { AxisEntry, CellPatch, NameKey, Op, OpType } from './ops/types';
export { MAX_CELLS_PER_OP, validateOp } from './ops/validate';
export { compareForSort, sortRangeOp } from './ops/sort';
export type { SortKey, SortResult } from './ops/sort';

export { sortFormats, valueKey } from './model/rules';
export type {
  ColorPoint,
  Condition,
  ConditionType,
  ConditionalFormat,
  ConditionalRule,
  ConditionalStyle,
  DataValidation,
  FilterColumn,
  SheetFilter,
  ValidationCriteria,
} from './model/rules';
export {
  anchorOf,
  conditionalStyleAt,
  filteredRows,
  listOptions,
  matchesCondition,
  passesValidation,
  validationAt,
} from './rules/evaluate';
export type { FormatCache, RuleHost } from './rules/evaluate';

export { RoomCore } from './collab/room';
export type { Outgoing, RoomOptions } from './collab/room';
export { CollabClient } from './collab/client';
export type { CollabClientOptions } from './collab/client';
export { FrameAssembler, MAX_FRAME, decodeClient, decodeServer, encode, refusedBatchId, toFrames } from './collab/protocol';
export { isWellFormedOp } from './ops/shape';
export type { ClientMessage, CommittedOp, Peer, Presence, RejectReason, ServerMessage } from './collab/protocol';

export { EN_LOCALE, NL_LOCALE, formatCategory, formatValue, isDateFormat } from './format/number-format';
export type { FormatCategory, FormatLocale, FormattedValue } from './format/number-format';
export { parseInput } from './format/input';
export type { ParseInputOptions, ParsedInput } from './format/input';

export { readSpreadsheet, spreadsheetFormat } from './files';
export type { ReadSpreadsheetOptions, SpreadsheetFormat } from './files';
export { readXlsx } from './files/xlsx/read';
export { writeXlsx } from './files/xlsx/write';
export type { WriteXlsxOptions } from './files/xlsx/write';
export { detectDelimiter, parseCsv, readCsv, writeCsv } from './files/csv';
export type { ReadCsvOptions, WriteCsvOptions } from './files/csv';
export { ImportError } from './files/types';
export type { ImportErrorCode, ImportResult, ImportWarning, ReadOptions, ReadXlsxOptions } from './files/types';
export { ZipError, openZip, writeZip } from './files/zip';
export type { ZipErrorCode, ZipFile, ZipLimits, ZipReader } from './files/zip';
