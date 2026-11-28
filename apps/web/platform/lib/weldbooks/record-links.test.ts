import { describe, expect, it } from 'vitest';
import { documentRecord, journalSourceRecord } from './record-links';

describe('journalSourceRecord', () => {
  it.each([
    ['invoice', 'invoice'],
    ['credit_note', 'invoice'],
    ['bill', 'bill'],
    ['bill_credit_note', 'bill'],
    ['bank_transaction', 'bank_transaction'],
    ['bank_deposit', 'deposit'],
    ['fixed_asset', 'fixed_asset'],
    ['payroll', 'payroll_run'],
    ['tax_return', 'vat_return'],
    ['pick_list', 'pick-list'],
  ])('opens a %s source in the %s panel', (sourceType, panel) => {
    expect(journalSourceRecord(sourceType, 'src_1')).toEqual({ type: panel, id: 'src_1' });
  });

  it('has no record for a source without a panel, an unknown source, or no id', () => {
    expect(journalSourceRecord('payment', 'pay_1')).toBeNull();
    expect(journalSourceRecord('bank_reconciliation', 'rec_1')).toBeNull();
    expect(journalSourceRecord('something_new', 'x_1')).toBeNull();
    expect(journalSourceRecord('invoice', null)).toBeNull();
    expect(journalSourceRecord(null, 'x_1')).toBeNull();
    expect(journalSourceRecord('manual', undefined)).toBeNull();
  });
});

describe('documentRecord', () => {
  it('maps the document types of the sales-tax and report rows to their panels', () => {
    expect(documentRecord('invoice', 'a')).toEqual({ type: 'invoice', id: 'a' });
    expect(documentRecord('credit_note', 'a')).toEqual({ type: 'invoice', id: 'a' });
    expect(documentRecord('write_off', 'a')).toEqual({ type: 'invoice', id: 'a' });
    expect(documentRecord('bill', 'a')).toEqual({ type: 'bill', id: 'a' });
    expect(documentRecord('bill_credit_note', 'a')).toEqual({ type: 'bill', id: 'a' });
    expect(documentRecord('journal_entry', 'a')).toEqual({ type: 'journal_entry', id: 'a' });
    expect(documentRecord('payment', 'a')).toBeNull();
    expect(documentRecord('invoice', null)).toBeNull();
  });
});
