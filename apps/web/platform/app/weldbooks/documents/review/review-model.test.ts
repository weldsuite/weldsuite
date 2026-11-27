import { describe, expect, it } from 'vitest';
import type { BankCandidate, DocumentPrefill } from '@/lib/api/domains/weldbooks-receipts';
import {
  applyBookingDefaults,
  buildBookInput,
  candidateOverrides,
  canPayWith,
  initialPaidChoice,
  initialReviewState,
  isEnterOwnedBy,
  linesFromPrefill,
  newReviewLine,
  nextDocumentId,
  paidWithOf,
  reasonKeys,
  reviewProblem,
  totalCheck,
  type ReviewState,
} from './review-model';

function prefill(overrides: Partial<DocumentPrefill> = {}): DocumentPrefill {
  return {
    sourceDocumentId: 'doc_1',
    kind: 'purchase_invoice',
    contactId: 'sup_1',
    contactName: 'Paper Co',
    invoiceNumber: 'INV-7',
    date: '2026-11-20',
    dueDate: '2026-12-20',
    currency: 'EUR',
    lines: [{ description: 'Paper', amount: 221, taxRate: 21, taxRateId: 'tax_21', accountId: 'acc_office', projectId: null }],
    subtotal: 182.64,
    taxTotal: 38.36,
    total: 221,
    paid: false,
    paymentMethod: null,
    paidWith: null,
    iban: null,
    paymentReference: null,
    confidence: { overall: 0.92 },
    defaults: null,
    ...overrides,
  };
}

function candidate(overrides: Partial<BankCandidate> = {}): BankCandidate {
  return {
    id: 'btx_1',
    bankAccountId: 'ba_1',
    date: '2026-11-21',
    amount: '-221.00',
    counterpartyName: 'Paper Co',
    counterpartyIban: null,
    description: null,
    reference: null,
    score: 0.9,
    reasons: ['exact amount match'],
    sure: true,
    ...overrides,
  };
}

function ready(overrides: Partial<ReviewState> = {}): ReviewState {
  return { ...initialReviewState(prefill(), '2026-11-27'), ...overrides };
}

describe('the form starts from the prefill', () => {
  it('takes the supplier, the numbers and the gross lines', () => {
    const state = initialReviewState(prefill(), '2026-11-27');
    expect(state).toMatchObject({ kind: 'purchase_invoice', contactId: 'sup_1', invoiceNumber: 'INV-7', date: '2026-11-20', dueDate: '2026-12-20', currency: 'EUR' });
    expect(state.lines).toHaveLength(1);
    expect(state.lines[0]).toMatchObject({ description: 'Paper', accountId: 'acc_office', taxRateId: 'tax_21', amount: '221.00' });
    expect(state.paid).toEqual({ type: 'none' });
  });

  it('starts empty, dated today, when there is no prefill', () => {
    const state = initialReviewState(null, '2026-11-27');
    expect(state).toMatchObject({ contactId: '', date: '2026-11-27', kind: 'purchase_invoice' });
    expect(state.lines).toHaveLength(1);
    expect(state.lines[0].amount).toBe('');
  });

  it('keeps the kind the scan found', () => {
    expect(initialReviewState(prefill({ kind: 'receipt' }), '2026-11-27').kind).toBe('receipt');
  });

  it('turns lines without an amount into empty fields', () => {
    expect(linesFromPrefill([{ description: 'x', amount: Number.NaN, taxRate: null, taxRateId: null, accountId: null, projectId: null }])[0].amount).toBe('');
  });
});

