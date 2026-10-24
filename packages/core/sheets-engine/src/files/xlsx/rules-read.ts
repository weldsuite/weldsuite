/**
 * A worksheet's rules from SpreadsheetML: `autoFilter` (the basic filter),
 * `conditionalFormatting` and `dataValidations`, including the Excel 2010
 * extension list that holds validation lists drawn from another sheet.
 * What WeldSheets has no counterpart for is left out with a warning.
 */

import { child, childrenOf, type XmlElement } from '@weldsuite/zip-xml';
import { formatA1, parseRange, type Range } from '../../address';
import { formatValue, type FormatLocale } from '../../format/number-format';
import type { Cell } from '../../model/cell-store';
import {
  valueKey,
  type ColorPoint,
  type Condition,
  type ConditionalFormat,
  type ConditionalRule,
  type DataValidation,
  type FilterColumn,
  type SheetFilter,
  type ValidationCriteria,
} from '../../model/rules';
import type { CellStyle } from '../../model/styles';
import type { ImportWarning } from '../types';
import { resolveColor } from './colors';
import { comparisonCondition } from './conditions';
import { fromExcelFormula } from './formulas';
import type { StyleSheet } from './styles';

/** Most ranges a rule keeps (as many as an op may carry). */
const MAX_RULE_RANGES = 100;

export interface RulesContext {
  styles: StyleSheet;
  theme: string[];
  locale: FormatLocale;
  warnings: Set<ImportWarning>;
  /** The last row with a cell. */
  lastRow: number;
  /** The stored cell at (row, col), with its style. */
  cellAt(row: number, col: number): { cell: Cell; style: CellStyle | undefined } | undefined;
}

/** "A1:B2 D4" as ranges (at most MAX_RULE_RANGES); null when none is readable. */
export function parseSqref(text: string | undefined): Range[] | null {
  if (!text) return null;
  const ranges = text
    .split(/\s+/)
    .map((part) => parseRange(part))
    .filter((r): r is Range => r !== null)
    .slice(0, MAX_RULE_RANGES);
  return ranges.length ? ranges : null;
}

const anchorOf = (ranges: Range[]) => formatA1(ranges[0]!.r1, ranges[0]!.c1);

// ---------------------------------------------------------------------------
// Filter
// ---------------------------------------------------------------------------

export function readFilter(root: XmlElement, ctx: RulesContext): SheetFilter | null {
  const el = child(root, 'autoFilter');
  const range = parseRange(el?.attrs.ref ?? '');
  if (!el || !range) return null;
  const columns: FilterColumn[] = [];
  for (const fc of childrenOf(el, 'filterColumn')) {
    const col = range.c1 + Number(fc.attrs.colId ?? -1);
    if (!(col >= range.c1 && col <= range.c2)) continue;
    const column = filterColumn(fc, col, range, ctx);
    if (column) columns.push(column);
    else ctx.warnings.add('filters');
  }
  return { range, columns };
}

function filterColumn(fc: XmlElement, col: number, range: Range, ctx: RulesContext): FilterColumn | null {
  const values = child(fc, 'filters');
  if (values) return valuesColumn(values, col, range, ctx);
  const custom = child(fc, 'customFilters');
  if (!custom) return null;
  const condition = customCondition(custom, formatA1(range.r1 + 1, col));
  return condition ? { col, condition } : null;
}

/**
 * Excel lists the values a column shows, as they are displayed; WeldSheets
 * keeps the ones it hides. Every value in the column not shown is hidden.
 */
function valuesColumn(el: XmlElement, col: number, range: Range, ctx: RulesContext): FilterColumn | null {
  if (child(el, 'dateGroupItem')) return null;
  const shown = new Set(childrenOf(el, 'filter').map((f) => (f.attrs.val ?? '').toLowerCase()));
  const blanksShown = el.attrs.blank === '1' || el.attrs.blank === 'true';
  const hidden = new Set<string>();
  for (let row = range.r1 + 1; row <= Math.min(range.r2, ctx.lastRow); row++) {
    const found = ctx.cellAt(row, col);
    const value = found?.cell.v ?? null;
    if (value === null || value === '') {
      if (!blanksShown) hidden.add('');
      continue;
    }
    const text = formatValue(value, found?.style?.numFmt, ctx.locale).text.toLowerCase();
    if (!shown.has(text) && !shown.has(String(value).toLowerCase())) hidden.add(valueKey(value));
  }
  return hidden.size ? { col, hiddenValues: [...hidden].sort((a, b) => (a < b ? -1 : 1)) } : { col };
}

