import { describe, expect, it } from 'vitest';
import { createEvalContext, evaluateCondition, parseNumericText, roundNumber } from './conditions';
import { formDefinitionSchema, type FormDefinitionInput } from './definition';
import { classicPages, computePath, firstStep, nextStep } from './path';

const always = { op: 'and' as const, conditions: [{ left: { type: 'constant' as const, value: 1 }, operator: 'is_answered' as const }] };

function build(input: Omit<FormDefinitionInput, 'endings'> & Partial<Pick<FormDefinitionInput, 'endings'>>) {
  return formDefinitionSchema.parse({ endings: [{ id: 'e_1', ref: 'end', title: 'End' }], ...input });
}

const text = (id: string) => ({ id, ref: id, type: 'short_text' as const, title: id });

describe('computePath', () => {
  it('ends at endings[0] for an empty form', () => {
    expect(computePath(build({ blocks: [] }), { answers: {} })).toEqual({ path: [], endingId: 'e_1', variables: { score: 0 } });
  });

  it('treats a backward jump, a jump to a page break and an unknown target as the next block', () => {
    const def = build({
      blocks: [text('b_1'), text('b_2'), { id: 'b_p', ref: 'page', type: 'page_break' }, text('b_3')],
      logic: [
        { blockId: 'b_2', jumps: [{ id: 'j_back', when: always, to: { type: 'block', id: 'b_1' } }] },
        { blockId: 'b_1', otherwise: { type: 'block', id: 'b_p' } },
        { blockId: 'b_3', otherwise: { type: 'ending', id: 'e_missing' } },
      ],
    });
    expect(computePath(def, { answers: {} }).path).toEqual(['b_1', 'b_2', 'b_3']);
  });

  it('uses the first logic entry of a block only', () => {
    const def = build({
      blocks: [text('b_1'), text('b_2'), text('b_3')],
      logic: [
        { blockId: 'b_1', otherwise: { type: 'block', id: 'b_3' } },
        { blockId: 'b_1', otherwise: { type: 'block', id: 'b_2' } },
      ],
    });
    expect(computePath(def, { answers: {} }).path).toEqual(['b_1', 'b_3']);
  });

  it('ignores endingRules pointing at a missing ending', () => {
    const def = build({
      blocks: [text('b_1')],
      endings: [
        { id: 'e_1', ref: 'one', title: 'One' },
        { id: 'e_2', ref: 'two', title: 'Two' },
      ],
      endingRules: [
        { id: 'r_1', when: always, endingId: 'e_missing' },
        { id: 'r_2', when: always, endingId: 'e_2' },
      ],
    });
    expect(computePath(def, { answers: {} }).endingId).toBe('e_2');
  });
});

describe('nextStep', () => {
  const def = build({
    blocks: [
      text('b_1'),
      { id: 'b_g', ref: 'group', type: 'group', title: 'G', children: [text('b_2')] },
      text('b_3'),
      text('b_4'),
    ],
    endings: [
      { id: 'e_1', ref: 'one', title: 'One' },
      { id: 'e_2', ref: 'two', title: 'Two' },
    ],
    logic: [
      {
        blockId: 'b_1',
        jumps: [
          {
            id: 'j_skip',
            when: { op: 'and', conditions: [{ left: { type: 'field', id: 'b_1' }, operator: 'is', right: { type: 'constant', value: 'skip' } }] },
            to: { type: 'block', id: 'b_3' },
          },
          {
            id: 'j_end',
            when: { op: 'and', conditions: [{ left: { type: 'field', id: 'b_1' }, operator: 'is', right: { type: 'constant', value: 'end' } }] },
            to: { type: 'ending', id: 'e_2' },
          },
        ],
      },
    ],
  });

  it('follows the logic of the current block', () => {
    expect(firstStep(def, { answers: {} })).toBe('b_1');
    expect(nextStep(def, { answers: {} }, 'b_1')).toBe('b_g');
    expect(nextStep(def, { answers: { b_1: 'Skip' } }, 'b_1')).toBe('b_3');
    expect(nextStep(def, { answers: { b_1: 'end' } }, 'b_1')).toEqual({ endingId: 'e_2' });
  });

  it('treats a group child as its group and ends after the last block', () => {
    expect(nextStep(def, { answers: {} }, 'b_2')).toBe('b_3');
    expect(nextStep(def, { answers: {} }, 'b_4')).toEqual({ endingId: 'e_1' });
  });

  it('moves on from a block that is no longer on the path', () => {
    expect(nextStep(def, { answers: { b_1: 'skip' } }, 'b_g')).toBe('b_3');
    expect(nextStep(def, { answers: {} }, 'b_unknown')).toBe('b_1');
  });

  it('starts at an ending when there are no content blocks', () => {
    const empty = build({ blocks: [{ id: 'b_p', ref: 'page', type: 'page_break' }] });
    expect(firstStep(empty, { answers: {} })).toEqual({ endingId: 'e_1' });
  });
});

