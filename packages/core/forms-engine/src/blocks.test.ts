import { describe, expect, it } from 'vitest';
import { blockFields, fieldsOf, findBlock, findField, findFieldByRef, isFieldBlock, isScoredField, refsOf, topLevelIndexOf } from './blocks';
import { formDefinitionSchema } from './definition';

const def = formDefinitionSchema.parse({
  blocks: [
    { id: 'b_1', ref: 'first', type: 'short_text', title: 'First' },
    { id: 'b_s', ref: 'note', type: 'statement', title: 'Note' },
    {
      id: 'b_g',
      ref: 'group',
      type: 'group',
      title: 'Group',
      children: [
        { id: 'b_2', ref: 'second', type: 'number', title: 'Second' },
        { id: 'b_gs', ref: 'group_note', type: 'statement', title: 'Note' },
        {
          id: 'b_3',
          ref: 'third',
          type: 'multiple_choice',
          title: 'Third',
          properties: { choices: [{ id: 'c_1', label: 'One', score: 1 }] },
        },
      ],
    },
    { id: 'b_p', ref: 'page', type: 'page_break' },
    { id: 'b_4', ref: 'fourth', type: 'yes_no', title: 'Fourth' },
  ],
  endings: [{ id: 'e_1', ref: 'end', title: 'End' }],
});

describe('blocks', () => {
  it('lists every field in order, group children included', () => {
    expect(fieldsOf(def).map((f) => f.id)).toEqual(['b_1', 'b_2', 'b_3', 'b_4']);
  });

  it('finds top-level blocks and group children', () => {
    expect(findBlock(def, 'b_s')?.type).toBe('statement');
    expect(findBlock(def, 'b_gs')?.type).toBe('statement');
    expect(findBlock(def, 'nope')).toBeUndefined();
    expect(findField(def, 'b_3')?.ref).toBe('third');
    expect(findField(def, 'b_s')).toBeUndefined();
    expect(findFieldByRef(def, 'fourth')?.id).toBe('b_4');
  });

  it('gives the top-level index of a block or its group', () => {
    expect(topLevelIndexOf(def, 'b_1')).toBe(0);
    expect(topLevelIndexOf(def, 'b_3')).toBe(2);
    expect(topLevelIndexOf(def, 'b_4')).toBe(4);
    expect(topLevelIndexOf(def, 'nope')).toBe(-1);
  });

  it('knows field blocks, scored fields, block fields and refs', () => {
    expect(def.blocks.map((b) => isFieldBlock(b))).toEqual([true, false, false, false, true]);
    const group = def.blocks[2];
    if (!group) throw new Error('missing group');
    expect(blockFields(group).map((f) => f.id)).toEqual(['b_2', 'b_3']);
    const third = findField(def, 'b_3');
    if (!third) throw new Error('missing field');
    expect(isScoredField(third)).toBe(true);
    expect(refsOf(def)).toEqual(['first', 'note', 'group', 'second', 'group_note', 'third', 'page', 'fourth', 'end']);
  });
});
