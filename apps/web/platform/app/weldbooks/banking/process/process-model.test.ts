import { describe, expect, it } from 'vitest';
import type { BankLine, MatchSuggestion } from '@/lib/api/domains/weldbooks-banking';
import {
  bestSuggestion,
  directionOf,
  mergeQueue,
  nextLineId,
  ownAccountForLine,
  stepLineId,
  transferTargets,
} from './process-model';

const line = (id: string, amount = '10.00'): BankLine =>
  ({ id, amount, bankAccountId: 'ba_1', date: '2026-11-25', status: 'unreconciled' }) as BankLine;

const suggestion = (id: string, confidence: number): MatchSuggestion => ({
  type: 'invoice',
  id,
  number: id,
  contactName: null,
  amount: '10.00',
  confidence,
  reasons: [],
});

describe('bestSuggestion', () => {
  it('takes the most confident one that is sure', () => {
    expect(bestSuggestion([suggestion('a', 0.7), suggestion('b', 0.95), suggestion('c', 0.8)])?.id).toBe('b');
  });

  it('offers nothing when none is sure', () => {
    expect(bestSuggestion([suggestion('a', 0.3), suggestion('b', 0.59)])).toBeNull();
    expect(bestSuggestion([])).toBeNull();
  });
});

describe('queue', () => {
  it('puts a processed line back where it was', () => {
    const merged = mergeQueue([line('a'), line('c')], [{ line: line('b'), index: 1 }]);
    expect(merged.map((l) => l.id)).toEqual(['a', 'b', 'c']);
  });

  it('does not duplicate a retained line the server still lists', () => {
    const merged = mergeQueue([line('a'), line('b')], [{ line: line('b'), index: 1 }]);
    expect(merged.map((l) => l.id)).toEqual(['a', 'b']);
  });

  it('opens the next line that is not done, wrapping around', () => {
    const queue = [line('a'), line('b'), line('c')];
    expect(nextLineId(queue, new Set(['a', 'b']), 'a')).toBe('c');
    expect(nextLineId(queue, new Set(['b', 'c']), 'c')).toBe('a');
    expect(nextLineId(queue, new Set(['a', 'b', 'c']), 'a')).toBeNull();
    expect(nextLineId([], new Set(), null)).toBeNull();
  });

  it('moves one step with J and K and stays inside the queue', () => {
    const queue = [line('a'), line('b'), line('c')];
    expect(stepLineId(queue, 'a', 1)).toBe('b');
    expect(stepLineId(queue, 'c', 1)).toBe('c');
    expect(stepLineId(queue, 'a', -1)).toBe('a');
    expect(stepLineId(queue, null, 1)).toBe('a');
    expect(stepLineId(queue, null, -1)).toBe('c');
  });
});

describe('own accounts and direction', () => {
  it('reads the direction from the sign', () => {
    expect(directionOf(line('a', '-5.00'))).toBe('out');
    expect(directionOf(line('a', '5.00'))).toBe('in');
  });

  it('finds another own account by IBAN, ignoring spaces and case', () => {
    const accounts = [
      { id: 'ba_1', iban: 'NL91ABNA0417164300' },
      { id: 'ba_2', iban: 'NL55 RABO 0301 9013 22' },
    ];
    const l = { bankAccountId: 'ba_1', counterpartyIban: 'nl55rabo0301901322' };
    expect(ownAccountForLine(l, accounts)?.id).toBe('ba_2');
    expect(ownAccountForLine({ bankAccountId: 'ba_1', counterpartyIban: 'NL91ABNA0417164300' }, accounts)).toBeNull();
    expect(ownAccountForLine({ bankAccountId: 'ba_1', counterpartyIban: null }, accounts)).toBeNull();
  });
});

describe('transfer targets', () => {
  const accounts = [
    { id: 'ba_1', name: 'Business', iban: 'NL91ABNA0417164300', accountType: 'checking' },
    { id: 'ba_2', name: 'Savings', iban: 'NL02ABNA0123456789', accountType: 'savings' },
    { id: 'ba_mollie', name: 'Mollie', iban: null, accountType: 'payment_provider' },
  ];
  const onLine = (overrides: Partial<BankLine>) =>
    ({ id: 'bl_1', bankAccountId: 'ba_1', amount: '-10.00', date: '2026-11-25', status: 'unreconciled', ...overrides }) as BankLine;
  const ids = (list: ReadonlyArray<{ id: string }>) => list.map((account) => account.id);

  it("offers the other bank accounts, never the line's own and not the Mollie account", () => {
    expect(ids(transferTargets(onLine({ counterpartyName: 'Savings account' }), accounts))).toEqual(['ba_2']);
    expect(ids(transferTargets(onLine({}), accounts))).toEqual(['ba_2']);
  });

  it('offers the Mollie account for a payout line, whose counterparty is Mollie', () => {
    expect(ids(transferTargets(onLine({ counterpartyName: 'Mollie Payments' }), accounts))).toEqual(['ba_2', 'ba_mollie']);
    expect(ids(transferTargets(onLine({ counterpartyName: 'Molliesque Bakery' }), accounts))).toEqual(['ba_2']);
  });

  it('offers real banks, not Mollie itself, for a line that sits on the Mollie account', () => {
    expect(ids(transferTargets(onLine({ bankAccountId: 'ba_mollie', counterpartyName: 'Mollie' }), accounts))).toEqual(['ba_1', 'ba_2']);
  });

  it('does not preselect the Mollie account from a counterparty IBAN unless the line is a Mollie payout', () => {
    const withIban = [...accounts.slice(0, 2), { id: 'ba_mollie', name: 'Mollie', iban: 'NL00MOLL0000000001', accountType: 'payment_provider' }];
    expect(ownAccountForLine(onLine({ counterpartyIban: 'NL00MOLL0000000001' }), withIban)).toBeNull();
    expect(ownAccountForLine(onLine({ counterpartyIban: 'NL00MOLL0000000001', counterpartyName: 'Mollie' }), withIban)?.id).toBe('ba_mollie');
    expect(ownAccountForLine(onLine({ counterpartyIban: 'nl02 abna 0123 4567 89' }), withIban)?.id).toBe('ba_2');
  });
});
