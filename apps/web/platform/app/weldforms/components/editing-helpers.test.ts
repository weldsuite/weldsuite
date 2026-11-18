import { describe, expect, it } from 'vitest';
import { createBlankDefinition, createField, type FormDefinition } from '@weldsuite/forms-engine';
import { closesBeforeOpens } from '../lib/datetime';
import { newCondition } from '../form/logic/condition-editor';
import { duplicateLabels, parsePastedChoices } from './choices-editor';
import { clampNumber } from './prop-controls';
import { insertAtCaret, recallOptions } from './recall-input';

describe('parsePastedChoices', () => {
  it('splits lines and drops bullets, numbers and blanks', () => {
    expect(parsePastedChoices('- Red\n* Green\r\n1. Blue\n  \n2) Yellow\nPlain')).toEqual(['Red', 'Green', 'Blue', 'Yellow', 'Plain']);
    expect(parsePastedChoices('')).toEqual([]);
  });
});

describe('insertAtCaret', () => {
  it('inserts at the caret and replaces a selection', () => {
    expect(insertAtCaret('Hello !', '{{var:score}}', 6, 6)).toEqual({ text: 'Hello {{var:score}}!', caret: 19 });
    expect(insertAtCaret('Hello world', 'X', 6, 11).text).toBe('Hello X');
    expect(insertAtCaret('abc', 'X', null, null).text).toBe('abcX');
  });
});

describe('recallOptions', () => {
  it('offers earlier questions, hidden fields and variables (with score)', () => {
    const a = createField('short_text', { ref: 'first', title: 'First' });
    const b = createField('short_text', { ref: 'second', title: 'Second' });
    const def: FormDefinition = { ...createBlankDefinition(), blocks: [a, b], hidden: [{ name: 'utm_source' }], variables: [{ name: 'total', type: 'number', initial: 0 }] };
    expect(recallOptions(def, 1).map((o) => o.token)).toEqual(['{{field:first}}', '{{hidden:utm_source}}', '{{var:score}}', '{{var:total}}']);
    expect(recallOptions(def, null).filter((o) => o.group === 'fields')).toHaveLength(2);
    expect(recallOptions(def, 0).filter((o) => o.group === 'fields')).toHaveLength(0);
  });
});

describe('duplicateLabels', () => {
  it('names labels more than one option has, ignoring case and spaces', () => {
    const choices = [{ id: 'c_1', label: 'Red' }, { id: 'c_2', label: ' red ' }, { id: 'c_3', label: 'Blue' }, { id: 'c_4', label: '' }, { id: 'c_5', label: '' }];
    expect(duplicateLabels(choices)).toEqual(['Red']);
    expect(duplicateLabels(choices.slice(2))).toEqual([]);
  });
});

describe('clampNumber', () => {
  it('keeps a typed value within the range, whole when asked', () => {
    expect(clampNumber(-5, { min: 1, max: 1000, integer: true })).toBe(1);
    expect(clampNumber(0, { min: 1 })).toBe(1);
    expect(clampNumber(5000, { min: 1, max: 1000 })).toBe(1000);
    expect(clampNumber(2.6, { min: 1, integer: true })).toBe(3);
    expect(clampNumber(2.5, {})).toBe(2.5);
    expect(clampNumber(undefined, { min: 1 })).toBeUndefined();
  });
});

describe('closesBeforeOpens', () => {
  it('flags a close at or before the open, not a missing date', () => {
    expect(closesBeforeOpens('2027-01-10T10:00:00+01:00', '2027-01-01T10:00:00+01:00')).toBe(true);
    expect(closesBeforeOpens('2027-01-01T10:00:00+01:00', '2027-01-01T10:00:00+01:00')).toBe(true);
    expect(closesBeforeOpens('2027-01-01T10:00:00+01:00', '2027-01-10T10:00:00+01:00')).toBe(false);
    expect(closesBeforeOpens(null, '2027-01-01T10:00:00+01:00')).toBe(false);
  });
});

describe('newCondition', () => {
  it('starts a jump on the question it leaves, not the first question', () => {
    const a = createField('short_text', { ref: 'first', title: 'First' });
    const b = createField('yes_no', { ref: 'customer', title: 'Customer?' });
    const def: FormDefinition = { ...createBlankDefinition(), blocks: [a, b] };
    expect(newCondition({ def, sourceIndex: 1, disabled: false }).left).toEqual({ type: 'field', id: b.id });
    expect(newCondition({ def, sourceIndex: null, disabled: false }).left).toEqual({ type: 'field', id: a.id });
  });
});
