import { describe, expect, it } from 'vitest';
import type { MemberCapacity } from '@weldsuite/app-api-client/domains/flow-portfolio';
import { addDays, allSkills, bandOf, groupBySkill, percentOf, rangeOf, splitSkills } from './capacity';

const member = (memberId: string, skills: string[], hours: number[], weeklyHours = 40): MemberCapacity => ({
  memberId,
  weeklyHours,
  skills,
  hasProfile: true,
  cells: hours.map((h) => ({ hours: h, tentativeHours: 0, percent: (h / weeklyHours) * 100, band: 'ok' })),
  projects: [],
});

describe('capacity helpers', () => {
  it('bands a load like the API', () => {
    expect([bandOf(0, 0), bandOf(10, 25), bandOf(20, 50), bandOf(32, 80), bandOf(41, 101), bandOf(49, 121), bandOf(4, null)]).toEqual([
      'none',
      'under',
      'ok',
      'full',
      'over',
      'critical',
      'critical',
    ]);
  });

  it('computes ranges of whole weeks', () => {
    expect(addDays('2026-11-30', 1)).toBe('2026-12-01');
    expect(rangeOf('2026-11-02', 2)).toEqual({ from: '2026-11-02', to: '2026-11-15' });
  });

  it('reads skills typed as text', () => {
    expect(splitSkills(' Backend, backend ,QA,, ')).toEqual(['Backend', 'QA']);
  });

  it('groups people by skill, with those without one last, and sums their weeks', () => {
    const people = [member('a', ['Backend', 'QA'], [20, 40]), member('b', ['backend'], [10, 10], 20), member('c', [], [5, 5])];
    const groups = groupBySkill(people, 2);
    expect(groups.map((g) => [g.key, g.members.length])).toEqual([
      ['backend', 2],
      ['qa', 1],
      ['', 1],
    ]);
    expect(groups[0].hours).toEqual([30, 50]);
    expect(groups[0].capacity).toEqual([60, 60]);
    expect(allSkills(people)).toEqual(['Backend', 'QA']);
    expect(percentOf(30, 60)).toBe(50);
    expect(percentOf(1, 0)).toBeNull();
  });
});
