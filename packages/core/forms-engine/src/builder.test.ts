import { describe, expect, it } from 'vitest';
import {
  createBlankDefinition,
  createEnding,
  createField,
  createGroup,
  createPageBreak,
  createStatement,
  newBlockId,
  slugifyRef,
  uniqueRef,
} from './builder';
import { FIELD_TYPES } from './definition';
import { parseDefinition } from './validate';

describe('newBlockId', () => {
  it('is the prefix plus 8 base62 characters', () => {
    for (const prefix of ['b', 'e', 'c', 'r', 'k', 'j', 'x'] as const) {
      expect(newBlockId(prefix)).toMatch(new RegExp(`^${prefix}_[0-9A-Za-z]{8}$`));
    }
    const ids = new Set(Array.from({ length: 1000 }, () => newBlockId('b')));
    expect(ids.size).toBe(1000);
  });
});

describe('createBlankDefinition', () => {
  it('is valid, empty and ends with Thank you!', () => {
    const def = createBlankDefinition();
    expect(def.blocks).toEqual([]);
    expect(def.welcome).toBeNull();
    expect(def.endings).toEqual([expect.objectContaining({ ref: 'thank_you', title: 'Thank you!' })]);
    expect(def.presentation).toEqual({ layout: 'conversational', language: 'en', progressBar: 'percentage', showQuestionNumbers: true, allowBack: true });
    expect(parseDefinition(def).ok).toBe(true);
  });
});

describe('createField', () => {
  it('makes a valid field of every type', () => {
    const def = createBlankDefinition();
    for (const type of FIELD_TYPES) def.blocks.push(createField(type, { title: type }));
    def.blocks.push(createStatement(), createGroup({ title: 'Group' }), createPageBreak());
    def.endings.push(createEnding({ title: 'Another' }));
    const result = parseDefinition(def);
    expect(result.ok ? [] : result.issues).toEqual([]);
  });

  it('has sensible defaults', () => {
    const choice = createField('multiple_choice', { title: 'Pick', ref: 'pick' });
    expect(choice).toMatchObject({ type: 'multiple_choice', title: 'Pick', ref: 'pick', required: false });
    expect(choice.properties.choices.map((c) => c.label)).toEqual(['Option 1', 'Option 2', 'Option 3']);
    const matrix = createField('matrix');
    expect(matrix.properties.rows).toHaveLength(2);
    expect(matrix.properties.columns).toHaveLength(3);
    expect(createField('rating').properties).toEqual({ steps: 5, shape: 'star' });
    expect(createField('short_text').ref).toMatch(/^short_text_[a-z0-9]{4}$/);
  });
});

describe('refs', () => {
  it('slugifies titles', () => {
    expect(slugifyRef('Company size?')).toBe('company_size');
    expect(slugifyRef('Wat is je e-mailadres? Één')).toBe('wat_is_je_e_mailadres_een');
    expect(slugifyRef('2024 budget')).toBe('q_2024_budget');
    expect(slugifyRef('!!!')).toBe('question');
    expect(slugifyRef('a'.repeat(100))).toHaveLength(64);
  });

  it('finds a free ref', () => {
    const def = createBlankDefinition();
    def.blocks.push(createField('short_text', { ref: 'company_size' }), createField('short_text', { ref: 'company_size_2' }));
    expect(uniqueRef(def, 'Company size')).toBe('company_size_3');
    expect(uniqueRef(def, 'Thank you')).toBe('thank_you_2');
    const first = def.blocks[0];
    if (!first) throw new Error('missing block');
    expect(uniqueRef(def, 'Company size', first.id)).toBe('company_size');
    const long = 'x'.repeat(64);
    def.blocks.push(createField('short_text', { ref: long }));
    expect(uniqueRef(def, long)).toBe(`${'x'.repeat(62)}_2`);
  });
});
