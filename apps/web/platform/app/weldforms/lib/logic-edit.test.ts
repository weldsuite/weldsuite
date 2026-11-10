import { describe, expect, it } from 'vitest';
import { createBlankDefinition, createField, type FormDefinition } from '@weldsuite/forms-engine';
import { addCalculation, addEndingRule, addJump, logicOf, moveJump, removeJump, setOtherwise, targetFromKey, targetKey, targetOptions, updateJump } from './logic-edit';

function sample(): { def: FormDefinition; ids: string[] } {
  const fields = ['a', 'b', 'c'].map((ref) => createField('short_text', { ref }));
  return { def: { ...createBlankDefinition(), blocks: fields }, ids: fields.map((f) => f.id) };
}

const group = (id: string) => ({ op: 'and' as const, conditions: [{ left: { type: 'field' as const, id }, operator: 'is_answered' as const }] });

describe('logic edits', () => {
  it('creates an entry on the first rule and drops it when emptied', () => {
    const { def, ids } = sample();
    const withJump = addJump(def, ids[0]!, group(ids[0]!), { type: 'block', id: ids[2]! });
    expect(withJump.logic).toHaveLength(1);
    const jumpId = logicOf(withJump, ids[0]!).jumps[0]!.id;
    expect(removeJump(withJump, ids[0]!, jumpId).logic).toEqual([]);
  });

  it('keeps an entry that only has an otherwise', () => {
    const { def, ids } = sample();
    const next = setOtherwise(def, ids[0]!, { type: 'ending', id: def.endings[0]!.id });
    expect(next.logic).toHaveLength(1);
    expect(setOtherwise(next, ids[0]!, null).logic).toEqual([]);
  });

  it('orders jumps and edits one in place', () => {
    const { def, ids } = sample();
    let next = addJump(def, ids[0]!, group(ids[0]!), { type: 'block', id: ids[1]! });
    next = addJump(next, ids[0]!, group(ids[0]!), { type: 'block', id: ids[2]! });
    const [first, second] = logicOf(next, ids[0]!).jumps;
    next = moveJump(next, ids[0]!, second!.id, -1);
    expect(logicOf(next, ids[0]!).jumps.map((j) => j.id)).toEqual([second!.id, first!.id]);
    next = updateJump(next, ids[0]!, first!.id, (j) => ({ ...j, to: { type: 'ending', id: def.endings[0]!.id } }));
    expect(logicOf(next, ids[0]!).jumps[1]?.to.type).toBe('ending');
    // Moving past the edge changes nothing.
    expect(logicOf(moveJump(next, ids[0]!, second!.id, -1), ids[0]!).jumps.map((j) => j.id)).toEqual([second!.id, first!.id]);
  });

  it('adds calculations and ending rules with generated ids', () => {
    const { def, ids } = sample();
    const withCalc = addCalculation(def, ids[0]!, { when: null, variable: 'score', op: 'add', value: { type: 'constant', value: 2 } });
    expect(logicOf(withCalc, ids[0]!).calculations[0]?.id).toMatch(/^x_/);
    const withRule = addEndingRule(def, group(ids[0]!), def.endings[0]!.id);
    expect(withRule.endingRules[0]?.id).toMatch(/^j_/);
  });
});

describe('targets', () => {
  it('only offers later blocks and the endings', () => {
    const { def, ids } = sample();
    expect(targetOptions(def, 0).map((o) => o.target.id)).toEqual([ids[1], ids[2], def.endings[0]!.id]);
    expect(targetOptions(def, 2).map((o) => o.target.id)).toEqual([def.endings[0]!.id]);
  });

  it('round-trips through keys', () => {
    expect(targetFromKey('next')).toBeNull();
    expect(targetFromKey(targetKey({ type: 'ending', id: 'e_x' }))).toEqual({ type: 'ending', id: 'e_x' });
    expect(targetFromKey(targetKey({ type: 'block', id: 'b_y' }))).toEqual({ type: 'block', id: 'b_y' });
  });
});