describe('Paid with', () => {
  it('preselects the sure bank line', () => {
    expect(initialPaidChoice('purchase_invoice', prefill(), [candidate({ sure: false, id: 'a' }), candidate({ id: 'btx_9' })])).toEqual({
      type: 'bank_transaction',
      bankTransactionId: 'btx_9',
    });
  });

  it('does not preselect a line that is only possible', () => {
    expect(initialPaidChoice('purchase_invoice', prefill(), [candidate({ sure: false })])).toEqual({ type: 'none' });
  });

  it('follows what the scan said when there is no sure line', () => {
    expect(initialPaidChoice('receipt', prefill({ paidWith: { type: 'cash' } }), [])).toEqual({ type: 'cash' });
    expect(initialPaidChoice('receipt', prefill({ paidWith: { type: 'private' } }), [])).toEqual({ type: 'private' });
    expect(initialPaidChoice('receipt', prefill({ paidWith: { type: 'card_unmatched' } }), [])).toEqual({ type: 'none' });
  });

  it('never pays a credit note', () => {
    expect(canPayWith('credit_note')).toBe(false);
    expect(initialPaidChoice('credit_note', prefill(), [candidate()])).toEqual({ type: 'none' });
    expect(paidWithOf('credit_note', { type: 'cash' })).toBeUndefined();
  });

  it('sends not paid yet as card_unmatched', () => {
    expect(paidWithOf('purchase_invoice', { type: 'none' })).toEqual({ type: 'card_unmatched' });
    expect(paidWithOf('purchase_invoice', { type: 'bank_transaction', bankTransactionId: 'btx_1' })).toEqual({
      type: 'bank_transaction',
      bankTransactionId: 'btx_1',
    });
    expect(paidWithOf('receipt', { type: 'private' })).toEqual({ type: 'private' });
  });
});

describe('the lines against the document', () => {
  it('adds the lines to the cent and compares them with the total', () => {
    const lines = [newReviewLine({ amount: '100,50' }), newReviewLine({ amount: '120.50' })];
    expect(totalCheck(lines, 221)).toEqual({ sumCents: 22100, totalCents: 22100, differenceCents: 0, matches: true });
    expect(totalCheck(lines, 220.9)).toMatchObject({ differenceCents: 10, matches: false });
  });

  it('has nothing to compare with when the document shows no total', () => {
    expect(totalCheck([newReviewLine({ amount: '5' })], null)).toMatchObject({ sumCents: 500, totalCents: null, differenceCents: null, matches: false });
  });

  it('counts an unreadable amount as zero', () => {
    expect(totalCheck([newReviewLine({ amount: 'abc' }), newReviewLine({ amount: '2.00' })], 2).matches).toBe(true);
  });
});

describe('what is missing before it can be booked', () => {
  it('names the first thing missing', () => {
    expect(reviewProblem(ready({ contactId: '' }))).toBe('noSupplier');
    expect(reviewProblem(ready({ date: '' }))).toBe('noDate');
    expect(reviewProblem(ready({ lines: [] }))).toBe('noLines');
    expect(reviewProblem(ready({ lines: [newReviewLine({ accountId: 'a', amount: '' })] }))).toBe('badAmount');
    expect(reviewProblem(ready({ lines: [newReviewLine({ accountId: 'a', amount: '0' })] }))).toBe('badAmount');
    expect(reviewProblem(ready({ lines: [newReviewLine({ amount: '5' })] }))).toBe('noCategory');
    expect(reviewProblem(ready({ paid: { type: 'bank_transaction', bankTransactionId: '' } }))).toBe('noBankLine');
  });

  it('is ready with a supplier, a date, categories and amounts', () => {
    expect(reviewProblem(ready())).toBeNull();
  });
});

describe('the book request', () => {
  it('sends the gross lines, the paid-with and leaves empty optionals out', () => {
    const input = buildBookInput(ready({ paid: { type: 'bank_transaction', bankTransactionId: 'btx_1' }, dueDate: '' }));
    expect(input).toEqual({
      kind: 'purchase_invoice',
      contactId: 'sup_1',
      invoiceNumber: 'INV-7',
      date: '2026-11-20',
      currency: 'EUR',
      lines: [{ description: 'Paper', accountId: 'acc_office', taxRateId: 'tax_21', amount: 221 }],
      paidWith: { type: 'bank_transaction', bankTransactionId: 'btx_1' },
    });
  });

  it('gives a line without a description a name and keeps a project', () => {
    const input = buildBookInput(ready({ lines: [newReviewLine({ accountId: 'a', amount: '9,5', projectId: 'prj_1' })] }));
    expect(input.lines[0]).toEqual({ description: '1', accountId: 'a', amount: 9.5, projectId: 'prj_1' });
  });

  it('sends no paid-with for a credit note', () => {
    expect(buildBookInput(ready({ kind: 'credit_note' })).paidWith).toBeUndefined();
  });
});

