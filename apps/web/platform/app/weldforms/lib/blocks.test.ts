import { describe, expect, it } from 'vitest';
import { createBlankDefinition, createField, createGroup, createPageBreak, createStatement, type FormDefinition } from '@weldsuite/forms-engine';
import {
  addBlock,
  addBlockAfter,
  duplicateBlock,
  locate,
  moveBlock,
  nudgeBlock,
  removeBlock,
  removeEnding,
  reorder,
  selectionAfterRemoval,
  updateBlock,
} from './blocks';

const ids = (def: FormDefinition) => def.blocks.map((b) => b.id);

function sample() {
  const a = createField('short_text', { ref: 'a' });
  const b = createField('email', { ref: 'b' });
  const group = createGroup({ ref: 'g' });
  const c = createField('number', { ref: 'c' });
  const d = createStatement({ ref: 'd' });
  const e = createField('yes_no', { ref: 'e' });
  const def: FormDefinition = { ...createBlankDefinition(), blocks: [a, b, { ...group, children: [c, d] }, e] };
  return { def, a, b, group, c, d, e };
}

describe('reorder', () => {
  it('moves an item and clamps the target', () => {
    expect(reorder([1, 2, 3, 4], 0, 2)).toEqual([2, 3, 1, 4]);
    expect(reorder([1, 2, 3, 4], 3, 0)).toEqual([4, 1, 2, 3]);
    expect(reorder([1, 2, 3], 0, 99)).toEqual([2, 3, 1]);
    expect(reorder([1, 2, 3], 9, 0)).toEqual([1, 2, 3]);
  });
});

describe('moveBlock', () => {
  it('reorders top-level blocks', () => {
    const { def, a, b, e } = sample();
    const moved = moveBlock(def, a.id, 3);
    expect(ids(moved)).toEqual([b.id, def.blocks[2]!.id, e.id, a.id]);
  });

  it('moves a field into a group and back out', () => {
    const { def, e, group, c, d } = sample();
    const into = moveBlock(def, e.id, 1, group.id);
    const g = into.blocks.find((x) => x.id === group.id);
    expect(g?.type === 'group' && g.children.map((x) => x.id)).toEqual([c.id, e.id, d.id]);
    expect(into.blocks.some((x) => x.id === e.id)).toBe(false);

    const out = moveBlock(into, e.id, 0, null);
    expect(out.blocks[0]?.id).toBe(e.id);
    expect(locate(out, e.id)).toEqual({ parentId: null, index: 0 });
  });

  it('refuses to put a group or a page break inside a group', () => {
    const { def, group } = sample();
    const pb = createPageBreak({ ref: 'pb' });
    const withBreak = addBlock(def, pb);
    expect(moveBlock(withBreak, pb.id, 0, group.id)).toBe(withBreak);
    const other = createGroup({ ref: 'g2' });
    const withGroup = addBlock(def, other);
    expect(moveBlock(withGroup, other.id, 0, group.id)).toBe(withGroup);
  });

  it('refuses to move a block into itself', () => {
    const { def, group } = sample();
    expect(moveBlock(def, group.id, 0, group.id)).toBe(def);
  });

  it('reorders inside a group', () => {
    const { def, group, c, d } = sample();
    const moved = moveBlock(def, d.id, 0, group.id);
    const g = moved.blocks.find((x) => x.id === group.id);
    expect(g?.type === 'group' && g.children.map((x) => x.id)).toEqual([d.id, c.id]);
  });
});

describe('nudgeBlock', () => {
  it('moves one step and stays put at the edges', () => {
    const { def, a, b } = sample();
    expect(ids(nudgeBlock(def, b.id, -1)).slice(0, 2)).toEqual([b.id, a.id]);
    expect(ids(nudgeBlock(def, a.id, -1))).toEqual(ids(def));
  });
});

describe('addBlock', () => {
  it('adds after the selected top-level block, or inside the group of a selected child', () => {
    const { def, a, c, group } = sample();
    const x = createField('website', { ref: 'x' });
    expect(addBlockAfter(def, x, a.id).blocks[1]?.id).toBe(x.id);
    const afterChild = addBlockAfter(def, createPageBreak({ ref: 'p' }), c.id);
    expect(afterChild.blocks[3]?.type).toBe('page_break');
    const y = createField('website', { ref: 'y' });
    const intoGroup = addBlockAfter(def, y, c.id);
    const g = intoGroup.blocks.find((b) => b.id === group.id);
    expect(g?.type === 'group' && g.children[1]?.id).toBe(y.id);
  });

  it('appends when nothing is selected', () => {
    const { def } = sample();
    const x = createField('website', { ref: 'x' });
    expect(addBlockAfter(def, x, null).blocks.at(-1)?.id).toBe(x.id);
  });
});

