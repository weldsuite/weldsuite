import { describe, it, expect } from 'vitest';
import { looksLikeIban, mapConnectorRecord } from './mappers';

function map(entity: Parameters<typeof mapConnectorRecord>[0], record: Record<string, unknown>) {
  return mapConnectorRecord(entity, record, 'moneybird');
}

const baseBill = { id: 'pi1', reference: 'INK-1', contact_id: 'c1', state: 'open', date: '2026-03-02', currency: 'USD' };

describe('Moneybird document exchange rate', () => {
  it('is the document total over its base-currency total, incl. tax first', () => {
    const mapped = map('bill', { ...baseBill, total_price_incl_tax: '110.0', total_price_incl_tax_base: '100.0', total_price_excl_tax: '90', total_price_excl_tax_base: '90' });
    expect(mapped).toMatchObject({ values: { exchangeRate: '1.100000' } });
  });

  it('falls back to the excl-tax pair when the incl-tax pair is unusable', () => {
    for (const incl of [{ total_price_incl_tax: '0', total_price_incl_tax_base: '0' }, { total_price_incl_tax: '12.1' }, { total_price_incl_tax: 'abc', total_price_incl_tax_base: '1' }]) {
      const mapped = map('invoice', { ...baseBill, invoice_id: 'F-1', ...incl, total_price_excl_tax: '50.0', total_price_excl_tax_base: '40.0' });
      expect(mapped).toMatchObject({ values: { exchangeRate: '1.250000' } });
    }
  });

  it('is left out when neither pair parses', () => {
    const mapped = map('bill', { ...baseBill, total_price_incl_tax: '121.0' });
    expect(mapped && 'values' in mapped && 'exchangeRate' in mapped.values).toBe(false);
    const zero = map('bill', { ...baseBill, total_price_incl_tax: '0', total_price_incl_tax_base: '0', total_price_excl_tax: '0', total_price_excl_tax_base: '0' });
    expect(zero && 'values' in zero && 'exchangeRate' in zero.values).toBe(false);
  });
});

describe('Moneybird bank transactions', () => {
  const mutation = { id: 'm1', financial_account_id: 'fa1', amount: '-121.00', date: '2026-03-07', state: 'processed' };

  it.each(['cancelled', 'expired', 'refused', 'error', 'Cancelled'])('excludes a mutation whose settlement_state is %s', (settlementState) => {
    const mapped = map('bank_transaction', {
      ...mutation,
      settlement_state: settlementState,
      payments: [{ invoice_type: 'Document', invoice_id: 'pi1' }, { invoice_type: 'SalesInvoice', invoice_id: 'si1' }],
    });
    expect(mapped).toMatchObject({ values: { status: 'excluded' } });
    expect(mapped).not.toHaveProperty('invoiceExternalId');
    expect(mapped).not.toHaveProperty('billExternalId');
  });

  it('keeps the state-based status for other settlement states', () => {
    expect(map('bank_transaction', { ...mutation, settlement_state: 'settled' })).toMatchObject({ values: { status: 'reconciled' } });
    expect(map('bank_transaction', { ...mutation, state: 'unprocessed' })).toMatchObject({ values: { status: 'unreconciled' } });
  });

  it('names the first sales invoice and the first bill the mutation pays', () => {
    const mapped = map('bank_transaction', {
      ...mutation,
      payments: [
        { invoice_type: 'ExternalSalesInvoice', invoice_id: 9 },
        { invoice_type: 'Document', invoice_id: 77 },
        { invoice_type: 'SalesInvoice', invoice_id: 11 },
        { invoice_type: 'SalesInvoice', invoice_id: 12 },
        { invoice_type: 'Document', invoice_id: 78 },
      ],
    });
    expect(mapped).toMatchObject({ invoiceExternalId: '11', billExternalId: '77' });
  });

  it('has no links without payments', () => {
    const mapped = map('bank_transaction', mutation);
    expect(mapped).toMatchObject({ invoiceExternalId: null, billExternalId: null });
  });
});

describe('looksLikeIban', () => {
  it.each(['NL91ABNA0417164300', 'nl91 abna 0417 1643 00', 'DE89370400440532013000', 'GB82WEST12345698765432'])('accepts %s', (iban) => {
    expect(looksLikeIban(iban)).toBe(iban.replace(/\s+/g, '').toUpperCase());
  });

  it.each([
    'NL91ABNA0417164301', // checksum
    'NL91ABNA041716430', // length
    'XX89370400440532013000', // unknown country
    'Private withdrawals',
    'PSP12345678901234567',
    'N191ABNA0417164300',
    '',
  ])('rejects %s', (value) => {
    expect(looksLikeIban(value)).toBeNull();
  });

  it('maps a Moneybird account only with a valid IBAN', () => {
    expect(map('bank_account', { id: 'fa1', identifier: 'NL91 ABNA 0417 1643 00', currency: 'EUR', type: 'BankAccount' })).toMatchObject({ values: { iban: 'NL91ABNA0417164300' } });
    const psp = map('bank_account', { id: 'fa2', identifier: 'psp_1234567890123456', currency: 'EUR', type: 'PspAccount' });
    expect(psp && 'values' in psp && 'iban' in psp.values).toBe(false);
  });
});
