/**
 * Conditions and calculations over the answers on the path, the hidden
 * values and the variables.
 *
 * Operand values:
 *   - numeric fields (number, rating, opinion scale, NPS): a number;
 *   - yes/no and legal: a boolean;
 *   - choice fields: the selected choice ids, plus `other` when "Other" has a text;
 *     a ranking: its choice ids;
 *   - a matrix with `rowId`: that row's column ids (without: answered or not, nothing else);
 *   - contact info and address with `part`: that part's text (without: answered or not);
 *   - text fields, dates, hidden values, text variables: a string;
 *   - number variables: a number; constants: themselves (an array is a set of ids).
 * A field's answer is empty until its block is on the path. Text compares
 * case-insensitively after trimming; dates compare as `YYYY-MM-DD` strings.
 */

import { displayAnswer, formatNumber } from './display';
import { choicesOf, fieldsOf, isBooleanField, isChoiceField, isNumericField } from './blocks';
import type {
  AnswerValue,
  Answers,
  ChoiceAnswer,
  Condition,
  ConditionGroup,
  FieldBlock,
  FormDefinition,
  Operand,
} from './definition';
import type { VariableValues } from './types';

/** The state conditions are evaluated against. */
export interface EvalContext {
  fields: Map<string, FieldBlock>;
  /** Valid, normalised answers by field id. */
  answers: Answers;
  /** Field ids whose block is on the path so far. */
  visible: Set<string>;
  /** Declared hidden values, trimmed. */
  hidden: Map<string, string>;
  variables: Map<string, number | string>;
}

export type OperandValue =
  | { t: 'empty' }
  | { t: 'num'; v: number }
  | { t: 'bool'; v: boolean }
  | { t: 'str'; v: string }
  | { t: 'set'; v: string[] }
  /** Answered, but with no value conditions can compare (a matrix without a row, files). */
  | { t: 'opaque' };

const EMPTY: OperandValue = { t: 'empty' };

/** Round to 10 decimals (half away from zero) to keep float noise out of variables; `-0` becomes `0`. */
export function roundNumber(x: number): number {
  if (!Number.isFinite(x) || Math.abs(x) >= 1e15) return x;
  const r = (Math.sign(x) * Math.round(Math.abs(x) * 1e10)) / 1e10;
  return r === 0 ? 0 : r;
}

const NUMERIC_TEXT_RE = /^-?\d+(\.\d+)?$/;

/** A string holding a plain decimal number (`-12.5`), as a number; null otherwise. */
export function parseNumericText(s: string): number | null {
  const t = s.trim();
  return NUMERIC_TEXT_RE.test(t) ? Number(t) : null;
}

export function createEvalContext(
  def: Pick<FormDefinition, 'blocks' | 'hidden' | 'variables'>,
  answers: Answers,
  hidden: Record<string, string> | undefined,
): EvalContext {
  const fields = new Map<string, FieldBlock>();
  for (const field of fieldsOf(def)) if (!fields.has(field.id)) fields.set(field.id, field);
  const hiddenValues = new Map<string, string>();
  for (const { name } of def.hidden) {
    if (hidden && Object.prototype.hasOwnProperty.call(hidden, name)) {
      const v = hidden[name];
      if (typeof v === 'string') hiddenValues.set(name, v.trim());
    }
  }
  const variables = new Map<string, number | string>([['score', 0]]);
  for (const v of def.variables) {
    if (variables.has(v.name)) continue;
    variables.set(v.name, v.type === 'number' ? roundNumber(v.initial) : v.initial);
  }
  return { fields, answers, visible: new Set(), hidden: hiddenValues, variables };
}

export function variablesOf(ctx: EvalContext): VariableValues {
  return Object.fromEntries(ctx.variables);
}

function visibleAnswer(ctx: EvalContext, id: string): { field: FieldBlock; answer: AnswerValue } | null {
  const field = ctx.fields.get(id);
  if (!field || !ctx.visible.has(id)) return null;
  const answer = ctx.answers[id];
  return answer === undefined ? null : { field, answer };
}

function choiceSet(answer: ChoiceAnswer): string[] {
  return answer.other !== undefined ? [...answer.choiceIds, 'other'] : [...answer.choiceIds];
}

