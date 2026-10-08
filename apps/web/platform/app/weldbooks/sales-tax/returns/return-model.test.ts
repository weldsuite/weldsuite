import { describe, expect, it } from 'vitest';
import type { ReturnAdjustment } from '@/lib/api/domains/weldbooks-sales-tax-center';
import {
  draftsFromAdjustments,
  draftsMatch,
  draftsToAdjustments,
  draftsTotals,
  emptyDraft,
  invalidDraftIds,
  isRecalculateConflict,
  paymentAmountProblem,
  paymentDifference,
  paymentNeedsReason,
  parseAmount,
  parseSkipped,
  returnTotals,
  stepStates,
  unusualSign,
} from './return-model';

describe('stepStates', () => {
  it('starts at calculate for an open return', () => {
    expect(stepStates('open')).toEqual({ calculate: 'current', review: 'todo', preFile: 'todo', file: 'todo', pay: 'todo' });
  });

  it('moves to review once calculated', () => {
    expect(stepStates('calculated')).toMatchObject({ calculate: 'done', review: 'current', preFile: 'todo' });
  });

  it('stays on the pre-file check of a reviewed return until the check is clean', () => {
    expect(stepStates('reviewed')).toMatchObject({ review: 'done', preFile: 'current', file: 'todo' });
    expect(stepStates('reviewed', true)).toMatchObject({ preFile: 'done', file: 'current' });
  });

  it('is at the payment once filed, and done once paid', () => {
    expect(stepStates('filed')).toEqual({ calculate: 'done', review: 'done', preFile: 'done', file: 'done', pay: 'current' });
    expect(Object.values(stepStates('paid'))).toEqual(['done', 'done', 'done', 'done', 'done']);
  });

  it('does not count a clean check before the return is reviewed', () => {
    expect(stepStates('calculated', true).preFile).toBe('todo');
  });
});

describe('parseAmount', () => {
  it('reads plain, signed and formatted numbers', () => {
    expect(parseAmount('12.5')).toBe(12.5);
    expect(parseAmount('-3.40')).toBe(-3.4);
    expect(parseAmount('$1,234.56')).toBe(1234.56);
  });

  it('says nothing for empty or unreadable text', () => {
    expect(parseAmount('')).toBeNull();
    expect(parseAmount('-')).toBeNull();
    expect(parseAmount('abc')).toBeNull();
  });
});

describe('adjustment drafts', () => {
  const stored: ReturnAdjustment[] = [
    { type: 'vendor_discount', amount: -10.5, note: 'Proposed', auto: true },
    { type: 'penalty', amount: 25 },
    { type: 'other', amount: -2, accountId: 'acc_9' },
  ];

  it('round-trips the stored adjustments into the PATCH payload', () => {
    const payload = draftsToAdjustments(draftsFromAdjustments(stored));
    expect(payload).toEqual(stored);
  });

  it('sends signed amounts rounded to cents, trimmed notes, and an account only for other adjustments', () => {
    const rows = [
      { ...emptyDraft('penalty'), amount: '25.456', note: '  late  ' },
      { ...emptyDraft('interest'), amount: '3', accountId: 'acc_1' },
      { ...emptyDraft('other'), amount: '-4', accountId: 'acc_2' },
    ];
    expect(draftsToAdjustments(rows)).toEqual([
      { type: 'penalty', amount: 25.46, note: 'late' },
      { type: 'interest', amount: 3 },
      { type: 'other', amount: -4, accountId: 'acc_2' },
    ]);
  });

  it('flags rows without a number', () => {
    const rows = [{ ...emptyDraft('penalty'), amount: '' }, { ...emptyDraft('interest'), amount: '2' }];
    expect(invalidDraftIds(rows)).toEqual([rows[0]!.id]);
  });

  it('knows when nothing changed', () => {
    expect(draftsMatch(draftsFromAdjustments(stored), stored)).toBe(true);
    const changed = draftsFromAdjustments(stored).map((row) => (row.type === 'penalty' ? { ...row, amount: '30' } : row));
    expect(draftsMatch(changed, stored)).toBe(false);
    expect(draftsMatch(draftsFromAdjustments(stored).slice(1), stored)).toBe(false);
  });

  it('treats a row without a valid amount as a change', () => {
    expect(draftsMatch([{ ...emptyDraft('penalty'), amount: '' }], [])).toBe(false);
  });

  it('flags the opposite sign of what an adjustment usually has', () => {
    expect(unusualSign('vendor_discount', 5)).toBe(true);
    expect(unusualSign('vendor_discount', -5)).toBe(false);
    expect(unusualSign('penalty', -5)).toBe(true);
    expect(unusualSign('rounding', -5)).toBe(false);
    expect(unusualSign('penalty', null)).toBe(false);
  });
});

