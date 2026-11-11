import { describe, expect, it } from 'vitest';
import { createBlankDefinition, createField, type FormDefinition } from '@weldsuite/forms-engine';
import { parsePastedChoices } from './choices-editor';
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
