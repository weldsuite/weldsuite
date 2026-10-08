import { describe, expect, it } from 'vitest';
import type { ReconciliationHistoryRow, ReconciliationLine } from '@/lib/api/domains/weldbooks-banking';
import {
  adjustmentDirection,
  allTicked,
  computeStatementBalances,
  differenceIsZero,
  filterLines,
  inProgressOf,
  latestCompleted,
  parseStatementBalance,
  sameIds,
  setAllTicked,
  tickedOnOrBefore,
} from './reconciliation-math';

function line(id: string, amount: number, extra: Partial<ReconciliationLine> = {}): ReconciliationLine {
  return {
    id,
    journalEntryId: `je_${id}`,
    entryNumber: `JE-${id}`,
    date: '2026-01-10',
    description: `Line ${id}`,
    amount,
    contactId: null,
    contactName: null,
    reference: null,
    sourceType: null,
    document: null,
    cleared: false,
    ...extra,
  };
}

const deposits = [line('d1', 1000), line('d2', 250.1)];
const checks = [line('c1', 300.05), line('c2', 100)];

describe('computeStatementBalances', () => {
  it('adds ticked deposits and subtracts ticked checks on a bank account', () => {
    const balances = computeStatementBalances({
      beginningBalance: 500,
      statementEndingBalance: 1350.05,
      accountKind: 'bank',
      inflows: deposits,
      outflows: checks,
      clearedIds: new Set(['d1', 'd2', 'c1']),
    });
    expect(balances.clearedInflows).toEqual({ count: 2, total: 1250.1 });
    expect(balances.clearedOutflows).toEqual({ count: 1, total: 300.05 });
    expect(balances.clearedBalance).toBe(1450.05);
    expect(balances.difference).toBe(-100);
    expect(differenceIsZero(balances)).toBe(false);
  });

  it('reaches a zero difference when the ticked lines explain the statement', () => {
    const balances = computeStatementBalances({
      beginningBalance: 500,
      statementEndingBalance: 1350.05,
      accountKind: 'bank',
      inflows: deposits,
      outflows: checks,
      clearedIds: new Set(['d1', 'd2', 'c1', 'c2']),
    });
    expect(balances.clearedBalance).toBe(1350.05);
    expect(balances.difference).toBe(0);
    expect(differenceIsZero(balances)).toBe(true);
  });

  it('flips the signs on a credit card, whose balance is what is owed', () => {
    // Owed 400 at the start; a 300.05 charge raises it, a 1000 payment lowers it.
    const balances = computeStatementBalances({
      beginningBalance: 400,
      statementEndingBalance: -299.95,
      accountKind: 'credit_card',
      inflows: [line('p1', 1000)],
      outflows: [line('ch1', 300.05)],
      clearedIds: new Set(['p1', 'ch1']),
    });
    expect(balances.clearedBalance).toBe(-299.95);
    expect(balances.difference).toBe(0);
  });

  it('counts only ticked lines and sums cents exactly', () => {
    const balances = computeStatementBalances({
      beginningBalance: 0,
      statementEndingBalance: 0.3,
      accountKind: 'bank',
      inflows: [line('a', 0.1), line('b', 0.2)],
      outflows: [],
      clearedIds: new Set(['a', 'b', 'not-on-the-sheet']),
    });
    expect(balances.clearedBalance).toBe(0.3);
    expect(differenceIsZero(balances)).toBe(true);
  });

  it('treats a one-cent difference as not finished', () => {
    const balances = computeStatementBalances({
      beginningBalance: 0,
      statementEndingBalance: 100.01,
      accountKind: 'bank',
      inflows: [line('a', 100)],
      outflows: [],
      clearedIds: new Set(['a']),
    });
    expect(balances.difference).toBe(0.01);
    expect(differenceIsZero(balances)).toBe(false);
  });
});

