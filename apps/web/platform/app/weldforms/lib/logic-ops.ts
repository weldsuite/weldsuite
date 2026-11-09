/**
 * What the logic editor offers: which operators a field type takes, what kind
 * of value the right-hand side needs, and how to keep a condition valid when
 * its left side changes. Built on the engine's own rules (`fieldOperandKind`,
 * `operatorAllowed`) so the editor can never produce what `validateDefinition`
 * refuses.
 */

import {
  fieldOperandKind,
  fieldsOf,
  operatorAllowed,
  type Condition,
  type ConditionGroup,
  type ConditionOperator,
  type FieldBlock,
  type FormDefinition,
  type Operand,
  type OperandKind,
} from '@weldsuite/forms-engine';

/** What the right-hand side of a condition is asked for. */
export type RightInput = 'none' | 'number' | 'boolean' | 'text' | 'date' | 'choice' | 'choices';

const NUMBER_OPS: ConditionOperator[] = ['is', 'is_not', 'greater_than', 'greater_or_equal', 'less_than', 'less_or_equal'];
const TEXT_OPS: ConditionOperator[] = ['is', 'is_not', 'contains', 'not_contains', 'starts_with', 'ends_with'];
const DATE_OPS: ConditionOperator[] = ['is', 'is_not', 'before', 'after'];
const SET_OPS: ConditionOperator[] = ['is', 'is_not', 'any_of', 'all_of', 'none_of'];
const PRESENCE_OPS: ConditionOperator[] = ['is_answered', 'is_empty'];

/** The operators a left-hand value of this kind takes, comparison operators first, then answered / empty. */
export function operatorsForKind(kind: OperandKind): ConditionOperator[] {
  switch (kind) {
    case 'number':
      return [...NUMBER_OPS, ...PRESENCE_OPS];
    case 'boolean':
      return ['is', 'is_not', ...PRESENCE_OPS];
    case 'text':
      return [...TEXT_OPS, ...PRESENCE_OPS];
    case 'date':
      return [...DATE_OPS, ...PRESENCE_OPS];
    case 'set':
      return [...SET_OPS, ...PRESENCE_OPS];
    case 'list':
    case 'opaque':
      return [...PRESENCE_OPS];
  }
}

export function isPresenceOperator(operator: ConditionOperator): boolean {
  return operator === 'is_answered' || operator === 'is_empty';
}

/** The input the right-hand side needs for a constant, given the left kind and the operator. */
export function rightInputFor(kind: OperandKind, operator: ConditionOperator): RightInput {
  if (isPresenceOperator(operator)) return 'none';
  switch (kind) {
    case 'number':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'date':
      return 'date';
    case 'set':
      return operator === 'is' || operator === 'is_not' ? 'choice' : 'choices';
    case 'text':
      return 'text';
    default:
      return 'none';
  }
}

/** The kind of a left operand, or null when it points at nothing. */
export function operandKind(def: FormDefinition, operand: Operand, variableTypes: Map<string, 'number' | 'text'>): OperandKind | null {
  switch (operand.type) {
    case 'field': {
      const field = fieldsOf(def).find((f) => f.id === operand.id);
      return field ? fieldOperandKind(field, operand) : null;
    }
    case 'hidden':
      return 'text';
    case 'variable':
      return variableTypes.get(operand.name) ?? null;
    case 'constant':
      return typeof operand.value === 'number' ? 'number' : typeof operand.value === 'boolean' ? 'boolean' : typeof operand.value === 'string' ? 'text' : 'list';
  }
}

/** `score` always exists; the rest are declared. */
export function variableTypeMap(def: Pick<FormDefinition, 'variables'>): Map<string, 'number' | 'text'> {
  const map = new Map<string, 'number' | 'text'>([['score', 'number']]);
  for (const v of def.variables) map.set(v.name, v.type);
  return map;
}

