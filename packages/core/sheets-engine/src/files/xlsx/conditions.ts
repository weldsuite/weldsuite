/**
 * WeldSheets conditions (`Condition`) in Excel's terms: the `cellIs`
 * comparisons of conditional formats and data validation, and formulas for
 * the tests Excel has no named form for. Formulas are written for the rule's
 * anchor cell (`anchor`, A1 text) and move with each cell, as in both apps.
 */

import type { Condition } from '../../model/rules';
import { fromExcelFormula } from './formulas';

/** A plain decimal number literal ("12", "-0.5", "1E+3"; not hex or empty). */
function isNumberLiteral(text: string | undefined): text is string {
  return !!text && /^[\d.eE+-]+$/.test(text) && Number.isFinite(Number(text));
}

const SYMBOL: Record<string, string> = {
  lessThan: '<',
  lessThanOrEqual: '<=',
  equal: '=',
  notEqual: '<>',
  greaterThanOrEqual: '>=',
  greaterThan: '>',
};
const NUMBER_TEST: Record<string, Condition['type']> = {
  lessThan: 'less',
  lessThanOrEqual: 'lessOrEqual',
  equal: 'equal',
  notEqual: 'notEqual',
  greaterThanOrEqual: 'greaterOrEqual',
  greaterThan: 'greater',
};

/** A quoted formula string literal's text, or null. */
function stringLiteral(f: string): string | null {
  const m = /^"((?:[^"]|"")*)"$/.exec(f.trim());
  return m ? m[1]!.replaceAll('""', '"') : null;
}

/**
 * A comparison of `subject` (the anchor cell, or a formula of it) with one or
 * two operands. Number operands give a number test on the cell itself; any
 * other operand gives a formula. Null when an operand cannot be read.
 */
export function comparisonCondition(operator: string, operands: string[], anchor: string, subject = anchor): Condition | null {
  const [a, b] = operands.map((f) => f.trim());
  if (a === undefined) return null;
  const range = operator === 'between' || operator === 'notBetween';
  if (range && b === undefined) return null;
  if (subject === anchor) {
    const plain = plainCondition(operator, a, b, range);
    if (plain) return plain;
  }
  return formulaCondition(operator, a, b, subject);
}

/** The cell compared with numbers, or equal to a text: WeldSheets' own tests. */
function plainCondition(operator: string, a: string, b: string | undefined, range: boolean): Condition | null {
  if (range) {
    if (!isNumberLiteral(a) || !isNumberLiteral(b)) return null;
    const [x, y] = [Number(a), Number(b)];
    return { type: operator === 'between' ? 'between' : 'notBetween', min: Math.min(x, y), max: Math.max(x, y) };
  }
  const type = NUMBER_TEST[operator];
  if (type && isNumberLiteral(a)) return { type, value: Number(a) } as Condition;
  const text = operator === 'equal' ? stringLiteral(a) : null;
  return text === null ? null : { type: 'textIs', value: text };
}

function formulaCondition(operator: string, a: string, b: string | undefined, subject: string): Condition | null {
  const x = fromExcelFormula(a);
  const y = b === undefined ? null : fromExcelFormula(b);
  if (x === null) return null;
  if (operator === 'between' || operator === 'notBetween') {
    if (y === null) return null;
    const formula = operator === 'between' ? `AND(${subject}>=(${x}),${subject}<=(${y}))` : `OR(${subject}<(${x}),${subject}>(${y}))`;
    return { type: 'formula', formula };
  }
  const symbol = SYMBOL[operator];
  return symbol ? { type: 'formula', formula: `${subject}${symbol}(${x})` } : null;
}

/** Excel's `cellIs` form of a condition, for the conditions that have one. */
export function cellIsForm(c: Condition): { operator: string; operands: string[] } | null {
  switch (c.type) {
    case 'between':
    case 'notBetween':
      return { operator: c.type, operands: [String(c.min), String(c.max)] };
    case 'textIs':
      return { operator: 'equal', operands: [quote(c.value)] };
    case 'formula':
    case 'empty':
    case 'notEmpty':
    case 'textContains':
    case 'textNotContains':
    case 'textStartsWith':
    case 'textEndsWith':
      return null;
    default: {
      const operator = Object.entries(NUMBER_TEST).find(([, t]) => t === c.type)?.[0];
      return operator ? { operator, operands: [String(c.value)] } : null;
    }
  }
}

/** A formula, written for `anchor`, that is TRUE where the condition holds. */
export function conditionFormula(c: Condition, anchor: string): string {
  const a = anchor;
  switch (c.type) {
    case 'empty':
      return `LEN(TRIM(${a}))=0`;
    case 'notEmpty':
      return `LEN(TRIM(${a}))>0`;
    case 'textContains':
      return `NOT(ISERROR(SEARCH(${quote(c.value)},${a})))`;
    case 'textNotContains':
      return `ISERROR(SEARCH(${quote(c.value)},${a}))`;
    case 'textStartsWith':
      return `LEFT(${a},LEN(${quote(c.value)}))=${quote(c.value)}`;
    case 'textEndsWith':
      return `RIGHT(${a},LEN(${quote(c.value)}))=${quote(c.value)}`;
    case 'textIs':
      return `${a}=${quote(c.value)}`;
    case 'between':
      return `AND(ISNUMBER(${a}),${a}>=${c.min},${a}<=${c.max})`;
    case 'notBetween':
      return `AND(ISNUMBER(${a}),OR(${a}<${c.min},${a}>${c.max}))`;
    case 'formula':
      return c.formula;
    default: {
      const operator = Object.entries(NUMBER_TEST).find(([, t]) => t === c.type)?.[0];
      return `AND(ISNUMBER(${a}),${a}${SYMBOL[operator ?? 'equal']}${c.value})`;
    }
  }
}

export function quote(text: string): string {
  return `"${text.replaceAll('"', '""')}"`;
}

// ---------------------------------------------------------------------------
// Units
// ---------------------------------------------------------------------------

/** Width of a digit in Excel's default font, in pixels; column widths count in it. */
const DIGIT = 7;

/** A stored column width (characters, padding included) in pixels. */
export function widthToPx(width: number): number {
  return Math.max(0, Math.trunc(((256 * width + Math.trunc(128 / DIGIT)) / 256) * DIGIT));
}

/** Pixels as a stored column width, so that `widthToPx` gives the same pixels back. */
export function pxToWidth(px: number): number {
  return Math.trunc((px / DIGIT) * 256) / 256;
}

export function pointsToPx(points: number): number {
  return Math.round((points * 4) / 3);
}

export function pxToPoints(px: number): number {
  return Math.round(px * 0.75 * 100) / 100;
}
