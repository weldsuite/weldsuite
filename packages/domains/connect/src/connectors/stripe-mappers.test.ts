import { describe, it, expect } from 'vitest';
import { mapConnectorRecord } from './mappers';
import { mapStripeCustomer, mapStripeInvoice, mapStripeLine } from './stripe-mappers';

const NOW = new Date('2026-02-01T00:00:00Z');

/** A paid subscription invoice: NL B2B with Stripe Tax reverse charge on one line, 21% on the other. */
function invoiceFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'in_1',
    object: 'invoice',
    number: 'ACME-0001',
    status: 'paid',
    currency: 'eur',
    created: 1767225600,
    due_date: null,
    status_transitions: { finalized_at: 1767225600, paid_at: 1767229200 },
    customer: 'cus_1',
    customer_name: 'Acme GmbH',
    customer_email: 'billing@acme.example',
    customer_address: { line1: 'Hauptstr. 1', city: 'Berlin', postal_code: '10115', country: 'de' },
    customer_tax_ids: [{ type: 'eu_vat', value: 'DE123456789' }],
    subtotal: 15000,
    subtotal_excluding_tax: 15000,
    tax: 1050,
    total: 16050,
    amount_paid: 16050,
    amount_remaining: 0,
    hosted_invoice_url: 'https://invoice.stripe.com/i/acct_1/x',
    total_discount_amounts: [],
    total_tax_amounts: [
      { amount: 0, taxable_amount: 10000, taxability_reason: 'reverse_charge', tax_rate: { id: 'txr_rc', percentage: 0, display_name: 'VAT', country: 'DE' } },
      { amount: 1050, taxable_amount: 5000, taxability_reason: 'standard_rated', tax_rate: { id: 'txr_21', percentage: 21, display_name: 'BTW', country: 'NL' } },
    ],
    lines: {
      data: [
        {
          id: 'il_1',
          description: 'Pro plan (Jan 2026)',
          quantity: 1,
          amount: 10000,
          amount_excluding_tax: 10000,
          period: { start: 1767225600, end: 1769904000 },
          tax_amounts: [{ amount: 0, taxable_amount: 10000, tax_rate: 'txr_rc' }],
          discount_amounts: [],
        },
        {
          id: 'il_2',
          description: 'Seats',
          quantity: 2,
          amount: 5000,
          amount_excluding_tax: 5000,
          tax_amounts: [{ amount: 1050, taxable_amount: 5000, tax_rate: 'txr_21' }],
          discount_amounts: [],
        },
      ],
    },
    updated_at: '2026-01-01T00:00:00.000Z',
    _weld_skip: false,
    ...overrides,
  };
}