describe('removeBlock', () => {
  it('drops the block, its logic and the jumps that pointed at it', () => {
    const { def, a, b, e } = sample();
    const withLogic: FormDefinition = {
      ...def,
      logic: [
        {
          blockId: a.id,
          calculations: [],
          jumps: [{ id: 'j_1', when: { op: 'and', conditions: [{ left: { type: 'field', id: a.id }, operator: 'is_answered' }] }, to: { type: 'block', id: e.id } }],
          otherwise: { type: 'block', id: e.id },
        },
        { blockId: b.id, calculations: [], jumps: [], otherwise: { type: 'block', id: e.id } },
      ],
    };
    const next = removeBlock(withLogic, e.id);
    expect(next.blocks.some((x) => x.id === e.id)).toBe(false);
    // Both entries only existed to jump to e, so both go.
    expect(next.logic).toEqual([]);
    expect(removeBlock(withLogic, b.id).logic.some((l) => l.blockId === b.id)).toBe(false);
  });

  it('removes a group with its children and their logic', () => {
    const { def, group, c } = sample();
    const next = removeBlock({ ...def, logic: [{ blockId: group.id, calculations: [], jumps: [], otherwise: { type: 'ending', id: def.endings[0]!.id } }] }, group.id);
    expect(locate(next, c.id)).toBeNull();
    expect(next.logic).toEqual([]);
  });
});

describe('duplicateBlock', () => {
  it('copies below with new ids and a free ref', () => {
    const { def, a } = sample();
    const next = duplicateBlock(def, a.id);
    expect(next.blocks).toHaveLength(def.blocks.length + 1);
    const copy = next.blocks[1]!;
    expect(copy.id).not.toBe(a.id);
    expect(copy.ref).not.toBe(a.ref);
    expect(copy.type).toBe(a.type);
  });

  it('gives choices new ids so the copy can have its own logic', () => {
    const mc = createField('multiple_choice', { ref: 'mc' });
    const def: FormDefinition = { ...createBlankDefinition(), blocks: [mc] };
    const copy = duplicateBlock(def, mc.id).blocks[1];
    expect(copy?.type === 'multiple_choice' && copy.properties.choices.map((c) => c.id)).not.toEqual(mc.properties.choices.map((c) => c.id));
  });
});

describe('updateBlock and endings', () => {
  it('patches a group child', () => {
    const { def, c } = sample();
    const next = updateBlock(def, c.id, (b) => ({ ...b, title: 'Changed' }));
    const g = next.blocks.find((b) => b.type === 'group');
    expect(g?.type === 'group' && g.children[0]?.title).toBe('Changed');
  });

  it('keeps the last ending and cleans references when removing one', () => {
    const { def, a } = sample();
    const second = { ...def.endings[0]!, id: 'e_second', ref: 'second' };
    const two: FormDefinition = {
      ...def,
      endings: [...def.endings, second],
      logic: [{ blockId: a.id, calculations: [], jumps: [], otherwise: { type: 'ending', id: second.id } }],
      endingRules: [{ id: 'j_r', when: { op: 'and', conditions: [{ left: { type: 'variable', name: 'score' }, operator: 'is_answered' }] }, endingId: second.id }],
    };
    const next = removeEnding(two, second.id);
    expect(next.endings).toHaveLength(1);
    expect(next.endingRules).toEqual([]);
    expect(next.logic[0]?.otherwise).toBeNull();
    expect(removeEnding(next, next.endings[0]!.id)).toBe(next);
  });
});

describe('selectionAfterRemoval', () => {
  it('prefers the next sibling, then the previous, then the group', () => {
    const { def, a, e, c, d } = sample();
    expect(selectionAfterRemoval(def, a.id)).toBe(def.blocks[1]?.id);
    expect(selectionAfterRemoval(def, e.id)).toBe(def.blocks[2]?.id);
    expect(selectionAfterRemoval(def, c.id)).toBe(d.id);
  });
});