/** The value of an operand. */
export function resolveOperand(operand: Operand, ctx: EvalContext): OperandValue {
  switch (operand.type) {
    case 'field': {
      const found = visibleAnswer(ctx, operand.id);
      if (!found) return EMPTY;
      const { field, answer } = found;
      if (isNumericField(field)) return { t: 'num', v: answer as number };
      if (isBooleanField(field)) return { t: 'bool', v: answer as boolean };
      if (isChoiceField(field)) return { t: 'set', v: choiceSet(answer as ChoiceAnswer) };
      switch (field.type) {
        case 'ranking':
          return { t: 'set', v: [...(answer as string[])] };
        case 'matrix': {
          if (operand.rowId === undefined) return { t: 'opaque' };
          const cols = (answer as Record<string, string[]>)[operand.rowId];
          return cols === undefined ? EMPTY : { t: 'set', v: [...cols] };
        }
        case 'contact_info':
        case 'address': {
          if (operand.part === undefined) return { t: 'opaque' };
          const v = (answer as Record<string, string>)[operand.part];
          return v === undefined ? EMPTY : { t: 'str', v };
        }
        case 'file_upload':
        case 'signature':
          return { t: 'opaque' };
        default:
          return { t: 'str', v: answer as string };
      }
    }
    case 'hidden': {
      const v = ctx.hidden.get(operand.name);
      return v === undefined || v === '' ? EMPTY : { t: 'str', v };
    }
    case 'variable': {
      const v = ctx.variables.get(operand.name);
      if (v === undefined) return EMPTY;
      if (typeof v === 'number') return { t: 'num', v };
      return v === '' ? EMPTY : { t: 'str', v };
    }
    case 'constant': {
      const v = operand.value;
      if (typeof v === 'number') return { t: 'num', v };
      if (typeof v === 'boolean') return { t: 'bool', v };
      if (typeof v === 'string') return { t: 'str', v };
      return { t: 'set', v: [...v] };
    }
  }
}

function norm(s: string): string {
  return s.trim().toLowerCase();
}

/** Ids on the right of a set comparison: one id or several. */
function idsOf(value: OperandValue): string[] | null {
  if (value.t === 'str') return [value.v.trim()];
  if (value.t === 'set') return value.v;
  return null;
}

/** `is`: null when the two values can't be compared. */
function equals(left: OperandValue, right: OperandValue): boolean | null {
  if (left.t === 'set') {
    const ids = idsOf(right);
    return ids === null ? null : ids.some((id) => left.v.includes(id));
  }
  if (left.t === 'num' && right.t === 'num') return left.v === right.v;
  if (left.t === 'bool' && right.t === 'bool') return left.v === right.v;
  if (left.t === 'str' && right.t === 'str') return norm(left.v) === norm(right.v);
  return null;
}

/** Evaluates one condition. A condition on an empty value is false except `is_empty`. */
export function evaluateCondition(condition: Condition, ctx: EvalContext): boolean {
  const left = resolveOperand(condition.left, ctx);
  if (condition.operator === 'is_empty') return left.t === 'empty';
  if (condition.operator === 'is_answered') return left.t !== 'empty';
  if (left.t === 'empty' || condition.right === undefined) return false;
  const right = resolveOperand(condition.right, ctx);
  if (right.t === 'empty') return false;

  switch (condition.operator) {
    case 'is':
      return equals(left, right) === true;
    case 'is_not':
      return equals(left, right) === false;
    case 'contains':
    case 'not_contains':
    case 'starts_with':
    case 'ends_with': {
      if (left.t !== 'str' || right.t !== 'str') return false;
      const l = norm(left.v);
      const r = norm(right.v);
      if (condition.operator === 'contains') return l.includes(r);
      if (condition.operator === 'not_contains') return !l.includes(r);
      if (condition.operator === 'starts_with') return l.startsWith(r);
      return l.endsWith(r);
    }
    case 'greater_than':
    case 'greater_or_equal':
    case 'less_than':
    case 'less_or_equal': {
      if (left.t !== 'num' || right.t !== 'num') return false;
      if (condition.operator === 'greater_than') return left.v > right.v;
      if (condition.operator === 'greater_or_equal') return left.v >= right.v;
      if (condition.operator === 'less_than') return left.v < right.v;
      return left.v <= right.v;
    }
    case 'before':
    case 'after': {
      if (left.t !== 'str' || right.t !== 'str') return false;
      const l = left.v.trim();
      const r = right.v.trim();
      return condition.operator === 'before' ? l < r : l > r;
    }
    case 'any_of':
    case 'all_of':
    case 'none_of': {
      if (left.t !== 'set') return false;
      const ids = idsOf(right);
      if (ids === null) return false;
      if (condition.operator === 'any_of') return ids.some((id) => left.v.includes(id));
      if (condition.operator === 'all_of') return ids.every((id) => left.v.includes(id));
      return !ids.some((id) => left.v.includes(id));
    }
  }
}

