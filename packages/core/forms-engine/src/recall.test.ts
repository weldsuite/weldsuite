import { describe, expect, it } from 'vitest';
import { formDefinitionSchema } from './definition';
import { SEARCH_TEXT_MAX, displayAnswer, formatNumber, searchText } from './display';
import { recall, recallTokens } from './recall';

const def = formDefinitionSchema.parse({
  blocks: [
    { id: 'b_name', ref: 'name', type: 'short_text', title: 'Name' },
    { id: 'b_bio', ref: 'bio', type: 'long_text', title: 'Bio' },
    { id: 'b_n', ref: 'amount', type: 'number', title: 'Amount', properties: { decimals: 2 } },
  ],
  endings: [{ id: 'e_1', ref: 'end', title: 'End' }],
});

describe('recall', () => {
  it('fills tokens and leaves other braces alone', () => {
    expect(recall('{{field:name}} paid {{field:amount}} ({{var:plan}}) {{other}} {{field:}}', def, {
      answers: { b_name: 'Ann', b_n: 12.5 },
      variables: { plan: 'pro' },
    })).toBe('Ann paid 12.5 (pro) {{other}} {{field:}}');
  });

  it('lists the tokens of a text', () => {
    expect(recallTokens('{{field:name}} {{ hidden:utm_source }} {{var:score}}')).toEqual([
      { kind: 'field', name: 'name' },
      { kind: 'hidden', name: 'utm_source' },
      { kind: 'var', name: 'score' },
    ]);
  });
});

describe('display', () => {
  it('formats numbers like JavaScript', () => {
    expect(formatNumber(-0)).toBe('0');
    expect(formatNumber(0.1)).toBe('0.1');
    expect(formatNumber(1e21)).toBe('1e+21');
  });

  it('shows nothing for an invalid shape', () => {
    const field = def.blocks[2];
    if (!field || field.type !== 'number') throw new Error('missing field');
    expect(displayAnswer(field, 'seven')).toBe('');
  });

  it('cuts the search text at 10,000 code points', () => {
    const text = searchText(def, { b_name: 'A'.repeat(6000), b_bio: '😀'.repeat(6000) });
    expect(Array.from(text)).toHaveLength(SEARCH_TEXT_MAX);
    expect(text.startsWith('a'.repeat(6000))).toBe(true);
    expect(text.endsWith('😀')).toBe(true);
  });
});
