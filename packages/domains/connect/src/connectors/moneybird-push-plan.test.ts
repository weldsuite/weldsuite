import { describe, it, expect } from 'vitest';
import type { MoneybirdTaxRate } from '@weldsuite/connectors';
import type { DocumentTaxBreakdownRow } from '@weldsuite/db/schema';
import {
  buildExternalSalesInvoicePayload,
  buildMoneybirdContactPayload,
  matchCreatedMutations,
  planPayoutStatement,
  resolveMoneybirdTaxRate,
  type PayoutLine,
} from './moneybird-push-plan';

const rate = (id: string, name: string, percentage: number, country: string | null = null): MoneybirdTaxRate => ({
  id,
  name,
  percentage,
  taxRateType: 'sales_invoice',
  country,
  active: true,
});

const RATES: MoneybirdTaxRate[] = [
  rate('r21', '21% btw', 21),
  rate('r9', '9% btw', 9),
  rate('r19de', 'DE 19% (OSS)', 19, 'DE'),
  rate('rvl', 'Btw verlegd', 0),
  rate('rbu', '0% btw buiten de EU', 0),
  rate('r0', '0% btw', 0),
  { ...rate('rp21', '21% inkoop', 21), taxRateType: 'purchase_invoice' },
];
const NO_OVERRIDES = { reverseCharge: null, outsideEu: null, exempt: null, noTax: null };

function breakdown(taxRate: number, reason: string, country?: string): DocumentTaxBreakdownRow {
  return {
    taxRateId: 'txr',
    taxRateName: 'x',
    taxRate,
    taxableAmount: 0,
    taxAmount: 0,
    taxCategoryCode: reason,
    ...(country ? { jurisdictionCode: country } : {}),
  };
}

describe('resolveMoneybirdTaxRate', () => {
  it('matches sales rates by percentage, preferring the Stripe rate country (OSS)', () => {
    expect(resolveMoneybirdTaxRate({ percentage: 21, breakdown: [breakdown(21, 'standard_rated', 'NL')] }, RATES, NO_OVERRIDES)).toEqual({ taxRateId: 'r21' });
    expect(resolveMoneybirdTaxRate({ percentage: 19, breakdown: [breakdown(19, 'standard_rated', 'DE')] }, RATES, NO_OVERRIDES)).toEqual({ taxRateId: 'r19de' });
    expect(resolveMoneybirdTaxRate({ percentage: 6, breakdown: [] }, RATES, NO_OVERRIDES)).toEqual({ error: 'No 6% sales tax rate in Moneybird' });
  });

  it('picks the 0% rate by Stripe taxability reason, and overrides win', () => {
    expect(resolveMoneybirdTaxRate({ percentage: 0, breakdown: [breakdown(0, 'reverse_charge')] }, RATES, NO_OVERRIDES)).toEqual({ taxRateId: 'rvl' });
    expect(resolveMoneybirdTaxRate({ percentage: 0, breakdown: [breakdown(0, 'not_collecting')] }, RATES, NO_OVERRIDES)).toEqual({ taxRateId: 'rbu' });
    expect(resolveMoneybirdTaxRate({ percentage: null, breakdown: [] }, RATES, NO_OVERRIDES)).toEqual({ taxRateId: 'r0' });
    expect(
      resolveMoneybirdTaxRate({ percentage: 0, breakdown: [breakdown(0, 'reverse_charge')] }, RATES, { ...NO_OVERRIDES, reverseCharge: 'custom' }),
    ).toEqual({ taxRateId: 'custom' });
  });

  it('keeps reverse charge and plain 0% apart instead of guessing', () => {
    const onlyReverse = [rate('rvl', 'Btw verlegd', 0)];
    expect('error' in resolveMoneybirdTaxRate({ percentage: null, breakdown: [] }, onlyReverse, NO_OVERRIDES)).toBe(true);
    const onlyPlain = [rate('r0', '0% btw', 0)];
    expect(resolveMoneybirdTaxRate({ percentage: 0, breakdown: [breakdown(0, 'reverse_charge')] }, onlyPlain, NO_OVERRIDES)).toEqual({
      error: 'No Moneybird sales tax rate for reverse charge lines: pick one under tax rates on the Moneybird connection',
    });
  });
});