describe('the bank line search follows the form', () => {
  it('passes the total, the date, the supplier and the number', () => {
    expect(candidateOverrides(ready())).toEqual({ amount: '221.00', date: '2026-11-20', contactId: 'sup_1', invoiceNumber: 'INV-7' });
  });

  it('leaves out what is not filled in', () => {
    expect(candidateOverrides(ready({ contactId: '', invoiceNumber: '', lines: [newReviewLine()] }))).toEqual({ date: '2026-11-20' });
  });
});

describe('reasonKeys', () => {
  it('translates the reasons it knows and drops the ones it does not', () => {
    expect(
      reasonKeys([
        'exact amount match',
        'inside the payment window',
        'counterparty IBAN matches the supplier',
        'document number in the description',
        'same as the supplier',
        'something new',
      ]),
    ).toEqual(['exactAmount', 'window', 'iban', 'number', 'name']);
  });
});

describe('supplier defaults', () => {
  it('fill only what the line lacks', () => {
    const lines = [newReviewLine({ accountId: 'typed', amount: '1' }), newReviewLine({ amount: '2' })];
    const filled = applyBookingDefaults(lines, {
      account: { accountId: 'acc_default', code: '4000', name: 'Office', count: 3, source: 'history' },
      taxRate: { taxRateId: 'tax_21', name: 'VAT 21%', rate: '21', count: 3, source: 'history' },
      project: null,
    });
    expect(filled.map((line) => [line.accountId, line.taxRateId])).toEqual([
      ['typed', 'tax_21'],
      ['acc_default', 'tax_21'],
    ]);
  });

  it('change nothing without defaults', () => {
    const lines = [newReviewLine({ amount: '1' })];
    expect(applyBookingDefaults(lines, null)).toEqual(lines);
  });
});

describe('nextDocumentId', () => {
  const docs = [
    { id: 'a', status: 'linked' },
    { id: 'b', status: 'processed' },
    { id: 'c', status: 'review' },
    { id: 'd', status: 'rejected' },
    { id: 'e', status: 'processed' },
  ];

  it('opens the next one still to check after the current one', () => {
    expect(nextDocumentId(docs, 'b')).toBe('c');
    expect(nextDocumentId(docs, 'c')).toBe('e');
  });

  it('starts from the top after the last, and skips what was handled', () => {
    expect(nextDocumentId(docs, 'e')).toBe('b');
    expect(nextDocumentId(docs, 'b', new Set(['c']))).toBe('e');
  });

  it('is null when nothing else is left', () => {
    expect(nextDocumentId([{ id: 'a', status: 'processed' }], 'a')).toBeNull();
    expect(nextDocumentId([], 'a')).toBeNull();
  });
});

describe('isEnterOwnedBy', () => {
  it('leaves Enter to fields, buttons, links and dialogs', () => {
    document.body.innerHTML = '<input id="i" /><button id="b">x</button><a id="a" href="/x">x</a><div id="d" role="dialog"><span id="s">x</span></div><p id="p">x</p>';
    for (const id of ['i', 'b', 'a', 's']) expect(isEnterOwnedBy(document.getElementById(id))).toBe(true);
    expect(isEnterOwnedBy(document.getElementById('p'))).toBe(false);
    expect(isEnterOwnedBy(document.body)).toBe(false);
    expect(isEnterOwnedBy(null)).toBe(false);
  });
});