describe('classicPages', () => {
  it('splits the path at page breaks and drops empty pages', () => {
    const def = build({
      blocks: [
        { id: 'p_0', ref: 'page_0', type: 'page_break' },
        text('b_1'),
        text('b_2'),
        { id: 'p_1', ref: 'page_1', type: 'page_break' },
        text('b_3'),
        { id: 'p_2', ref: 'page_2', type: 'page_break' },
        text('b_4'),
      ],
    });
    expect(classicPages(def, ['b_1', 'b_2', 'b_3', 'b_4'])).toEqual([['b_1', 'b_2'], ['b_3'], ['b_4']]);
    expect(classicPages(def, ['b_1', 'b_4'])).toEqual([['b_1'], ['b_4']]);
  });
});

describe('conditions', () => {
  const def = build({
    hidden: [{ name: 'src' }],
    variables: [{ name: 'note', type: 'text', initial: '' }],
    blocks: [text('b_1'), { id: 'b_n', ref: 'n', type: 'number', title: 'N' }],
  });

  it('only reads answers whose block is on the path', () => {
    const ctx = createEvalContext(def, { b_1: 'x' }, {});
    const cond = { left: { type: 'field' as const, id: 'b_1' }, operator: 'is_answered' as const };
    expect(evaluateCondition(cond, ctx)).toBe(false);
    ctx.visible.add('b_1');
    expect(evaluateCondition(cond, ctx)).toBe(true);
  });

  it('is false on mismatched kinds, even for is_not', () => {
    const ctx = createEvalContext(def, { b_n: 5 }, { src: '5' });
    ctx.visible.add('b_n');
    expect(evaluateCondition({ left: { type: 'field', id: 'b_n' }, operator: 'is_not', right: { type: 'hidden', name: 'src' } }, ctx)).toBe(false);
    expect(evaluateCondition({ left: { type: 'field', id: 'b_n' }, operator: 'is', right: { type: 'constant', value: 5 } }, ctx)).toBe(true);
  });

  it('treats an empty text variable as empty', () => {
    const ctx = createEvalContext(def, {}, {});
    expect(evaluateCondition({ left: { type: 'variable', name: 'note' }, operator: 'is_empty' }, ctx)).toBe(true);
    expect(evaluateCondition({ left: { type: 'variable', name: 'score' }, operator: 'is_empty' }, ctx)).toBe(false);
  });

  it('rounds and parses numbers', () => {
    expect(roundNumber(0.1 + 0.2)).toBe(0.3);
    expect(roundNumber(-2.5e-11)).toBe(0);
    expect(Object.is(roundNumber(-1e-12), 0)).toBe(true);
    expect(roundNumber(-0.00000000005)).toBe(-0.0000000001);
    expect(parseNumericText(' -12.5 ')).toBe(-12.5);
    expect(parseNumericText('1e3')).toBeNull();
    expect(parseNumericText('12.')).toBeNull();
  });
});
