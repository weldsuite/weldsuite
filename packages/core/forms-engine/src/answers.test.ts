import { describe, expect, it } from 'vitest';
import {
  hasAtMostDecimals,
  isAnswered,
  isValidDate,
  isValidEmail,
  isValidPhone,
  isValidUrl,
  normalizeAnswer,
  normalizeAnswers,
  validateAnswer,
} from './answers';
import { createField } from './builder';
import { fieldBlockSchema, formDefinitionSchema, type FieldBlock } from './definition';

function field(input: Record<string, unknown>): FieldBlock {
  return fieldBlockSchema.parse({ id: 'b_f', ref: 'f', title: 'F', ...input });
}

describe('isAnswered', () => {
  it('treats undefined, null and blank strings as unanswered', () => {
    const text = field({ type: 'short_text' });
    expect(isAnswered(text, undefined)).toBe(false);
    expect(isAnswered(text, null)).toBe(false);
    expect(isAnswered(text, '   ')).toBe(false);
    expect(isAnswered(text, 'x')).toBe(true);
  });

  it('counts false and wrong shapes as answered', () => {
    expect(isAnswered(field({ type: 'yes_no' }), false)).toBe(true);
    expect(isAnswered(field({ type: 'number' }), 'seven')).toBe(true);
  });

  it('treats empty choices, matrices and file lists as unanswered', () => {
    const choice = createField('multiple_choice');
    expect(isAnswered(choice, { choiceIds: [] })).toBe(false);
    expect(isAnswered(choice, { choiceIds: [], other: ' ' })).toBe(false);
    expect(isAnswered(createField('matrix'), {})).toBe(false);
    expect(isAnswered(createField('file_upload'), [])).toBe(false);
    expect(isAnswered(createField('contact_info'), { firstName: ' ' })).toBe(false);
  });
});

describe('normalizeAnswer', () => {
  it('trims text and prefixes a website', () => {
    expect(normalizeAnswer(field({ type: 'long_text' }), '  hi  ')).toBe('hi');
    expect(normalizeAnswer(field({ type: 'website' }), 'weldsuite.org')).toBe('https://weldsuite.org');
    expect(normalizeAnswer(field({ type: 'website' }), 'http://weldsuite.org')).toBe('http://weldsuite.org');
  });

  it('dedupes choices and keeps a real choice called other', () => {
    const f = field({
      type: 'multiple_choice',
      properties: { multiple: true, choices: [{ id: 'other', label: 'Other' }, { id: 'c_1', label: 'One' }] },
    });
    expect(normalizeAnswer(f, { choiceIds: ['other', 'c_1', 'other'] })).toEqual({ choiceIds: ['other', 'c_1'] });
  });

  it('returns undefined for a wrong shape', () => {
    expect(normalizeAnswer(field({ type: 'number' }), '3')).toBeUndefined();
  });

  it('normalises a whole answer map and drops unknown ids', () => {
    const def = formDefinitionSchema.parse({
      blocks: [{ id: 'b_1', ref: 'one', type: 'short_text', title: 'One' }],
      endings: [{ id: 'e_1', ref: 'end', title: 'End' }],
    });
    expect(normalizeAnswers(def, { b_1: ' a ', b_x: 'b', toString: 'c' })).toEqual({ b_1: 'a' });
  });
});

describe('validateAnswer', () => {
  it('reports required only when required', () => {
    expect(validateAnswer(field({ type: 'short_text', required: true }), undefined)).toEqual({ code: 'required' });
    expect(validateAnswer(field({ type: 'short_text' }), undefined)).toBeNull();
  });

  it('counts text length in code points', () => {
    const f = field({ type: 'short_text', properties: { maxLength: 3 } });
    expect(validateAnswer(f, '😀😀😀')).toBeNull();
    expect(validateAnswer(f, '😀😀😀😀')).toEqual({ code: 'too_long' });
  });

  it('checks a legal field only when required', () => {
    expect(validateAnswer(field({ type: 'legal', required: true }), false)).toEqual({ code: 'must_accept' });
    expect(validateAnswer(field({ type: 'legal' }), false)).toBeNull();
  });

  it('checks a ranking is a permutation', () => {
    const f = createField('ranking');
    const ids = f.properties.choices.map((c) => c.id);
    expect(validateAnswer(f, [...ids].reverse())).toBeNull();
    expect(validateAnswer(f, ids.slice(1))).toEqual({ code: 'invalid' });
  });

  it('checks contact info sub-fields', () => {
    const f = createField('contact_info');
    expect(validateAnswer(f, { firstName: 'A', lastName: 'B', email: 'a@b.co', phone: 'abc' })).toEqual({
      code: 'invalid_phone',
      part: 'phone',
    });
    expect(validateAnswer(f, { firstName: 'A', lastName: 'B', email: 'a@b.co', phone: '+31 6 1234 5678' })).toBeNull();
  });

  it('checks the minimum selections of a multiple choice only when answered', () => {
    const f = field({
      type: 'multiple_choice',
      properties: { multiple: true, minSelections: 2, choices: [{ id: 'c_1', label: '1' }, { id: 'c_2', label: '2' }] },
    });
    expect(validateAnswer(f, undefined)).toBeNull();
    expect(validateAnswer(f, { choiceIds: ['c_1'] })).toEqual({ code: 'too_few_choices' });
    expect(validateAnswer(f, { choiceIds: ['c_1', 'c_2'] })).toBeNull();
  });
});

describe('format checks', () => {
  it('emails', () => {
    expect(isValidEmail('a@b.co')).toBe(true);
    expect(isValidEmail('a b@c.de')).toBe(false);
    expect(isValidEmail('a@b')).toBe(false);
    expect(isValidEmail(`${'a'.repeat(250)}@b.co`)).toBe(false);
  });

  it('urls', () => {
    expect(isValidUrl('https://a.b/c?d#e')).toBe(true);
    expect(isValidUrl('https://münchen.de')).toBe(true);
    expect(isValidUrl('https://user@a.b')).toBe(false);
    expect(isValidUrl('mailto:a@b.co')).toBe(false);
  });

  it('phones', () => {
    expect(isValidPhone('123456')).toBe(true);
    expect(isValidPhone('12345')).toBe(false);
    expect(isValidPhone('+1 (555) 010-0000')).toBe(true);
    expect(isValidPhone('1'.repeat(21))).toBe(false);
    expect(isValidPhone('555+1234567')).toBe(false);
  });

  it('dates', () => {
    expect(isValidDate('2024-02-29')).toBe(true);
    expect(isValidDate('2023-02-29')).toBe(false);
    expect(isValidDate('2000-02-29')).toBe(true);
    expect(isValidDate('2024-04-31')).toBe(false);
    expect(isValidDate('0000-01-01')).toBe(false);
    expect(isValidDate('2024-1-01')).toBe(false);
  });

  it('decimals', () => {
    expect(hasAtMostDecimals(0.1 + 0.2, 1)).toBe(true);
    expect(hasAtMostDecimals(1.005, 2)).toBe(false);
    expect(hasAtMostDecimals(1e9 + 0.5, 0)).toBe(false);
    expect(hasAtMostDecimals(-3, 0)).toBe(true);
  });
});