function customCondition(el: XmlElement, anchor: string): Condition | null {
  const filters = childrenOf(el, 'customFilter').map((f) => ({ op: f.attrs.operator ?? 'equal', val: f.attrs.val ?? '' }));
  const and = el.attrs.and === '1' || el.attrs.and === 'true';
  if (filters.length === 1) return wildcardCondition(filters[0]!.op, filters[0]!.val, anchor);
  if (filters.length !== 2) return null;
  const [a, b] = filters as [{ op: string; val: string }, { op: string; val: string }];
  const lo = Number(a.val);
  const hi = Number(b.val);
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || a.val === '' || b.val === '') return null;
  if (and && a.op === 'greaterThanOrEqual' && b.op === 'lessThanOrEqual') return { type: 'between', min: lo, max: hi };
  if (!and && a.op === 'lessThan' && b.op === 'greaterThan') return { type: 'notBetween', min: lo, max: hi };
  return null;
}

/** One custom filter: `*text*` contains, `text*` starts with, `*text` ends with, else a comparison. */
function wildcardCondition(op: string, val: string, anchor: string): Condition | null {
  if ((op === 'equal' || op === 'notEqual') && val.includes('*')) return wildcardText(op === 'notEqual', val);
  const operand = val !== '' && Number.isFinite(Number(val)) ? val : `"${val.replaceAll('"', '""')}"`;
  return comparisonCondition(op, [operand], anchor);
}

function wildcardText(negated: boolean, val: string): Condition | null {
  const inner = val.replace(/^\*|\*$/g, '');
  if (inner.includes('*')) return null;
  const anchoredStart = !val.startsWith('*');
  const anchoredEnd = !val.endsWith('*');
  if (negated) return anchoredStart || anchoredEnd ? null : { type: 'textNotContains', value: inner };
  if (anchoredStart) return anchoredEnd ? null : { type: 'textStartsWith', value: inner };
  return anchoredEnd ? { type: 'textEndsWith', value: inner } : { type: 'textContains', value: inner };
}

// ---------------------------------------------------------------------------
// Conditional formatting
// ---------------------------------------------------------------------------

export function readConditionalFormats(root: XmlElement, ctx: RulesContext): ConditionalFormat[] {
  const formats: ConditionalFormat[] = [];
  for (const cf of childrenOf(root, 'conditionalFormatting')) {
    const ranges = parseSqref(cf.attrs.sqref);
    if (!ranges) continue;
    for (const rule of childrenOf(cf, 'cfRule')) {
      const read = conditionalRule(rule, anchorOf(ranges), ctx);
      if (!read) {
        ctx.warnings.add('conditionalFormats');
        continue;
      }
      formats.push({ id: `cf${formats.length + 1}`, order: Number(rule.attrs.priority) || formats.length + 1, ranges, rule: read });
    }
  }
  if (child(root, 'extLst')?.children.some((ext) => child(ext, 'conditionalFormattings'))) ctx.warnings.add('conditionalFormats');
  return formats;
}

const TEXT_RULES: Record<string, Condition['type']> = {
  containsText: 'textContains',
  notContainsText: 'textNotContains',
  beginsWith: 'textStartsWith',
  endsWith: 'textEndsWith',
};

function conditionalRule(el: XmlElement, anchor: string, ctx: RulesContext): ConditionalRule | null {
  const type = el.attrs.type ?? '';
  if (type === 'colorScale') return colorScale(child(el, 'colorScale'), ctx.theme);
  const condition = ruleCondition(el, type, anchor);
  if (!condition) return null;
  const dxfId = el.attrs.dxfId;
  return { type: 'condition', condition, style: dxfId === undefined ? {} : { ...ctx.styles.dxfs[Number(dxfId)] } };
}

function ruleCondition(el: XmlElement, type: string, anchor: string): Condition | null {
  const formulas = childrenOf(el, 'formula').map((f) => f.text);
  const textType = TEXT_RULES[type];
  if (textType) return el.attrs.text === undefined ? null : ({ type: textType, value: el.attrs.text } as Condition);
  switch (type) {
    case 'cellIs':
      return comparisonCondition(el.attrs.operator ?? 'equal', formulas, anchor);
    case 'containsBlanks':
      return { type: 'empty' };
    case 'notContainsBlanks':
      return { type: 'notEmpty' };
    case 'containsErrors':
      return { type: 'formula', formula: `ISERROR(${anchor})` };
    case 'notContainsErrors':
      return { type: 'formula', formula: `NOT(ISERROR(${anchor}))` };
    case 'expression': {
      const formula = formulas[0] === undefined ? null : fromExcelFormula(formulas[0]);
      return formula === null ? null : { type: 'formula', formula };
    }
    default:
      return null;
  }
}

const CFVO_KINDS: Record<string, ColorPoint['kind']> = { min: 'min', max: 'max', num: 'number', percent: 'percent', percentile: 'percentile' };

