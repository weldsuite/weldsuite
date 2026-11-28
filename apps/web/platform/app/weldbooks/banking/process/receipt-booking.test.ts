import { describe, expect, it } from 'vitest';
import type { DocumentPrefill } from '@/lib/api/domains/weldbooks-receipts';
import { receiptBookInput } from './receipt-booking';

function prefill(overrides: Partial<DocumentPrefill> = {}): DocumentPrefill {
  return {
    sourceDocumentId: 'doc_1',
    kind: 'receipt',
    contactId: 'sup_1',
    contactName: 'Paper Co',
    invoiceNumber: 'R-9',
    date: '2026-11-20',
    dueDate: null,
    currency: 'EUR',
    lines: [{ description: 'Paper', amount: 221, taxRate: 21, taxRateId: 'tax_21', accountId: 'acc_office', projectId: null }],
    subtotal: 182.64,
    taxTotal: 38.36,
    total: 221,
    paid: true,
    paymentMethod: 'card',
    paidWith: null,
    iban: null,
    paymentReference: null,
    confidence: null,
    defaults: null,
    ...overrides,
  };
}

describe('receiptBookInput', () => {
  it('books the prefill lines as a receipt paid with the bank line', () => {
    expect(receiptBookInput(prefill(), 'btx_1', '2026-11-27')).toEqual({
      ok: true,
      input: {
        kind: 'receipt',
        contactId: 'sup_1',
        invoiceNumber: 'R-9',
        date: '2026-11-20',
        currency: 'EUR',
        lines: [{ description: 'Paper', amount: 221, accountId: 'acc_office', taxRateId: 'tax_21' }],
        paidWith: { type: 'bank_transaction', bankTransactionId: 'btx_1' },
      },
    });
  });

  it('dates the receipt like the bank line when the scan read no date', () => {
    const plan = receiptBookInput(prefill({ date: null }), 'btx_1', '2026-11-22');
    expect(plan.ok && plan.input.date).toBe('2026-11-22');
  });

  it('turns a receipt with a total but no readable lines into one line', () => {
    const plan = receiptBookInput(prefill({ lines: [] }), 'btx_1', '2026-11-22');
    expect(plan.ok && plan.input.lines).toEqual([{ description: 'Paper Co', amount: 221 }]);
  });

  it('needs a supplier and something to book', () => {
    expect(receiptBookInput(prefill({ contactId: null }), 'btx_1', '2026-11-22')).toEqual({ ok: false, problem: 'noSupplier' });
    expect(receiptBookInput(prefill({ lines: [], total: null }), 'btx_1', '2026-11-22')).toEqual({ ok: false, problem: 'noLines' });
  });
});
