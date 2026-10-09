import { describe, expect, it } from 'vitest';
import type { UndepositedPayment, UsBankAccount } from '@/lib/api/domains/weldbooks-banking';
import {
  buildDepositInput,
  computeDepositTotals,
  depositBankAccounts,
  depositProblems,
  parseMoneyInput,
  sumAmounts,
  sumUndeposited,
  type OtherLineDraft,
} from './deposit-math';

const payment = (paymentId: string, amount: number): UndepositedPayment => ({
  paymentId,
  date: '2026-01-05',
  paymentMethod: 'check',
  checkNumber: '1001',
  reference: null,
  currency: 'USD',
  paymentAmount: amount.toFixed(2),
  amount,
  contactId: 'con_1',
  contactName: 'Acme',
  journalEntryId: 'je_1',
});

const other = (amount: string, accountId = 'acc_1'): OtherLineDraft => ({ key: amount, accountId, amount, description: '' });

describe('parseMoneyInput', () => {
  it('reads typed amounts with thousands separators, signs and parentheses', () => {
    expect(parseMoneyInput('1,234.56')).toBe(1234.56);
    expect(parseMoneyInput('$20')).toBe(20);
    expect(parseMoneyInput('-20.5')).toBe(-20.5);
    expect(parseMoneyInput('(20.00)')).toBe(-20);
    expect(parseMoneyInput('.5')).toBe(0.5);
  });

  it('rejects text, empty input and sub-cent precision', () => {
    expect(parseMoneyInput('')).toBeNull();
    expect(parseMoneyInput('-')).toBeNull();
    expect(parseMoneyInput('abc')).toBeNull();
    expect(parseMoneyInput('1.234')).toBeNull();
  });
});

describe('deposit totals', () => {
  it('adds amounts exactly to the cent', () => {
    expect(sumAmounts([0.1, 0.2])).toBe(0.3);
    expect(sumUndeposited([payment('a', 100.1), payment('b', 200.2), payment('c', 0.07)])).toBe(300.37);
  });

  it('adds the selected payments and the other lines, with cash back reducing the deposit', () => {
    const totals = computeDepositTotals([payment('a', 1200), payment('b', 350.5)], [other('25'), other('-100')]);
    expect(totals).toEqual({ paymentsTotal: 1550.5, otherTotal: -75, total: 1475.5 });
  });

  it('counts an unreadable other line as zero until it is fixed', () => {
    expect(computeDepositTotals([payment('a', 10)], [other('abc')]).total).toBe(10);
  });

  it('is zero with nothing selected', () => {
    expect(computeDepositTotals([], [])).toEqual({ paymentsTotal: 0, otherTotal: 0, total: 0 });
  });
});

describe('depositProblems', () => {
  const base = { bankAccountId: 'ba_1', date: '2026-01-06', selectedCount: 2, otherLines: [] as OtherLineDraft[] };
  const totals = (total: number) => ({ paymentsTotal: total, otherTotal: 0, total });

  it('accepts a complete deposit', () => {
    expect(depositProblems({ ...base, totals: totals(100) })).toEqual([]);
  });

  it('flags a missing bank account, a bad date and an empty deposit', () => {
    expect(depositProblems({ ...base, bankAccountId: '', totals: totals(100) })).toEqual(['bankAccount']);
    expect(depositProblems({ ...base, date: '', totals: totals(100) })).toEqual(['date']);
    expect(depositProblems({ ...base, selectedCount: 0, totals: totals(0) })).toEqual(['nothing']);
  });

  it('flags other lines without an account or a usable amount', () => {
    const lines = [other('0'), other('abc', '')];
    expect(depositProblems({ ...base, otherLines: lines, totals: totals(100) })).toEqual(['otherLineAccount', 'otherLineAmount']);
  });

  it('refuses a total that is not greater than zero', () => {
    expect(depositProblems({ ...base, selectedCount: 1, otherLines: [other('-100')], totals: totals(0) })).toEqual(['total']);
  });
});

describe('buildDepositInput', () => {
  it('builds the request with trimmed memo and other lines', () => {
    const input = buildDepositInput({
      bankAccountId: 'ba_1',
      date: '2026-01-06',
      memo: '  January checks ',
      paymentIds: ['pay_1', 'pay_2'],
      otherLines: [{ key: 'k', accountId: 'acc_9', amount: '-40', description: ' cash back ' }],
    });
    expect(input).toEqual({
      bankAccountId: 'ba_1',
      date: '2026-01-06',
      paymentIds: ['pay_1', 'pay_2'],
      otherLines: [{ accountId: 'acc_9', amount: -40, description: 'cash back' }],
      memo: 'January checks',
    });
  });

  it('leaves out empty other lines and memo', () => {
    const input = buildDepositInput({ bankAccountId: 'ba_1', date: '2026-01-06', memo: ' ', paymentIds: ['pay_1'], otherLines: [] });
    expect(input).toEqual({ bankAccountId: 'ba_1', date: '2026-01-06', paymentIds: ['pay_1'] });
  });
});

describe('depositBankAccounts', () => {
  it('offers checking, savings and money market accounts, not cards or lines of credit', () => {
    const account = (id: string, accountType: UsBankAccount['accountType'], isActive = true) =>
      ({ id, accountType, isActive }) as UsBankAccount;
    const result = depositBankAccounts([
      account('a', 'checking'),
      account('b', 'credit_card'),
      account('c', 'line_of_credit'),
      account('d', 'savings', false),
      account('e', null),
      account('f', 'money_market'),
    ]);
    expect(result.map((a) => a.id)).toEqual(['a', 'e', 'f']);
  });
});