/** The fields a rule on the block at `sourceIndex` can read: those in that block or before it (all of them for ending rules). */
export function readableFields(def: FormDefinition, sourceIndex: number | null): FieldBlock[] {
  const out: FieldBlock[] = [];
  def.blocks.forEach((block, i) => {
    if (sourceIndex !== null && i > sourceIndex) return;
    if (block.type === 'group') {
      for (const child of block.children) if (child.type !== 'statement') out.push(child);
    } else if (block.type !== 'statement' && block.type !== 'page_break') {
      out.push(block);
    }
  });
  return out;
}

/** A constant of the right shape for an input kind. */
export function defaultConstant(input: RightInput): Operand {
  switch (input) {
    case 'number':
      return { type: 'constant', value: 0 };
    case 'boolean':
      return { type: 'constant', value: true };
    case 'choices':
      return { type: 'constant', value: [] };
    default:
      return { type: 'constant', value: '' };
  }
}

/** The default left operand for a field: a matrix gets its first row, contact info and address their first part. */
export function leftOperandForField(field: FieldBlock): Extract<Operand, { type: 'field' }> {
  if (field.type === 'matrix') return { type: 'field', id: field.id, rowId: field.properties.rows[0]?.id };
  if (field.type === 'contact_info') return { type: 'field', id: field.id, part: 'email' };
  if (field.type === 'address') return { type: 'field', id: field.id, part: 'city' };
  return { type: 'field', id: field.id };
}

/** A new condition on a field, with the first operator and an empty value. */
export function conditionForField(field: FieldBlock): Condition {
  const left = leftOperandForField(field);
  const kind = fieldOperandKind(field, left);
  return conditionFor(left, kind);
}

export function conditionFor(left: Operand, kind: OperandKind): Condition {
  const operator = operatorsForKind(kind)[0] ?? 'is_answered';
  const input = rightInputFor(kind, operator);
  return input === 'none' ? { left, operator } : { left, operator, right: defaultConstant(input) };
}

/**
 * After the left side or the operator changed: keep what still fits, and
 * otherwise fall back to the first operator and an empty constant.
 */
export function reconcileCondition(condition: Condition, leftKind: OperandKind | null): Condition {
  if (leftKind === null) return condition;
  const operators = operatorsForKind(leftKind);
  const operator = operators.includes(condition.operator) ? condition.operator : (operators[0] ?? 'is_answered');
  const input = rightInputFor(leftKind, operator);
  if (input === 'none') return { left: condition.left, operator };
  const right = condition.right;
  if (right && fitsInput(right, input)) return { left: condition.left, operator, right };
  return { left: condition.left, operator, right: defaultConstant(input) };
}

function fitsInput(operand: Operand, input: RightInput): boolean {
  // A field, hidden field or variable on the right stays unless a list of choices is needed.
  if (operand.type !== 'constant') return input !== 'choices';
  const v = operand.value;
  switch (input) {
    case 'number':
      return typeof v === 'number';
    case 'boolean':
      return typeof v === 'boolean';
    case 'choices':
      return Array.isArray(v);
    case 'choice':
    case 'text':
    case 'date':
      return typeof v === 'string';
    case 'none':
      return false;
  }
}

/** Is `left operator right` something the engine accepts? */
export function isConditionValid(def: FormDefinition, condition: Condition): boolean {
  const types = variableTypeMap(def);
  const left = operandKind(def, condition.left, types);
  if (left === null) return false;
  if (isPresenceOperator(condition.operator)) return true;
  if (!condition.right) return false;
  const right = operandKind(def, condition.right, types);
  return operatorAllowed(left, condition.operator, right, condition.right);
}

/** An empty AND group with one condition, for "add rule". */
export function newGroup(condition: Condition): ConditionGroup {
  return { op: 'and', conditions: [condition] };
}

/** The leaf conditions of a group, flattened (for counting and summaries). */
export function flattenConditions(group: ConditionGroup): Condition[] {
  return group.conditions.flatMap((item) => ('op' in item ? item.conditions : [item]));
}
