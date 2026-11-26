import { describe, expect, it } from 'vitest';
import { defaultShare, fitToTransaction, fromCents, planMatch, toCents } from './bank-link-math';

const invoice = (id: string, amount: string, openAmount: string) => ({ id, type: 'invoice' as const, amount, openAmount });

describe('toCents / fromCents', () => {
  it('reads a dot or a comma and keeps cents whole', () => {
    expect(toCents('12.34')).toBe(1234);
    expect(toCents('12,3')).toBe(1230);
    expect(toCents(' 1 000.10 ')).toBe(100010);
    expect(toCents('-0.50')).toBe(-50);
    expect(toCents(0.1 + 0.2)).toBe(30);
  });

  it('refuses anything that is not an amount', () => {
    expect(toCents('12.345')).toBeNaN();
    expect(toCents('abc')).toBeNaN();
    expect(toCents('')).toBeNaN();
  });

  it('writes the API amount text', () => {
    expect(fromCents(1234)).toBe('12.34');
    expect(fromCents(5)).toBe('0.05');
    expect(fromCents(-50)).toBe('-0.50');
  });
});

describe('fitToTransaction', () => {
  it('pays the first documents in full and the last partly', () => {
    expect(fitToTransaction(12000, [10000, 5000, 3000])).toEqual([10000, 2000, 0]);
  });
});

describe('defaultShare', () => {
  it('takes what is left of the transaction, or the open amount once nothing is left', () => {
    expect(defaultShare(15000, 10000, 8000)).toBe(5000);
    expect(defaultShare(15000, 0, 8000)).toBe(8000);
    expect(defaultShare(15000, 15000, 8000)).toBe(8000);
  });
});

describe('planMatch', () => {
  it('sends the documents as they are when they add up to the transaction', () => {
    const plan = planMatch({
      transactionAmount: '150.00',
      shares: [invoice('a', '100', '100.00'), invoice('b', '50,00', '50.00')],
      choice: 'leave',
    });
    expect(plan.problem).toBeNull();
    expect(plan.gapCents).toBe(0);
    expect(plan.body).toEqual({
      documents: [
        { type: 'invoice', id: 'a', amount: '100.00' },
        { type: 'invoice', id: 'b', amount: '50.00' },
      ],
    });
  });

  it('leaves the last document partly open when the documents take more', () => {
    const plan = planMatch({
      transactionAmount: '-149.50',
      shares: [invoice('a', '100.00', '100.00'), invoice('b', '50.00', '50.00')],
      choice: 'leave',
    });
    expect(plan.gapCents).toBe(50);
    expect(plan.fitted).toEqual({ a: 10000, b: 4950 });
    expect(plan.body?.documents.map((d) => d.amount)).toEqual(['100.00', '49.50']);
    expect(plan.body?.differenceAccountId).toBeUndefined();
  });

  it('books the gap to an account when asked, and needs the account', () => {
    const shares = [invoice('a', '100.00', '100.00'), invoice('b', '50.00', '50.00')];
    expect(planMatch({ transactionAmount: '149.50', shares, choice: 'account' }).problem).toBe('needsAccount');
    const plan = planMatch({ transactionAmount: '149.50', shares, choice: 'account', accountId: 'acc_costs', description: 'Bank costs' });
    expect(plan.body).toEqual({
      documents: [
        { type: 'invoice', id: 'a', amount: '100.00' },
        { type: 'invoice', id: 'b', amount: '50.00' },
      ],
      differenceAccountId: 'acc_costs',
      differenceDescription: 'Bank costs',
    });
  });

  it('keeps extra money as credit unless an account takes it', () => {
    const shares = [invoice('a', '100.00', '100.00')];
    const credit = planMatch({ transactionAmount: '120.00', shares, choice: 'leave' });
    expect(credit.gapCents).toBe(-2000);
    expect(credit.body).toEqual({ documents: [{ type: 'invoice', id: 'a', amount: '100.00' }] });
    const booked = planMatch({ transactionAmount: '120.00', shares, choice: 'account', accountId: 'acc_income' });
    expect(booked.body?.differenceAccountId).toBe('acc_income');
  });

  it('names the document whose amount is wrong', () => {
    expect(planMatch({ transactionAmount: '10', shares: [], choice: 'leave' }).problem).toBe('noDocuments');
    const invalid = planMatch({ transactionAmount: '10', shares: [invoice('a', 'x', '10')], choice: 'leave' });
    expect([invalid.problem, invalid.problemId]).toEqual(['invalidAmount', 'a']);
    const over = planMatch({ transactionAmount: '10', shares: [invoice('a', '11', '10.00')], choice: 'leave' });
    expect([over.problem, over.problemId]).toEqual(['overOpen', 'a']);
  });
});
