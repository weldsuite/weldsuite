import { describe, expect, it } from 'vitest';
import { planRiskCategories, presentRiskCategories } from './risk-categories';

const ids = () => {
  let n = 0;
  return () => `rcat_${++n}`;
};

describe('presentRiskCategories', () => {
  it('shows every built-in and no custom category before anything is saved', () => {
    const presented = presentRiskCategories(null);
    expect(presented.builtIn.map((b) => b.key)).toEqual(['technical', 'schedule', 'budget', 'scope', 'resource', 'compliance', 'external']);
    expect(presented.builtIn.every((b) => !b.hidden)).toBe(true);
    expect(presented.custom).toEqual([]);
  });

  it('flags the hidden built-ins', () => {
    const presented = presentRiskCategories({ hidden: ['budget'], custom: [{ id: 'rcat_1', name: 'Security' }] });
    expect(presented.builtIn.find((b) => b.key === 'budget')?.hidden).toBe(true);
    expect(presented.custom).toEqual([{ id: 'rcat_1', name: 'Security' }]);
  });
});

describe('planRiskCategories', () => {
  it('adds new categories with fresh ids and keeps hidden keys in built-in order', () => {
    const plan = planRiskCategories(null, { hidden: ['external', 'budget', 'budget'], custom: [{ name: 'Security' }, { name: 'Vendor' }] }, ids());
    expect(plan).toEqual({
      ok: true,
      next: { hidden: ['budget', 'external'], custom: [{ id: 'rcat_1', name: 'Security' }, { id: 'rcat_2', name: 'Vendor' }] },
      renames: [],
    });
  });

  it('turns a kept id with a new name into a rename', () => {
    const stored = { hidden: [], custom: [{ id: 'rcat_1', name: 'Vendr' }, { id: 'rcat_2', name: 'Legal' }] };
    const plan = planRiskCategories(stored, { hidden: [], custom: [{ id: 'rcat_1', name: 'Vendor' }, { id: 'rcat_2', name: 'Legal' }] }, ids());
    expect(plan).toMatchObject({ ok: true, renames: [{ from: 'Vendr', to: 'Vendor' }] });
  });

  it('drops a category left out of the body without a rename', () => {
    const stored = { hidden: [], custom: [{ id: 'rcat_1', name: 'Legal' }] };
    expect(planRiskCategories(stored, { hidden: [], custom: [] }, ids())).toEqual({ ok: true, next: { hidden: [], custom: [] }, renames: [] });
  });

  it('refuses an unknown id, a built-in key and a name given twice', () => {
    expect(planRiskCategories(null, { hidden: [], custom: [{ id: 'rcat_9', name: 'X' }] }, ids())).toEqual({ ok: false, message: 'Unknown category id: rcat_9' });
    expect(planRiskCategories(null, { hidden: [], custom: [{ name: 'Technical' }] }, ids())).toEqual({ ok: false, message: '"Technical" is a built-in category' });
    expect(planRiskCategories(null, { hidden: [], custom: [{ name: 'Legal' }, { name: 'legal' }] }, ids())).toEqual({ ok: false, message: 'There are two categories called "legal"' });
  });
});