describe('filterLines and ticking', () => {
  const lines = [
    line('1', 100, { description: 'Acme Corp invoice', contactName: 'Acme' }),
    line('2', 250.5, { description: 'Deposit', document: { type: 'payment', id: 'pay_1', number: null, checkNumber: '1042', method: 'check' } }),
    line('3', 75, { description: 'Coffee' }),
  ];

  it('searches description, contact, check number and amount', () => {
    const ticked = new Set<string>();
    const ids = (query: string) => filterLines(lines, { query, show: 'all', clearedIds: ticked }).map((l) => l.id);
    expect(ids('acme')).toEqual(['1']);
    expect(ids('1042')).toEqual(['2']);
    expect(ids('250.50')).toEqual(['2']);
    expect(ids('')).toEqual(['1', '2', '3']);
  });

  it('filters by cleared state', () => {
    const ticked = new Set(['2']);
    expect(filterLines(lines, { query: '', show: 'cleared', clearedIds: ticked }).map((l) => l.id)).toEqual(['2']);
    expect(filterLines(lines, { query: '', show: 'uncleared', clearedIds: ticked }).map((l) => l.id)).toEqual(['1', '3']);
  });

  it('ticks and clears every visible line without touching the others', () => {
    const start = new Set(['x']);
    const all = setAllTicked(start, lines, true);
    expect([...all].sort()).toEqual(['1', '2', '3', 'x']);
    expect(allTicked(all, lines)).toBe(true);
    const cleared = setAllTicked(all, lines.slice(0, 2), false);
    expect([...cleared].sort()).toEqual(['3', 'x']);
    expect(allTicked(cleared, lines)).toBe(false);
    expect(allTicked(new Set(), [])).toBe(false);
    expect(start.size).toBe(1);
  });

  it('compares id sets', () => {
    expect(sameIds(new Set(['a', 'b']), new Set(['b', 'a']))).toBe(true);
    expect(sameIds(new Set(['a']), new Set(['a', 'b']))).toBe(false);
    expect(sameIds(new Set(['a', 'c']), new Set(['a', 'b']))).toBe(false);
  });

  it('unticks lines dated after a statement date that moved back', () => {
    const dated = [line('a', 1, { date: '2026-01-31' }), line('b', 1, { date: '2026-02-03' }), line('c', 1, { date: '2026-02-20' })];
    expect(tickedOnOrBefore(dated, new Set(['a', 'b', 'c']), '2026-02-03')).toEqual(['a', 'b']);
  });
});

describe('history helpers', () => {
  const row = (id: string, status: ReconciliationHistoryRow['status'], statementDate: string, bankAccountId = 'ba_1'): ReconciliationHistoryRow => ({
    id,
    bankAccountId,
    ledgerAccountId: 'acc_1',
    statementDate,
    beginningBalance: '0.00',
    statementEndingBalance: '0.00',
    clearedBalance: null,
    difference: null,
    status,
    adjustmentJournalEntryId: null,
    completedAt: null,
    completedBy: null,
    undoneAt: null,
    createdAt: `${statementDate}T00:00:00Z`,
    hasReport: true,
  });

  it('finds the latest completed reconciliation, the only one that can be undone', () => {
    const rows = [
      row('r1', 'completed', '2026-01-31'),
      row('r2', 'completed', '2026-02-28'),
      row('r3', 'undone', '2026-03-31'),
      row('r4', 'completed', '2026-04-30', 'ba_2'),
    ];
    expect(latestCompleted(rows, 'ba_1')?.id).toBe('r2');
    expect(latestCompleted(rows, 'ba_2')?.id).toBe('r4');
    expect(latestCompleted(rows, 'ba_3')).toBeUndefined();
  });

  it('finds the reconciliation still open', () => {
    const rows = [row('r1', 'completed', '2026-01-31'), row('r2', 'in_progress', '2026-02-28')];
    expect(inProgressOf(rows, 'ba_1')?.id).toBe('r2');
    expect(inProgressOf(rows, 'ba_2')).toBeUndefined();
  });
});

describe('statement balances and adjustments', () => {
  it('parses typed statement balances', () => {
    expect(parseStatementBalance('1,234.56')).toBe(1234.56);
    expect(parseStatementBalance('-20')).toBe(-20);
    expect(parseStatementBalance('$ 7.5')).toBe(7.5);
    expect(parseStatementBalance('')).toBeNull();
    expect(parseStatementBalance('12.345')).toBeNull();
    expect(parseStatementBalance('abc')).toBeNull();
  });

  it('describes which way an adjustment goes', () => {
    expect(adjustmentDirection('bank', 5)).toBe('bankHoldsMore');
    expect(adjustmentDirection('bank', -5)).toBe('bankHoldsLess');
    expect(adjustmentDirection('credit_card', 5)).toBe('cardOwesMore');
    expect(adjustmentDirection('credit_card', -5)).toBe('cardOwesLess');
  });
});
