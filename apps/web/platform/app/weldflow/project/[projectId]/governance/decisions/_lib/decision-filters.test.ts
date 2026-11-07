import { describe, expect, it } from 'vitest';
import type { Decision } from '@weldsuite/app-api-client/domains/project-governance';
import {
  FILTER_FIELDS,
  NO_DECIDER,
  applyDecisionFilters,
  deciderIdsOf,
  deciderOf,
} from './decision-filters';

let counter = 0;

function decision(overrides: Partial<Decision> = {}): Decision {
  counter += 1;
  return {
    id: `dec_${counter}`,
    projectId: 'prj_1',
    number: counter,
    code: `DEC-${counter}`,
    title: `Decision ${counter}`,
    status: 'proposed',
    context: null,
    options: [],
    consequences: [],
    deciderId: null,
    decidedBy: null,
    decidedAt: null,
    decisionDueAt: null,
    supersededById: null,
    createdBy: 'user_1',
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
    deletedAt: null,
    ...overrides,
  };
}

const filter = (field: string, operator: string, value: string) => ({ id: `${field}-${operator}-${value}`, field, operator, value });

describe('deciderOf', () => {
  it('names who has to decide while proposed and who decided afterwards', () => {
    expect(deciderOf(decision({ status: 'proposed', deciderId: 'user_a', decidedBy: 'user_b' }))).toBe('user_a');
    expect(deciderOf(decision({ status: 'decided', deciderId: 'user_a', decidedBy: 'user_b' }))).toBe('user_b');
    expect(deciderOf(decision({ status: 'superseded', decidedBy: null }))).toBeNull();
  });
});

describe('deciderIdsOf', () => {
  it('lists each person once and skips decisions with nobody named', () => {
    const rows = [
      decision({ deciderId: 'user_a' }),
      decision({ deciderId: 'user_a' }),
      decision({ status: 'decided', decidedBy: 'user_b' }),
      decision(),
    ];
    expect(deciderIdsOf(rows)).toEqual(['user_a', 'user_b']);
  });
});

describe('applyDecisionFilters', () => {
  const rows = [
    decision({ code: 'DEC-1', title: 'Keep the legacy shop', context: 'Migration risk', status: 'decided', decidedBy: 'user_a' }),
    decision({ code: 'DEC-2', title: 'Pick a payment provider', status: 'proposed', deciderId: 'user_b' }),
    decision({ code: 'DEC-3', title: 'Old hosting plan', status: 'superseded', decidedBy: 'user_a' }),
    decision({ code: 'DEC-4', title: 'Name the product', status: 'proposed' }),
  ];

  it('returns every decision when nothing narrows the list', () => {
    expect(applyDecisionFilters(rows, '', [])).toHaveLength(4);
  });

  it('searches the code, the title and the context, ignoring case', () => {
    expect(applyDecisionFilters(rows, 'dec-2', []).map((d) => d.code)).toEqual(['DEC-2']);
    expect(applyDecisionFilters(rows, 'LEGACY', []).map((d) => d.code)).toEqual(['DEC-1']);
    expect(applyDecisionFilters(rows, 'migration', []).map((d) => d.code)).toEqual(['DEC-1']);
  });

  it('filters by status with is and is not', () => {
    expect(applyDecisionFilters(rows, '', [filter(FILTER_FIELDS.status, 'is', 'proposed')]).map((d) => d.code)).toEqual(['DEC-2', 'DEC-4']);
    expect(applyDecisionFilters(rows, '', [filter(FILTER_FIELDS.status, 'is not', 'proposed')]).map((d) => d.code)).toEqual(['DEC-1', 'DEC-3']);
  });

  it('filters by decider, with a value for decisions nobody is named on', () => {
    expect(applyDecisionFilters(rows, '', [filter(FILTER_FIELDS.decider, 'is', 'user_a')]).map((d) => d.code)).toEqual(['DEC-1', 'DEC-3']);
    expect(applyDecisionFilters(rows, '', [filter(FILTER_FIELDS.decider, 'is', NO_DECIDER)]).map((d) => d.code)).toEqual(['DEC-4']);
  });

  it('applies the search and every filter together, and ignores a filter that is not complete', () => {
    const narrowed = applyDecisionFilters(rows, 'plan', [
      filter(FILTER_FIELDS.status, 'is', 'superseded'),
      filter(FILTER_FIELDS.decider, '', ''),
    ]);
    expect(narrowed.map((d) => d.code)).toEqual(['DEC-3']);
  });
});
