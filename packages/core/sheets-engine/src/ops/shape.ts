/**
 * Shape checks for ops that come from outside (a room's sockets): every field
 * `normalize`, `transform` and `applyOp` read has the type they expect. A
 * garbled op that got past this could throw halfway through being applied and
 * leave the workbook half-changed. `validateOp` then checks a well-formed op
 * against the workbook (sheets exist, indices in range).
 */

import { styleKey, type StylePatch } from '../model/styles';
import { ERROR_CODES } from '../values';
import type { Op, OpType } from './types';

type Check = (v: unknown) => boolean;
type Fields = Record<string, unknown>;

/** Batches inside batches; `normalize` flattens them, clients never nest deeply. */
const MAX_DEPTH = 4;
const MAX_KNOWN_KEYS = 10_000;

const isObj = (v: unknown): v is Fields => typeof v === 'object' && v !== null && !Array.isArray(v);
const isInt = (v: unknown): v is number => Number.isInteger(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isStr = (v: unknown): v is string => typeof v === 'string';
const isBool = (v: unknown): v is boolean => typeof v === 'boolean';
const optional = (check: Check): Check => (v) => v === undefined || check(v);
const nullable = (check: Check): Check => (v) => v === null || check(v);
const arrayOf = (check: Check): Check => (v) => Array.isArray(v) && v.every(check);
const oneOf = (...values: unknown[]): Check => (v) => values.includes(v);
const tuple = (...checks: Check[]): Check => (v) => Array.isArray(v) && v.length === checks.length && checks.every((c, i) => c(v[i]));
/** An object with these fields (and no others the checks would miss). */
const shape = (fields: Record<string, Check>): Check => (v) =>
  isObj(v) && Object.keys(v).every((k) => k in fields) && Object.entries(fields).every(([k, check]) => check(v[k]));

const isAxis = oneOf('row', 'col');
const isRange = shape({ r1: isInt, c1: isInt, r2: isInt, c2: isInt });
const isError = shape({ kind: oneOf('error'), code: oneOf(...ERROR_CODES), message: optional(isStr) });
const isScalar: Check = (v) => v === null || isBool(v) || isStr(v) || isNum(v) || isError(v);
const isBorder = shape({ style: oneOf('thin', 'medium', 'thick', 'dashed', 'dotted', 'double'), color: optional(isStr) });

const STYLE_FIELDS: Record<keyof StylePatch, Check> = {
  fontFamily: isStr,
  fontSize: isNum,
  bold: isBool,
  italic: isBool,
  underline: isBool,
  strike: isBool,
  color: isStr,
  fill: isStr,
  hAlign: oneOf('left', 'center', 'right', 'justify'),
  vAlign: oneOf('top', 'middle', 'bottom'),
  wrap: oneOf('overflow', 'wrap', 'clip'),
  indent: isNum,
  rotation: isNum,
  borderTop: isBorder,
  borderRight: isBorder,
  borderBottom: isBorder,
  borderLeft: isBorder,
  numFmt: isStr,
};

const isStylePatch = shape(Object.fromEntries(Object.entries(STYLE_FIELDS).map(([k, check]) => [k, optional(nullable(check))])));
const isStyle = shape(Object.fromEntries(Object.entries(STYLE_FIELDS).map(([k, check]) => [k, optional(check)])));

/** Style keys already checked (keys repeat across a paste and across ops). */
const knownKeys = new Set<string>();

/** A style key is the canonical JSON of a style (`styleKey`); anything else would break `StyleTable.get`. */
const isStyleKey: Check = (v) => {
  if (!isStr(v)) return false;
  if (knownKeys.has(v)) return true;
  let style: unknown;
  try {
    style = JSON.parse(v);
  } catch {
    return false;
  }
  if (!isStyle(style) || styleKey(style as Parameters<typeof styleKey>[0]) !== v) return false;
  if (knownKeys.size >= MAX_KNOWN_KEYS) knownKeys.clear();
  knownKeys.add(v);
  return true;
};

const isContent = nullable(shape({ v: optional(isScalar), f: optional(isStr) }));
const isDefinedName = shape({ name: isStr, formula: isStr, sheetId: optional(isStr) });
const isNameKey = shape({ name: isStr, sheetId: optional(isStr) });
const isAxisSnapshot = shape({
  defaultSize: isNum,
  sizes: optional(arrayOf(tuple(isInt, isNum))),
  hidden: optional(arrayOf(isInt)),
  styles: optional(arrayOf(tuple(isInt, isStyleKey))),
});
const sheetProps = (check: (c: Check) => Check) =>
  shape({ tabColor: check(isStr), hidden: check(isBool), gridlines: check(isBool), rtl: check(isBool) });
const anyOf = (...checks: Check[]): Check => (v) => checks.some((c) => c(v));

const isCondition = anyOf(
  shape({ type: oneOf('empty', 'notEmpty') }),
  shape({ type: oneOf('textContains', 'textNotContains', 'textStartsWith', 'textEndsWith', 'textIs'), value: isStr }),
  shape({ type: oneOf('greater', 'greaterOrEqual', 'less', 'lessOrEqual', 'equal', 'notEqual'), value: isNum }),
  shape({ type: oneOf('between', 'notBetween'), min: isNum, max: isNum }),
  shape({ type: oneOf('formula'), formula: isStr }),
);
const isFilter = shape({
  range: isRange,
  columns: arrayOf(shape({ col: isInt, hiddenValues: optional(arrayOf(isStr)), condition: optional(isCondition) })),
});
const isConditionalStyle = shape({
  bold: optional(isBool),
  italic: optional(isBool),
  underline: optional(isBool),
  strike: optional(isBool),
  color: optional(isStr),
  fill: optional(isStr),
});
const isColorPoint = shape({ kind: oneOf('min', 'max', 'number', 'percent', 'percentile'), value: optional(isNum), color: isStr });
const isFormat = shape({
  id: isStr,
  order: isNum,
  ranges: arrayOf(isRange),
  rule: anyOf(
    shape({ type: oneOf('condition'), condition: isCondition, style: isConditionalStyle }),
    shape({ type: oneOf('colorScale'), points: arrayOf(isColorPoint) }),
  ),
});
const isValidation = shape({
  id: isStr,
  ranges: arrayOf(isRange),
  criteria: anyOf(
    shape({ type: oneOf('list'), values: arrayOf(isStr) }),
    shape({ type: oneOf('listRange'), source: isStr }),
    shape({ type: oneOf('condition'), condition: isCondition }),
    shape({ type: oneOf('checkbox') }),
  ),
  strict: isBool,
  dropdown: optional(isBool),
  help: optional(isStr),
});

const isSheetSnapshot = shape({
  id: isStr,
  name: isStr,
  rowCount: isInt,
  colCount: isInt,
  rows: isAxisSnapshot,
  cols: isAxisSnapshot,
  cells: arrayOf(tuple(isInt, isInt, shape({ v: isScalar, f: optional(isStr), s: optional(isStyleKey) }))),
  merges: optional(arrayOf(isRange)),
  freeze: optional(shape({ rows: isInt, cols: isInt })),
  props: optional(sheetProps(optional)),
  filter: optional(isFilter),
  conditionalFormats: optional(arrayOf(isFormat)),
  validations: optional(arrayOf(isValidation)),
});

const sheetOp = (fields: Record<string, Check>): Check => shape({ type: isStr, sheetId: isStr, ...fields });
const dims = { sheetName: isStr, axis: isAxis, count: isInt };

const CHECKS = new Map<Exclude<OpType, 'batch'>, Check>([
  ['setCells', sheetOp({ cells: arrayOf(tuple(isInt, isInt, isContent)) })],
  ['formatRanges', sheetOp({ ranges: arrayOf(isRange), patch: isStylePatch })],
  [
    'setStyles',
    sheetOp({
      cells: arrayOf(tuple(isInt, isInt, nullable(isStyleKey))),
      rows: optional(arrayOf(tuple(isInt, nullable(isStyleKey)))),
      cols: optional(arrayOf(tuple(isInt, nullable(isStyleKey)))),
    }),
  ],
  ['insertDims', sheetOp({ ...dims, at: isInt })],
  ['deleteDims', sheetOp({ ...dims, at: isInt })],
  ['moveDims', sheetOp({ ...dims, from: isInt, to: isInt })],
  ['resizeDims', sheetOp({ axis: isAxis, entries: arrayOf(tuple(isInt, nullable(isNum))) })],
  ['hideDims', sheetOp({ axis: isAxis, indices: arrayOf(isInt), hidden: isBool })],
  ['addSheet', sheetOp({ name: isStr, index: isInt, snapshot: optional(isSheetSnapshot) })],
  ['deleteSheet', sheetOp({ sheetName: isStr })],
  ['renameSheet', sheetOp({ oldName: isStr, name: isStr })],
  ['moveSheet', sheetOp({ index: isInt })],
  ['setSheetProps', sheetOp({ props: sheetProps((c) => optional(nullable(c))) })],
  ['setGridSize', sheetOp({ rowCount: optional(isInt), colCount: optional(isInt) })],
  ['merge', sheetOp({ ranges: arrayOf(isRange) })],
  ['unmerge', sheetOp({ ranges: arrayOf(isRange) })],
  ['setFreeze', sheetOp({ rows: isInt, cols: isInt })],
  ['setNames', shape({ type: isStr, names: arrayOf(isDefinedName) })],
  ['patchNames', shape({ type: isStr, set: optional(arrayOf(isDefinedName)), remove: optional(arrayOf(isNameKey)) })],
  ['setFilter', sheetOp({ filter: nullable(isFilter) })],
  ['patchConditionalFormats', sheetOp({ set: optional(arrayOf(isFormat)), remove: optional(arrayOf(isStr)) })],
  ['patchValidations', sheetOp({ set: optional(arrayOf(isValidation)), remove: optional(arrayOf(isStr)) })],
]);

/** True when `op` has the structure of an `Op` all the way down. */
export function isWellFormedOp(op: unknown, depth = 0): op is Op {
  if (!isObj(op)) return false;
  if (op.type === 'batch') {
    return depth < MAX_DEPTH && Object.keys(op).length === 2 && Array.isArray(op.ops) && op.ops.every((o) => isWellFormedOp(o, depth + 1));
  }
  const check = CHECKS.get(op.type as Exclude<OpType, 'batch'>);
  return check !== undefined && check(op);
}