function colorScale(el: XmlElement | undefined, theme: string[]): ConditionalRule | null {
  const cfvos = childrenOf(el, 'cfvo');
  const colors = childrenOf(el, 'color');
  if (cfvos.length < 2 || cfvos.length > 3 || colors.length !== cfvos.length) return null;
  const points: ColorPoint[] = [];
  for (const [i, v] of cfvos.entries()) {
    const kind = CFVO_KINDS[v.attrs.type ?? ''];
    const color = resolveColor(colors[i], theme);
    if (!kind || !color) return null;
    const value = Number(v.attrs.val);
    if (kind !== 'min' && kind !== 'max' && !Number.isFinite(value)) return null;
    points.push(kind === 'min' || kind === 'max' ? { kind, color } : { kind, value, color });
  }
  return { type: 'colorScale', points };
}

// ---------------------------------------------------------------------------
// Data validation
// ---------------------------------------------------------------------------

export function readValidations(root: XmlElement, ctx: RulesContext): DataValidation[] {
  const rules: DataValidation[] = [];
  const add = (el: XmlElement, sqref: string | undefined, f1: string | undefined, f2: string | undefined) => {
    const ranges = parseSqref(sqref);
    if (!ranges) return;
    const rule = validation(el, ranges, f1, f2);
    if (rule === 'skip') return;
    if (rule) rules.push({ ...rule, id: `dv${rules.length + 1}` });
    else ctx.warnings.add('validations');
  };
  for (const dv of childrenOf(child(root, 'dataValidations'), 'dataValidation')) {
    add(dv, dv.attrs.sqref, child(dv, 'formula1')?.text, child(dv, 'formula2')?.text);
  }
  // Excel 2010+ keeps lists that refer to another sheet in its extension list.
  for (const ext of childrenOf(child(root, 'extLst'), 'ext')) {
    for (const dv of childrenOf(child(ext, 'dataValidations'), 'dataValidation')) {
      const f = (name: string) => child(child(dv, name), 'f')?.text;
      add(dv, child(dv, 'sqref')?.text, f('formula1'), f('formula2'));
    }
  }
  return rules;
}

/** A rule (without its id); 'skip' for rules that only show a message; null when unreadable. */
function validation(el: XmlElement, ranges: Range[], f1: string | undefined, f2: string | undefined): Omit<DataValidation, 'id'> | 'skip' | null {
  const a = el.attrs;
  const type = a.type ?? 'none';
  if (type === 'none') return 'skip';
  const criteria = validationCriteria(type, a.operator ?? 'between', f1, f2, anchorOf(ranges));
  if (!criteria) return null;
  const rule: Omit<DataValidation, 'id'> = {
    ranges,
    criteria,
    strict: (a.showErrorMessage === '1' || a.showErrorMessage === 'true') && (a.errorStyle ?? 'stop') === 'stop',
  };
  // `showDropDown` is inverted in the file format: set means the arrow is hidden.
  if (criteria.type === 'list' || criteria.type === 'listRange') rule.dropdown = !(a.showDropDown === '1' || a.showDropDown === 'true');
  if (a.prompt && (a.showInputMessage === '1' || a.showInputMessage === 'true')) rule.help = a.prompt;
  return rule;
}

function validationCriteria(type: string, operator: string, f1: string | undefined, f2: string | undefined, anchor: string): ValidationCriteria | null {
  if (f1 === undefined) return null;
  const operands = f2 === undefined ? [f1] : [f1, f2];
  switch (type) {
    case 'list':
      return listCriteria(f1);
    case 'whole':
    case 'decimal':
    case 'date':
    case 'time': {
      const condition = comparisonCondition(operator, operands, anchor);
      return condition ? { type: 'condition', condition } : null;
    }
    case 'textLength': {
      const condition = comparisonCondition(operator, operands, anchor, `LEN(${anchor})`);
      return condition ? { type: 'condition', condition } : null;
    }
    case 'custom': {
      const formula = fromExcelFormula(f1);
      return formula === null ? null : { type: 'condition', condition: { type: 'formula', formula } };
    }
    default:
      return null;
  }
}

/** `"a,b,c"` is a list of items (TRUE,FALSE a checkbox); anything else is a range or formula to take items from. */
function listCriteria(f1: string): ValidationCriteria | null {
  const literal = /^"((?:[^"]|"")*)"$/.exec(f1.trim());
  if (literal) {
    const values = literal[1]!
      .replaceAll('""', '"')
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean);
    if (values.length === 2 && values.every((v) => /^(TRUE|FALSE)$/i.test(v)) && values[0]!.toUpperCase() !== values[1]!.toUpperCase()) {
      return { type: 'checkbox' };
    }
    return values.length ? { type: 'list', values } : null;
  }
  const source = fromExcelFormula(f1);
  return source === null ? null : { type: 'listRange', source };
}
