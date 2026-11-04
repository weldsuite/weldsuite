import { describe, expect, it } from 'vitest';
import type { ProjectRequest } from '@weldsuite/app-api-client/domains/flow-portfolio';
import { AMOUNT, amount, lanePosition, needsText, parseNeededSkills, paybackMonths, visibleRequests, weightTotal } from './intake';

describe('intake helpers', () => {
  it('reads needed skills with an optional trailing number of hours', () => {
    expect(parseNeededSkills('Backend 24, PM 8.5, Design, , QA 500')).toEqual([
      { skill: 'Backend', hoursPerWeek: 24 },
      { skill: 'PM', hoursPerWeek: 8.5 },
      { skill: 'Design' },
      { skill: 'QA' },
    ]);
    expect(needsText([{ skill: 'Backend', hoursPerWeek: 24 }, { skill: 'PM' }])).toBe('Backend 24, PM');
  });

  it('computes payback and weight totals', () => {
    expect(paybackMonths('140000.00', '210000.00')).toBe(8);
    expect(paybackMonths(null, '1')).toBeNull();
    expect(weightTotal([{ key: 'a', label: 'A', weight: 60, inverse: false }, { key: 'b', label: 'B', weight: 40, inverse: true }])).toBe(100);
  });

  it('hides rejected and converted requests unless rejected ones are asked for', () => {
    const list = ['new', 'rejected', 'converted', 'approved'].map((status) => ({ status }) as ProjectRequest);
    expect(visibleRequests(list, false).map((r) => r.status)).toEqual(['new', 'approved']);
    expect(visibleRequests(list, true).map((r) => r.status)).toEqual(['new', 'rejected', 'approved']);
  });

  it('places a lane in the range', () => {
    expect(lanePosition('2026-10-01', '2026-12-31', '2026-10-01', '2027-09-30')).toEqual({ left: 0, width: 25.21 });
    const late = lanePosition('2027-09-01', '2028-02-01', '2026-10-01', '2027-09-30');
    expect(late.left + late.width).toBeLessThanOrEqual(100);
  });

  it('accepts plain and decimal amounts but refuses a thousands separator', () => {
    for (const ok of ['', '140000', '140.5', '140,50']) expect(AMOUNT.test(ok)).toBe(true);
    for (const bad of ['140,000', '1.234,56', '12.345', '-5', 'abc', '.5']) expect(AMOUNT.test(bad)).toBe(false);
    expect(amount('')).toBeNull();
    expect(amount('140,5')).toBe(140.5);
    expect(amount('140000')).toBe(140000);
  });
});