describe('mapStripeInvoice', () => {
  it('maps totals, lines, tax breakdown and the customer snapshot', () => {
    const mapped = mapStripeInvoice(invoiceFixture(), 'in_1', NOW)!;
    expect(mapped.values).toMatchObject({
      invoiceNumber: 'ACME-0001',
      status: 'paid',
      currency: 'EUR',
      subtotal: '150.00',
      taxTotal: '10.50',
      total: '160.50',
      amountPaid: '160.50',
      balanceDue: '0.00',
      contactTaxNumber: 'DE123456789',
      reference: 'in_1',
      paymentLink: 'https://invoice.stripe.com/i/acct_1/x',
    });
    expect(mapped.values.paidAt).toEqual(new Date(1767229200 * 1000));
    expect(mapped.values.billingAddress).toEqual({ line1: 'Hauptstr. 1', city: 'Berlin', postalCode: '10115', country: 'DE' });
    expect(mapped.lineItems).toEqual([
      expect.objectContaining({ description: 'Pro plan (Jan 2026)', quantity: '1', unitPrice: '100.0000', taxRate: '0', lineTotal: '100.00', lineTotalWithTax: '100.00', period: { from: '2026-01-01', to: '2026-02-01' } }),
      expect.objectContaining({ description: 'Seats', quantity: '2', unitPrice: '25.0000', taxRate: '21', taxAmount: '10.50', lineTotal: '50.00', lineTotalWithTax: '60.50' }),
    ]);
    expect(mapped.values.taxBreakdown).toEqual([
      expect.objectContaining({ taxRate: 0, taxCategoryCode: 'reverse_charge', exemptReason: 'reverse_charge', jurisdictionCode: 'DE' }),
      expect.objectContaining({ taxRate: 21, taxAmount: 10.5, taxCategoryCode: 'standard_rated', jurisdictionCode: 'NL' }),
    ]);
    expect(mapped.contactExternalId).toBe('cus_1');
    expect(mapped.nestedContact).toMatchObject({ id: 'cus_1', name: 'Acme GmbH', email: 'billing@acme.example' });
  });

  it('nets discounts out of lines without tax', () => {
    const mapped = mapStripeInvoice(
      invoiceFixture({
        tax: 0,
        total: 8000,
        total_tax_amounts: [],
        lines: { data: [{ id: 'il', description: 'Plan', quantity: 1, amount: 10000, amount_excluding_tax: 10000, tax_amounts: [], discount_amounts: [{ amount: 2000 }] }] },
      }),
      'in_1',
      NOW,
    )!;
    expect(mapped.lineItems[0]).toMatchObject({ lineTotal: '80.00', taxRate: null, unitPrice: '80.0000' });
  });

  it('maps open/void states and skips drafts and pre-start invoices', () => {
    expect(mapStripeInvoice(invoiceFixture({ status: 'open', amount_paid: 0, due_date: 1767312000 }), 'in_1', NOW)?.values.status).toBe('overdue');
    expect(mapStripeInvoice(invoiceFixture({ status: 'open', amount_paid: 0, due_date: 1800000000 }), 'in_1', NOW)?.values.status).toBe('sent');
    expect(mapStripeInvoice(invoiceFixture({ status: 'open', amount_paid: 100 }), 'in_1', NOW)?.values.status).toBe('partial');
    expect(mapStripeInvoice(invoiceFixture({ status: 'void' }), 'in_1', NOW)?.values).toMatchObject({ status: 'cancelled', balanceDue: '0.00' });
    expect(mapStripeInvoice(invoiceFixture({ status: 'draft', number: null }), 'in_1', NOW)).toBeNull();
    expect(mapStripeInvoice(invoiceFixture({ _weld_skip: true }), 'in_1', NOW)).toBeNull();
  });

  it('is what the shared mapper dispatches to for provider stripe', () => {
    expect(mapConnectorRecord('invoice', invoiceFixture(), 'stripe')?.entity).toBe('invoice');
  });
});

describe('mapStripeCustomer', () => {
  it('treats a customer with a VAT id as a company and others as a person', () => {
    const company = mapStripeCustomer({ id: 'cus_1', name: 'Acme GmbH', email: 'a@acme.example', tax_ids: [{ type: 'eu_vat', value: 'DE1' }] }, 'cus_1')!;
    expect(company.kind).toBe('company');
    expect(company.identity).toMatchObject({ name: 'Acme GmbH', vatNumber: 'DE1', source: 'stripe' });
    const person = mapStripeCustomer({ id: 'cus_2', name: 'Jan de Vries', email: 'jan@example.com', tax_ids: [] }, 'cus_2')!;
    expect(person.kind).toBe('person');
    expect(person.identity).toMatchObject({ firstName: 'Jan', lastName: 'de Vries' });
    expect(mapStripeCustomer({ id: 'cus_3' }, 'cus_3')).toBeNull();
  });
});

describe('mapStripeLine', () => {
  it('maps a payout line onto the Stripe balance account with the invoice reference', () => {
    const mapped = mapStripeLine(
      {
        id: 'txn_ch',
        line: 'gross',
        type: 'charge',
        amount: 10000,
        currency: 'EUR',
        created: '2026-01-01T00:00:00.000Z',
        available_on: '2026-01-03T00:00:00.000Z',
        invoice_id: 'in_1',
        charge_id: 'ch_1',
        source_id: 'ch_1',
        payout_id: 'po_1',
        balance_account: 'balance_EUR',
        customer_name: 'Acme',
      },
      'txn_ch',
    )!;
    expect(mapped.financialAccountExternalId).toBe('balance_EUR');
    expect(mapped.invoiceExternalId).toBe('in_1');
    expect(mapped.values).toMatchObject({ amount: '100.00', counterpartyName: 'Acme', reference: 'ch_1', status: 'unreconciled' });
    expect(mapped.values.rawData).toMatchObject({ stripeLine: 'gross', payoutId: 'po_1', invoiceId: 'in_1' });
  });
});
