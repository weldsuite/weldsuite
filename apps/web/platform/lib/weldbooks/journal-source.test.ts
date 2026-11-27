import { describe, expect, it } from 'vitest';
import { en } from '@weldsuite/i18n/locales/en';
import { nl } from '@weldsuite/i18n/locales/nl';
import { journalSourceLabel } from './journal-source';

const labels = en.accounting.statusLabels.journalEntrySource;

describe('journalSourceLabel', () => {
  it('names a known source in words', () => {
    expect(journalSourceLabel('bank_reconciliation', labels)).toBe('Bank reconciliation');
    expect(journalSourceLabel('invoice', labels)).toBe('Invoice');
  });

  it('calls an entry without a source manual', () => {
    expect(journalSourceLabel(null, labels)).toBe('Manual');
    expect(journalSourceLabel('', labels)).toBe('Manual');
  });

  it('shows a source the dictionary does not know yet as plain words, never as the code', () => {
    expect(journalSourceLabel('credit_card_fee', labels)).toBe('credit card fee');
  });

  it('has the same sources in Dutch', () => {
    expect(Object.keys(nl.accounting.statusLabels.journalEntrySource).sort()).toEqual(Object.keys(labels).sort());
    expect(journalSourceLabel('invoice', nl.accounting.statusLabels.journalEntrySource)).toBe('Factuur');
  });
});
