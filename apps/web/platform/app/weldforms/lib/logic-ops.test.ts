import { describe, expect, it } from 'vitest';
import {
  CONDITION_OPERATORS,
  createBlankDefinition,
  createField,
  fieldOperandKind,
  operatorAllowed,
  validateDefinition,
  type Condition,
  type FieldType,
  type FormDefinition,
  type OperandKind,
} from '@weldsuite/forms-engine';
import { conditionForField, isConditionValid, operandKind, operatorsForKind, readableFields, reconcileCondition, rightInputFor, variableTypeMap } from './logic-ops';

const KINDS: OperandKind[] = ['number', 'boolean', 'text', 'date', 'set', 'list', 'opaque'];
const RIGHT_FOR: Record<OperandKind, OperandKind[]> = {
  number: ['number'],
  boolean: ['boolean'],
  text: ['text'],
  date: ['date', 'text'],
  set: ['text', 'list'],
  list: [],
  opaque: [],
};

const engineAccepts = (kind: OperandKind, op: (typeof CONDITION_OPERATORS)[number]) =>
  RIGHT_FOR[kind].length === 0 ? operatorAllowed(kind, op, null) : RIGHT_FOR[kind].some((r) => operatorAllowed(kind, op, r));

describe('operatorsForKind', () => {
  it('offers exactly the operators the engine accepts for that kind', () => {
    for (const kind of KINDS) {
      const accepted = CONDITION_OPERATORS.filter((op) => engineAccepts(kind, op));
      expect([kind, [...operatorsForKind(kind)].sort()]).toEqual([kind, [...accepted].sort()]);
    }
  });
});

describe('rightInputFor', () => {
  it('asks for a single choice with is, a list with any_of, nothing with is_answered', () => {
    expect(rightInputFor('set', 'is')).toBe('choice');
    expect(rightInputFor('set', 'any_of')).toBe('choices');
    expect(rightInputFor('set', 'is_answered')).toBe('none');
    expect(rightInputFor('number', 'greater_than')).toBe('number');
    expect(rightInputFor('date', 'before')).toBe('date');
    expect(rightInputFor('boolean', 'is')).toBe('boolean');
  });
});

describe('a new condition on each field type validates', () => {
  const types: FieldType[] = [
    'short_text',
    'long_text',
    'email',
    'phone',
    'number',
    'website',
    'date',
    'multiple_choice',
    'dropdown',
    'picture_choice',
    'yes_no',
    'legal',
    'rating',
    'opinion_scale',
    'nps',
    'matrix',
    'contact_info',
    'address',
  ];
  for (const type of types) {
    it(type, () => {
      const field = createField(type, { ref: 'q' });
      const gate = createField('short_text', { ref: 'gate' });
      const base: FormDefinition = { ...createBlankDefinition(), blocks: [field, gate] };
      let condition = conditionForField(field);
      // A choice or a matrix column needs a real id; the editor makes the author pick one.
      if (condition.right?.type === 'constant' && condition.right.value === '') {
        const props = (field as { properties: { choices?: Array<{ id: string }>; columns?: Array<{ id: string }> } }).properties;
        const id = props.choices?.[0]?.id ?? props.columns?.[0]?.id;
        if (id) condition = { ...condition, right: { type: 'constant', value: id } };
      }
      if (condition.right?.type === 'constant' && condition.right.value === '' && type === 'date') condition = { ...condition, right: { type: 'constant', value: '2026-01-01' } };
      const def: FormDefinition = {
        ...base,
        logic: [{ blockId: gate.id, calculations: [], jumps: [{ id: 'j_1', when: { op: 'and', conditions: [condition] }, to: { type: 'ending', id: base.endings[0]!.id } }], otherwise: null }],
      };
      expect(validateDefinition(def).filter((i) => i.code === 'operator_mismatch' || i.code.startsWith('unknown'))).toEqual([]);
      expect(isConditionValid(def, condition)).toBe(true);
    });
  }
});

describe('reconcileCondition', () => {
  it('falls back to a valid operator and value when the left side changes kind', () => {
    const number = createField('number', { ref: 'n' });
    const text = createField('short_text', { ref: 't' });
    const def: FormDefinition = { ...createBlankDefinition(), blocks: [number, text] };
    const cond: Condition = { left: { type: 'field', id: number.id }, operator: 'greater_than', right: { type: 'constant', value: 5 } };
    const left = { type: 'field' as const, id: text.id };
    const moved = reconcileCondition({ ...cond, left }, operandKind(def, left, variableTypeMap(def)));
    expect(moved.operator).toBe('is');
    expect(moved.right).toEqual({ type: 'constant', value: '' });
  });

  it('drops the right side for answered / empty', () => {
    const cond: Condition = { left: { type: 'field', id: 'x' }, operator: 'is_answered', right: { type: 'constant', value: 'x' } };
    expect(reconcileCondition(cond, 'text')).toEqual({ left: cond.left, operator: 'is_answered' });
  });

  it('keeps a value that still fits', () => {
    const cond: Condition = { left: { type: 'field', id: 'x' }, operator: 'contains', right: { type: 'constant', value: 'abc' } };
    expect(reconcileCondition(cond, 'text')).toEqual(cond);
  });
});

describe('readableFields', () => {
  it('lists fields in and before the source block, all fields for ending rules', () => {
    const [a, b, c] = ['a', 'b', 'c'].map((ref) => createField('short_text', { ref }));
    const def: FormDefinition = { ...createBlankDefinition(), blocks: [a!, b!, c!] };
    expect(readableFields(def, 1).map((f) => f.ref)).toEqual(['a', 'b']);
    expect(readableFields(def, null).map((f) => f.ref)).toEqual(['a', 'b', 'c']);
    expect(readableFields(def, -1)).toEqual([]);
  });

  it('treats a matrix as a set once a row is picked', () => {
    const m = createField('matrix', { ref: 'm' });
    expect(fieldOperandKind(m, {})).toBe('opaque');
    expect(fieldOperandKind(m, { rowId: m.properties.rows[0]!.id })).toBe('set');
  });
});
