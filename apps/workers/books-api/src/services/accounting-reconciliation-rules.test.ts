import { describe, it, expect } from 'vitest';
import { conditionMatches, findMatchingRule, ruleMatches, type ReconciliationRuleRow } from './accounting-reconciliation-rules';
import type { MatchableTransaction } from './accounting-reconciliation';

const line = (over: Partial<MatchableTransaction> = {}): MatchableTransaction => ({
  id: 'bt_1',
  amount: '-1200.00',
  counterpartyIban: 'NL91 ABNA 0417 1643 00',
  counterpartyName: 'Vastgoed BV',
  reference: 'RF18 5390 0754 7034',
  description: 'Huur kantoor oktober',
  endToEndId: null,
  ...over,
});

const rule = (over: Partial<ReconciliationRuleRow>): ReconciliationRuleRow =>
  ({
    id: 'rr_1',
    name: 'Rent',
    priority: 0,
    isActive: true,
    matchMode: 'all',
    conditions: [],
    actions: { categoryAccountId: 'acc_rent' },
    ...over,
  }) as ReconciliationRuleRow;

describe('conditionMatches', () => {
  it('compares text case-insensitively (the QA rule "huur" against "Huur kantoor oktober")', () => {
    expect(conditionMatches(line(), { field: 'description', operator: 'contains', value: 'huur' })).toBe(true);
    expect(conditionMatches(line(), { field: 'description', operator: 'contains', value: 'HUUR' })).toBe(true);
    expect(conditionMatches(line(), { field: 'description', operator: 'contains', value: 'energie' })).toBe(false);
  });

  it('supports equals, starts_with and ends_with on text, ignoring surrounding spaces', () => {
    expect(conditionMatches(line(), { field: 'counterpartyName', operator: 'equals', value: ' vastgoed bv ' })).toBe(true);
    expect(conditionMatches(line(), { field: 'description', operator: 'starts_with', value: 'huur' })).toBe(true);
    expect(conditionMatches(line(), { field: 'description', operator: 'ends_with', value: 'Oktober' })).toBe(true);
  });

  it('compares IBANs without spaces', () => {
    expect(conditionMatches(line(), { field: 'counterpartyIban', operator: 'equals', value: 'nl91abna0417164300' })).toBe(true);
  });

  it('never matches an empty text value', () => {
    expect(conditionMatches(line(), { field: 'description', operator: 'contains', value: '  ' })).toBe(false);
  });

  it('compares the absolute amount, so money out reads like money in', () => {
    expect(conditionMatches(line(), { field: 'amount', operator: 'equals', value: 1200 })).toBe(true);
    expect(conditionMatches(line(), { field: 'amount', operator: 'greater_than', value: '1000' })).toBe(true);
    expect(conditionMatches(line(), { field: 'amount', operator: 'less_than', value: 1000 })).toBe(false);
    expect(conditionMatches(line(), { field: 'amount', operator: 'between', value: 1500, value2: 1000 })).toBe(true);
    expect(conditionMatches(line(), { field: 'amount', operator: 'between', value: 1000 })).toBe(false);
  });
});

describe('ruleMatches', () => {
  const conditions: ReconciliationRuleRow['conditions'] = [
    { field: 'description', operator: 'contains', value: 'huur' },
    { field: 'amount', operator: 'less_than', value: 100 },
  ];

  it('needs every condition by default and one with matchMode any', () => {
    expect(ruleMatches(line(), rule({ conditions }))).toBe(false);
    expect(ruleMatches(line(), rule({ conditions, matchMode: 'any' }))).toBe(true);
  });

  it('never matches a rule without conditions', () => {
    expect(ruleMatches(line(), rule({ conditions: [] }))).toBe(false);
  });
});

describe('findMatchingRule', () => {
  it('returns the first matching rule in the given (priority) order', () => {
    const rules = [
      rule({ id: 'rr_energy', conditions: [{ field: 'description', operator: 'contains', value: 'energie' }] }),
      rule({ id: 'rr_rent', conditions: [{ field: 'description', operator: 'contains', value: 'huur' }] }),
      rule({ id: 'rr_any', conditions: [{ field: 'amount', operator: 'greater_than', value: 0 }] }),
    ];
    expect(findMatchingRule(line(), rules)?.id).toBe('rr_rent');
    expect(findMatchingRule(line({ description: 'Iets anders' }), rules)?.id).toBe('rr_any');
  });
});