describe('totals', () => {
  const summary = { salesTaxPayable: 804.38, useTaxPayable: 20 };

  it('adds the adjustments to the tax payable in cents', () => {
    expect(returnTotals(summary, [{ amount: -10.5 }, { amount: 0.1 }, { amount: 0.2 }])).toEqual({
      salesTaxPayable: 804.38,
      useTaxPayable: 20,
      adjustmentsTotal: -10.2,
      totalDue: 814.18,
    });
  });

  it('works out the total of the rows being edited, leaving out rows without an amount', () => {
    const rows = [{ ...emptyDraft('penalty'), amount: '25' }, { ...emptyDraft('other'), amount: '' }];
    expect(draftsTotals(summary, rows).totalDue).toBe(849.38);
  });

  it('is only the adjustments when nothing was calculated', () => {
    expect(returnTotals(null, [{ amount: 5 }]).totalDue).toBe(5);
  });
});

describe('payment rules', () => {
  it('needs a reason only when the amount differs from the total due', () => {
    expect(paymentNeedsReason(824.38, 824.38)).toBe(false);
    expect(paymentNeedsReason(824.38, 824.380001)).toBe(false);
    expect(paymentNeedsReason(824.38, 824)).toBe(true);
  });

  it('works out the difference in cents', () => {
    expect(paymentDifference(100.1, 100.4)).toBe(0.3);
    expect(paymentDifference(100, 90)).toBe(-10);
  });

  it('refuses a negative payment of a return with tax due and a positive one of a credit', () => {
    expect(paymentAmountProblem(100, -5)).toBe('negative');
    expect(paymentAmountProblem(-100, 5)).toBe('positive');
    expect(paymentAmountProblem(-100, -100)).toBeNull();
    expect(paymentAmountProblem(0, 0)).toBeNull();
  });
});

describe('reading server output', () => {
  it('reads the reasons a pre-file check did not run', () => {
    expect(parseSkipped('net_sales_difference: a cash-basis return counts sales when paid, so it does not match income of the period')).toMatchObject({
      code: 'net_sales_difference',
      reason: 'cash_basis',
    });
    expect(parseSkipped('net_sales_difference: the return is already filed')).toMatchObject({ reason: 'already_filed' });
    expect(parseSkipped('payable_direct_entries: the agency has no payable account of its own')).toMatchObject({
      code: 'payable_direct_entries',
      reason: 'no_payable_account',
    });
  });

  it('keeps the server wording for a reason it does not know', () => {
    expect(parseSkipped('something_new: because')).toEqual({ code: 'something_new', reason: null, raw: 'because' });
  });

  it('recognises the conflict that asks for a recalculation', () => {
    const conflict = Object.assign(new Error('The ledger changed since this return was calculated. Recalculate it, review the worksheet and file again.'), {
      status: 409,
      body: null,
      code: 'CONFLICT',
    });
    expect(isRecalculateConflict(conflict)).toBe(true);
    expect(isRecalculateConflict(Object.assign(new Error('This return has already been filed'), { status: 409 }))).toBe(false);
    expect(isRecalculateConflict(new Error('Recalculate'))).toBe(false);
  });
});
