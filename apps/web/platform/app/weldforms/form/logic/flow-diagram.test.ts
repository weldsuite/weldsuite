import { describe, expect, it } from 'vitest';
import { createBlankDefinition, createField, createPageBreak, type FormDefinition } from '@weldsuite/forms-engine';
import { layoutFlow } from './flow-diagram';

describe('layoutFlow', () => {
  const a = createField('short_text', { ref: 'a', title: 'A' });
  const b = createField('short_text', { ref: 'b', title: 'B' });
  const c = createField('short_text', { ref: 'c', title: 'C' });
  const base = createBlankDefinition();
  const second = { ...base.endings[0]!, id: 'e_two', ref: 'two' };

  it('lays blocks out in order (page breaks left out) and endings in a second column', () => {
    const def: FormDefinition = { ...base, blocks: [a, createPageBreak({ ref: 'pb' }), b], endings: [...base.endings, second] };
    const { nodes } = layoutFlow(def, { untitled: 'Untitled' });
    const blocks = nodes.filter((n) => n.kind === 'block');
    const endings = nodes.filter((n) => n.kind === 'ending');
    expect(blocks.map((n) => n.id)).toEqual([a.id, b.id]);
    expect(blocks[1]!.y).toBeGreaterThan(blocks[0]!.y);
    expect(blocks.map((n) => n.number)).toEqual([1, 2]);
    expect(endings).toHaveLength(2);
    expect(endings[0]!.x).toBeGreaterThan(blocks[0]!.x);
  });

  it('draws jumps, otherwise and the final routes to endings', () => {
    const def: FormDefinition = {
      ...base,
      blocks: [a, b, c],
      endings: [...base.endings, second],
      logic: [
        {
          blockId: a.id,
          calculations: [],
          jumps: [{ id: 'j_1', when: { op: 'and', conditions: [{ left: { type: 'field', id: a.id }, operator: 'is_answered' }] }, to: { type: 'block', id: c.id } }],
          otherwise: { type: 'ending', id: second.id },
        },
      ],
      endingRules: [{ id: 'j_r', when: { op: 'and', conditions: [{ left: { type: 'variable', name: 'score' }, operator: 'is_answered' }] }, endingId: second.id }],
    };
    const { edges, nodes } = layoutFlow(def, { untitled: 'Untitled' });
    expect(edges).toEqual([
      { from: a.id, to: c.id, kind: 'jump' },
      { from: a.id, to: second.id, kind: 'otherwise' },
      { from: c.id, to: second.id, kind: 'ending-rule' },
      { from: c.id, to: base.endings[0]!.id, kind: 'default' },
    ]);
    expect(nodes.find((n) => n.id === a.id)?.hasLogic).toBe(true);
    expect(nodes.find((n) => n.id === b.id)?.hasLogic).toBe(false);
  });

  it('survives an empty form', () => {
    const { nodes, height } = layoutFlow(base, { untitled: 'Untitled' });
    expect(nodes).toHaveLength(1);
    expect(height).toBeGreaterThan(0);
  });
});
