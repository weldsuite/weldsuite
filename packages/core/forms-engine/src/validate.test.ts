import { describe, expect, it } from 'vitest';
import { ENDING_URL_MESSAGE, formDefinitionSchema, isEndingUrl, type FormDefinitionInput } from './definition';
import { operatorAllowed, parseDefinition, validateDefinition } from './validate';

function issues(input: FormDefinitionInput) {
  return validateDefinition(formDefinitionSchema.parse(input));
}

const ending = { id: 'e_1', ref: 'end', title: 'End' };

describe('parseDefinition', () => {
  it('returns the parsed definition with defaults', () => {
    const result = parseDefinition({ blocks: [{ id: 'b_1', ref: 'one', type: 'number', title: 'One' }], endings: [ending] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.definition.presentation.layout).toBe('conversational');
    expect(result.definition.blocks[0]).toMatchObject({ required: false, properties: { decimals: 0 } });
  });

  it('maps zod errors to schema issues with their path', () => {
    const result = parseDefinition({ blocks: [{ id: 'b_1', ref: 'Bad Ref', type: 'short_text', title: 'X' }], endings: [ending] });
    expect(result).toEqual({
      ok: false,
      issues: [expect.objectContaining({ code: 'schema', path: 'blocks.0.ref' })],
    });
  });

  it('takes only web links as ending links, recall after the scheme', () => {
    for (const url of ['', 'https://example.com/?e={{field:end}}', 'HTTP://EXAMPLE.COM', 'Https://example.com', 'http://']) {
      expect(isEndingUrl(url)).toBe(true);
    }
    for (const url of ['javascript:alert(1)', ' https://example.com', '{{hidden:next}}', '//example.com', 'example.com', 'https:example.com', 'ſttps://example.com']) {
      expect(isEndingUrl(url)).toBe(false);
    }
    const result = parseDefinition({
      blocks: [],
      endings: [
        { ...ending, redirectUrl: 'javascript:alert(1)', button: { text: 'Go', url: 'mailto:x@example.com' } },
        { id: 'e_2', ref: 'two', title: 'Two', redirectUrl: 'https://example.com/?n={{var:score}}', button: { text: 'Go', url: '' } },
      ],
    });
    expect(result).toEqual({
      ok: false,
      issues: [
        { code: 'schema', path: 'endings.0.redirectUrl', message: ENDING_URL_MESSAGE },
        { code: 'schema', path: 'endings.0.button.url', message: ENDING_URL_MESSAGE },
      ],
    });
  });
});

describe('validateDefinition', () => {
  it('reports the path and block of a duplicate', () => {
    expect(
      issues({
        blocks: [
          { id: 'b_1', ref: 'one', type: 'short_text', title: 'One' },
          {
            id: 'b_g',
            ref: 'group',
            type: 'group',
            title: 'G',
            children: [{ id: 'b_1', ref: 'two', type: 'short_text', title: 'Two' }],
          },
        ],
        endings: [ending],
      }),
    ).toEqual([expect.objectContaining({ code: 'duplicate_id', path: 'blocks.1.children.0.id', blockId: 'b_1' })]);
  });

  it('reports nested condition paths', () => {
    const result = issues({
      blocks: [{ id: 'b_1', ref: 'one', type: 'short_text', title: 'One' }],
      endings: [ending],
      endingRules: [
        {
          id: 'r_1',
          when: {
            op: 'or',
            conditions: [
              { left: { type: 'field', id: 'b_1' }, operator: 'is_answered' },
              { op: 'and', conditions: [{ left: { type: 'hidden', name: 'nope' }, operator: 'is_answered' }] },
            ],
          },
          endingId: 'e_1',
        },
      ],
    });
    expect(result).toEqual([expect.objectContaining({ code: 'unknown_hidden', path: 'endingRules.0.when.conditions.1.conditions.0.left.name' })]);
  });

  it('lets ending rules read any field, and logic read its own block', () => {
    expect(
      issues({
        blocks: [
          { id: 'b_1', ref: 'one', type: 'yes_no', title: 'One' },
          { id: 'b_2', ref: 'two', type: 'number', title: 'Two' },
        ],
        endings: [ending],
        logic: [
          {
            blockId: 'b_1',
            jumps: [
              {
                id: 'j_1',
                when: { op: 'and', conditions: [{ left: { type: 'field', id: 'b_1' }, operator: 'is', right: { type: 'constant', value: true } }] },
                to: { type: 'block', id: 'b_2' },
              },
            ],
          },
        ],
        endingRules: [
          {
            id: 'r_1',
            when: { op: 'and', conditions: [{ left: { type: 'field', id: 'b_2' }, operator: 'greater_than', right: { type: 'variable', name: 'score' } }] },
            endingId: 'e_1',
          },
        ],
      }),
    ).toEqual([]);
  });

  it('counts Other as an option for selection ranges', () => {
    const choices = [{ id: 'c_1', label: 'One' }, { id: 'c_2', label: 'Two' }];
    const field = (props: Record<string, unknown>) => ({
      blocks: [{ id: 'b_1', ref: 'one', type: 'multiple_choice' as const, title: 'One', properties: { choices, ...props } }],
      endings: [ending],
    });
    expect(issues(field({ multiple: true, maxSelections: 3, allowOther: true }))).toEqual([]);
    expect(issues(field({ multiple: true, maxSelections: 3 })).map((i) => i.code)).toEqual(['selection_range']);
    expect(issues(field({ minSelections: 2 })).map((i) => i.code)).toEqual(['selection_range']);
  });
});

describe('operatorAllowed', () => {
  it('follows the operand kinds', () => {
    expect(operatorAllowed('number', 'greater_than', 'number')).toBe(true);
    expect(operatorAllowed('number', 'contains', 'text')).toBe(false);
    expect(operatorAllowed('set', 'any_of', 'list')).toBe(true);
    expect(operatorAllowed('set', 'is', 'text')).toBe(true);
    expect(operatorAllowed('text', 'any_of', 'list')).toBe(false);
    expect(operatorAllowed('opaque', 'is_answered', null)).toBe(true);
    expect(operatorAllowed('opaque', 'is', 'text')).toBe(false);
    expect(operatorAllowed('date', 'before', 'text', { type: 'constant', value: '2024-01-01' })).toBe(true);
    expect(operatorAllowed('date', 'before', 'text', { type: 'constant', value: 'soon' })).toBe(false);
    expect(operatorAllowed('date', 'after', 'text', { type: 'hidden', name: 'since' })).toBe(true);
  });
});