describe('buildExternalSalesInvoicePayload', () => {
  it('sends lines excluding tax with rate, ledger and period, Stripe number as reference', () => {
    const built = buildExternalSalesInvoicePayload({
      invoice: {
        invoiceNumber: 'ACME-0001',
        issueDate: new Date('2026-01-01T00:00:00Z'),
        dueDate: new Date('2026-01-15T00:00:00Z'),
        currency: 'eur',
        paymentLink: 'https://invoice.stripe.com/i/x',
        taxBreakdown: [breakdown(21, 'standard_rated', 'NL')],
        lines: [
          { description: 'Seats', quantity: '2', unitPrice: '25.0000', lineTotal: '50.00', taxRate: '21', period: { from: '2026-01-01', to: '2026-02-01' } },
          { description: 'Proration', quantity: '1', unitPrice: '3.3333', lineTotal: '3.33', taxRate: '21', period: null },
        ],
      },
      contactId: 'c1',
      revenueLedgerAccountId: 'led_rev',
      taxRates: RATES,
      overrides: NO_OVERRIDES,
    });
    expect('payload' in built && built.payload).toEqual({
      contact_id: 'c1',
      reference: 'ACME-0001',
      date: '2026-01-01',
      due_date: '2026-01-15',
      currency: 'EUR',
      prices_are_incl_tax: false,
      source: 'Stripe',
      source_url: 'https://invoice.stripe.com/i/x',
      details_attributes: [
        { description: 'Seats', amount: '2', price: '25.00', tax_rate_id: 'r21', ledger_account_id: 'led_rev', period: '20260101..20260201' },
        { description: 'Proration', amount: '1', price: '3.33', tax_rate_id: 'r21', ledger_account_id: 'led_rev' },
      ],
    });
  });

  it('reports a missing tax rate instead of guessing', () => {
    const built = buildExternalSalesInvoicePayload({
      invoice: {
        invoiceNumber: 'X',
        issueDate: new Date(),
        dueDate: new Date(),
        currency: 'EUR',
        paymentLink: null,
        taxBreakdown: [breakdown(6, 'standard_rated')],
        lines: [{ description: 'A', quantity: '1', unitPrice: '1', lineTotal: '1', taxRate: '6', period: null }],
      },
      contactId: 'c',
      revenueLedgerAccountId: 'l',
      taxRates: RATES,
      overrides: NO_OVERRIDES,
    });
    expect(built).toEqual({ error: 'No 6% sales tax rate in Moneybird' });
  });
});

describe('buildMoneybirdContactPayload', () => {
  it('sends companies by name with VAT and people by first/last name', () => {
    expect(
      buildMoneybirdContactPayload({
        kind: 'company',
        displayName: 'Acme GmbH',
        firstName: null,
        lastName: null,
        email: 'a@acme.example',
        phone: null,
        vatNumber: 'DE1',
        address: { line1: 'Hauptstr. 1', postalCode: '10115', city: 'Berlin', country: 'de' },
      }),
    ).toEqual({
      company_name: 'Acme GmbH',
      email: 'a@acme.example',
      send_invoices_to_email: 'a@acme.example',
      tax_number: 'DE1',
      address1: 'Hauptstr. 1',
      zipcode: '10115',
      city: 'Berlin',
      country: 'DE',
    });
    expect(
      buildMoneybirdContactPayload({ kind: 'person', displayName: 'Jan', firstName: 'Jan', lastName: 'de Vries', email: null, phone: null, vatNumber: null, address: null }),
    ).toEqual({ firstname: 'Jan', lastname: 'de Vries' });
  });
});

describe('planPayoutStatement', () => {
  const line = (overrides: Partial<PayoutLine>): PayoutLine => ({
    bankTransactionId: 'bt',
    stripeLine: 'gross',
    type: 'charge',
    amount: '0',
    date: new Date('2026-01-01T00:00:00Z'),
    description: null,
    balanceTransactionId: null,
    moneybirdInvoiceId: null,
    invoiceNumber: null,
    counterpartyName: null,
    ...overrides,
  });

  it('lists charges, one fee total and the payout, each with a token to find it again', () => {
    const planned = planPayoutStatement('po_1', [
      line({ bankTransactionId: 'bt_c1', balanceTransactionId: 'txn_1', amount: '100.00', moneybirdInvoiceId: 'mb_1', invoiceNumber: 'ACME-1', counterpartyName: 'Acme' }),
      line({ bankTransactionId: 'bt_f1', stripeLine: 'fee', type: 'stripe_fee', amount: '-1.75', date: new Date('2026-01-02T00:00:00Z') }),
      line({ bankTransactionId: 'bt_c2', balanceTransactionId: 'txn_2', amount: '50.00' }),
      line({ bankTransactionId: 'bt_f2', stripeLine: 'fee', type: 'stripe_fee', amount: '-0.95' }),
      line({ bankTransactionId: 'bt_r', balanceTransactionId: 'txn_r', type: 'refund', amount: '-10.00', description: 'Refund' }),
      line({ bankTransactionId: 'bt_po', stripeLine: 'payout', type: 'payout', amount: '-137.30', date: new Date('2026-01-03T00:00:00Z') }),
    ]);
    expect(planned.map((row) => [row.token, row.amount, row.booking.kind])).toEqual([
      ['txn_1', '100.00', 'invoice'],
      ['txn_2', '50.00', 'manual'],
      ['txn_r', '-10.00', 'manual'],
      ['po_1-fees', '-2.70', 'fee'],
      ['po_1', '-137.30', 'payout'],
    ]);
    expect(planned[0]?.message).toBe('ACME-1 Acme [txn_1]');
    expect(planned[3]).toMatchObject({ date: '2026-01-02', bankTransactionId: 'bt_po' });

    const ids = matchCreatedMutations(planned, [
      { id: 501, message: 'Stripe payout po_1 [po_1]' },
      { id: 502, message: 'ACME-1 Acme [txn_1]' },
      { id: 503, message: 'Stripe fees po_1 [po_1-fees]' },
    ]);
    expect(ids.get('po_1')).toBe('501');
    expect(ids.get('txn_1')).toBe('502');
    expect(ids.get('po_1-fees')).toBe('503');
    expect(ids.has('txn_2')).toBe(false);
  });
});
