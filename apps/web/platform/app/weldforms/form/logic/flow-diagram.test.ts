import { describe, expect, it } from 'vitest';
import { createBlankDefinition, createField, createPageBreak, type FormDefinition } from '@weldsuite/forms-engine';
import { START_ID, layoutFlow } from './flow-diagram';

describe('layoutFlow', () => {
  const a = createField('short_text', { ref: 'a', title: 'A' });
  const b = createField('short_text', { ref: 'b', title: 'B' });
  const c = createField('short_text', { ref: 'c', title: 'C' });
  const base = createBlankDefinition();
  const second = { ...base.endings[0]!, id: 'e_two', ref: 'two' };

  it('stacks a start card and the blocks (page breaks left out), with the endings in a row under them', () => {
    const def: FormDefinition = { ...base, blocks: [a, createPageBreak({ ref: 'pb' }), b], endings: [...base.endings, second] };
    const { nodes } = layoutFlow(def, { untitled: 'Untitled' });
    const start = nodes.find((n) => n.kind === 'start')!;
    const blocks = nodes.filter((n) => n.kind === 'block');
    const endings = nodes.filter((n) => n.kind === 'ending');
    expect(start.id).toBe(START_ID);
    expect(blocks.map((n) => n.id)).toEqual([a.id, b.id]);
    expect(blocks.map((n) => n.number)).toEqual([1, 2]);
    expect(blocks[0]!.y).toBeGreaterThan(start.y);
    expect(blocks[1]!.y).toBeGreaterThan(blocks[0]!.y);
    expect(blocks.every((n) => n.x === start.x)).toBe(true);
    expect(endings).toHaveLength(2);
    expect(endings[0]!.y).toBe(endings[1]!.y);
    expect(endings[0]!.y).toBeGreaterThan(blocks[1]!.y);
    expect(endings[1]!.x).toBeGreaterThan(endings[0]!.x);
  });

  it('draws the order, jumps, otherwise and one route per ending', () => {
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
      endingRules: [
        { id: 'j_r', when: { op: 'and', conditions: [{ left: { type: 'variable', name: 'score' }, operator: 'is_answered' }] }, endingId: second.id },
        { id: 'j_s', when: { op: 'and', conditions: [{ left: { type: 'variable', name: 'score' }, operator: 'is_answered' }] }, endingId: second.id },
      ],
    };
    const { edges, nodes } = layoutFlow(def, { untitled: 'Untitled' });
    expect(edges).toEqual([
      { from: START_ID, to: a.id, kind: 'sequence' },
      { from: a.id, to: b.id, kind: 'sequence' },
      { from: b.id, to: c.id, kind: 'sequence' },
      { from: a.id, to: c.id, kind: 'jump' },
      { from: a.id, to: second.id, kind: 'otherwise' },
      { from: c.id, to: base.endings[0]!.id, kind: 'default' },
      { from: c.id, to: second.id, kind: 'ending-rule' },
    ]);
    expect(nodes.find((n) => n.id === a.id)?.rules).toBe(2);
    expect(nodes.find((n) => n.id === b.id)?.rules).toBe(0);
  });

  it('survives an empty form', () => {
    const { nodes, edges } = layoutFlow(base, { untitled: 'Untitled' });
    expect(nodes.map((n) => n.kind)).toEqual(['start', 'ending']);
    expect(edges).toEqual([{ from: START_ID, to: base.endings[0]!.id, kind: 'default' }]);
  });
});
