import { describe, expect, it } from 'vitest';
import { en } from '@weldsuite/i18n/locales/en';
import { nl } from '@weldsuite/i18n/locales/nl';
import { BATCH_ERROR_CODES } from '@/lib/api/domains/weldbooks-receipts';
import {
  batchErrorCode,
  batchErrorMessage,
  batchFileName,
  batchStatus,
  canCreateBatch,
  heldMessage,
  isSelectable,
  maskIban,
  selectedTotal,
} from './pay-model';

describe('maskIban', () => {
  it('keeps the country, the check digits and the last four', () => {
    expect(maskIban('NL91 ABNA 0417 1643 00')).toBe('NL91 •••• 4300');
    expect(maskIban('nl91abna0417164300')).toBe('NL91 •••• 4300');
  });

  it('shows what is too short to hide as it is, and nothing for none', () => {
    expect(maskIban('NL91')).toBe('NL91');
    expect(maskIban(null)).toBe('');
  });
});

describe('selectedTotal', () => {
  const bills = [
    { id: 'a', balanceDue: '100.10' },
    { id: 'b', balanceDue: '20.20' },
    { id: 'c', balanceDue: null },
  ];

  it('adds the balances of the picked bills to the cent', () => {
    expect(selectedTotal(bills, new Set(['a', 'b']))).toBe('120.30');
    expect(selectedTotal(bills, new Set(['c']))).toBe('0.00');
    expect(selectedTotal(bills, new Set())).toBe('0.00');
  });
});

describe('batchStatus', () => {
  it('derives completed from the bills being paid', () => {
    expect(batchStatus({ status: 'exported', billCount: 2, paidBillCount: 0 })).toBe('exported');
    expect(batchStatus({ status: 'exported', billCount: 2, paidBillCount: 1 })).toBe('exported');
    expect(batchStatus({ status: 'exported', billCount: 2, paidBillCount: 2 })).toBe('completed');
    expect(batchStatus({ status: 'cancelled', billCount: 2, paidBillCount: 2 })).toBe('cancelled');
  });
});

describe('selecting', () => {
  it('leaves out a bill already waiting in an exported file', () => {
    const pending = new Map([['bill_1', { batchId: 'b', executionDate: '2026-12-01' }]]);
    expect(isSelectable('bill_1', pending)).toBe(false);
    expect(isSelectable('bill_2', pending)).toBe(true);
  });

  it('needs bills, an account and a date', () => {
    expect(canCreateBatch({ selected: 1, bankAccountId: 'ba_1', executionDate: '2026-12-01' })).toBe(true);
    expect(canCreateBatch({ selected: 0, bankAccountId: 'ba_1', executionDate: '2026-12-01' })).toBe(false);
    expect(canCreateBatch({ selected: 1, bankAccountId: '', executionDate: '2026-12-01' })).toBe(false);
    expect(canCreateBatch({ selected: 1, bankAccountId: 'ba_1', executionDate: '1 Dec' })).toBe(false);
  });
});

describe('refusals in words', () => {
  it('reads the code of a refused request', () => {
    expect(batchErrorCode(Object.assign(new Error('x'), { code: 'NO_IBAN' }))).toBe('NO_IBAN');
    expect(batchErrorCode(Object.assign(new Error('x'), { code: 'SOMETHING_NEW' }))).toBeNull();
    expect(batchErrorCode(new Error('x'))).toBeNull();
    expect(batchErrorCode(null)).toBeNull();
  });

  it('has a sentence for every code the backend sends, in English and Dutch', () => {
    for (const copy of [en.weldbooksReceipts.pay.errors, nl.weldbooksReceipts.pay.errors]) {
      for (const code of BATCH_ERROR_CODES) {
        const message = batchErrorMessage(Object.assign(new Error('x'), { code }), copy);
        expect(message).toBe(copy[code]);
        expect(message).not.toBe(copy.fallback);
        expect(message).not.toMatch(/[A-Z]+_[A-Z_]+/);
      }
    }
  });

  it('says the general sentence for a code it does not know, never the raw code', () => {
    const copy = en.weldbooksReceipts.pay.errors;
    expect(batchErrorMessage(Object.assign(new Error('x'), { code: 'BRAND_NEW' }), copy)).toBe(copy.fallback);
    expect(batchErrorMessage(new Error('boom'), copy)).toBe(copy.fallback);
  });

  it('words the held reasons, and falls back to the server sentence', () => {
    const copy = en.weldbooksReceipts.pay.heldCodes;
    expect(heldMessage({ code: 'NO_IBAN', message: 'x' }, copy)).toBe('The supplier has no IBAN. Add it to the contact.');
    expect(heldMessage({ code: 'OTHER', message: 'Held for review' }, copy)).toBe('Held for review');
  });
});

describe('batchFileName', () => {
  it('uses the server file name, else one made from the date', () => {
    expect(batchFileName({ fileName: 'sepa-1.xml', executionDate: '2026-12-01' })).toBe('sepa-1.xml');
    expect(batchFileName({ fileName: null, executionDate: '2026-12-01' })).toBe('sepa-2026-12-01.xml');
  });
});