/** Evaluates an AND/OR group (one level of nesting). */
export function evaluateGroup(group: ConditionGroup, ctx: EvalContext): boolean {
  const results = (item: ConditionGroup['conditions'][number]): boolean =>
    'op' in item
      ? item.op === 'and'
        ? item.conditions.every((c) => evaluateCondition(c, ctx))
        : item.conditions.some((c) => evaluateCondition(c, ctx))
      : evaluateCondition(item, ctx);
  return group.op === 'and' ? group.conditions.every(results) : group.conditions.some(results);
}

// ---------------------------------------------------------------------------
// Calculations
// ---------------------------------------------------------------------------

/** Sum of the selected choices' scores (unscored choices and "Other" count 0). */
export function selectedScore(field: FieldBlock, answer: ChoiceAnswer): number {
  const selected = new Set(answer.choiceIds);
  let sum = 0;
  for (const choice of choicesOf(field)) if (selected.has(choice.id) && choice.score !== undefined) sum += choice.score;
  return roundNumber(sum);
}

/**
 * An operand as a number for a calculation; null skips the calculation.
 * Numeric fields give their number, yes/no and legal 1 or 0, choice fields
 * the sum of the selected choices' scores; hidden values and texts must hold
 * a plain decimal number.
 */
export function operandNumber(operand: Operand, ctx: EvalContext): number | null {
  switch (operand.type) {
    case 'field': {
      const found = visibleAnswer(ctx, operand.id);
      if (!found) return null;
      const { field, answer } = found;
      if (isNumericField(field)) return answer as number;
      if (isBooleanField(field)) return answer === true ? 1 : 0;
      if (isChoiceField(field)) return selectedScore(field, answer as ChoiceAnswer);
      return null;
    }
    case 'hidden': {
      const v = ctx.hidden.get(operand.name);
      return v === undefined ? null : parseNumericText(v);
    }
    case 'variable': {
      const v = ctx.variables.get(operand.name);
      if (v === undefined) return null;
      return typeof v === 'number' ? v : parseNumericText(v);
    }
    case 'constant': {
      const v = operand.value;
      if (typeof v === 'number') return v;
      if (typeof v === 'boolean') return v ? 1 : 0;
      if (typeof v === 'string') return parseNumericText(v);
      return null;
    }
  }
}

/** An operand as text for a text variable; null skips the calculation. */
export function operandText(operand: Operand, ctx: EvalContext): string | null {
  switch (operand.type) {
    case 'field': {
      const found = visibleAnswer(ctx, operand.id);
      if (!found) return null;
      const text = displayAnswer(found.field, found.answer);
      return text === '' ? null : text;
    }
    case 'hidden': {
      const v = ctx.hidden.get(operand.name);
      return v === undefined || v === '' ? null : v;
    }
    case 'variable': {
      const v = ctx.variables.get(operand.name);
      if (v === undefined) return null;
      if (typeof v === 'number') return formatNumber(v);
      return v === '' ? null : v;
    }
    case 'constant': {
      const v = operand.value;
      if (typeof v === 'string') return v;
      if (typeof v === 'number') return formatNumber(v);
      if (typeof v === 'boolean') return v ? 'true' : 'false';
      return null;
    }
  }
}
