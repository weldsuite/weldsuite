// The workspace billing history, rendered to markup (the admin tests run in
// node): Stripe rows (from before Global moved in) keep their links;
// WeldBooks invoices and Mollie charges show where they came from instead.
// Nothing here changes billing: refunds run from the CLI.

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { InvoiceRow, PaymentRow } from './billing-types';

import { HistoryCard } from '@/app/workspaces/[id]/billing/history-card';
import { adminCopy } from './i18n';
import { mollieBillingCopyByLocale } from './mollie-billing-copy';

const t = adminCopy();
const c = mollieBillingCopyByLocale.en;

const invoice = (over: Partial<InvoiceRow>): InvoiceRow => ({
  id: 'inv_1',
  provider: 'stripe',
  providerPaymentId: null,
  number: 'INV-0001',
  status: 'paid',
  amountDue: 4900,
  amountPaid: 4900,
  currency: 'eur',
  pdfUrl: null,
  hostedUrl: null,
  createdAt: '2026-11-14T10:00:00.000Z',
  ...over,
});

const payment = (over: Partial<PaymentRow>): PaymentRow => ({
  id: 'pay_1',
  provider: 'stripe',
  providerPaymentId: null,
  kind: null,
  amount: 4900,
  currency: 'eur',
  status: 'succeeded',
  refundedAmount: 0,
  methodType: 'card',
  methodBrand: 'visa',
  methodLast4: '4242',
  createdAt: '2026-11-14T10:00:00.000Z',
  ...over,
});

function card(invoices: InvoiceRow[], payments: PaymentRow[]): string {
  return renderToStaticMarkup(createElement(HistoryCard, { invoices, payments }));
}

describe('HistoryCard', () => {
  it('keeps the links of Stripe rows, without actions', () => {
    const html = card(
      [invoice({ status: 'open', pdfUrl: 'https://pay.stripe.com/invoice/acct/pdf' })],
      [payment({})],
    );
    expect(html).toContain('INV-0001');
    expect(html).toContain('https://pay.stripe.com/invoice/acct/pdf');
    expect(html).not.toContain(`>${t.invoices.void}<`);
    expect(html).not.toContain(`>${t.payments.refund}<`);
    expect(html).not.toContain(c.history.weldbooks);
    // Only Stripe payments: no refund command to point at.
    expect(html).not.toContain(c.history.refundHint);
  });

  it('shows where a WeldBooks invoice and a Mollie charge came from, without Stripe actions', () => {
    const html = card(
      [
        invoice({
          id: 'binv_1',
          provider: 'weldbooks',
          providerPaymentId: 'tr_1',
          number: 'WS-0001',
          status: 'open',
          pdfUrl: '/api/billing/invoices/binv_1/document',
        }),
        invoice({
          id: 'binv_2',
          provider: 'weldbooks',
          number: 'WS-0002',
          pdfUrl: 'https://files.weldsuite.eu/WS-0002.pdf',
          hostedUrl: 'https://pay.weldsuite.eu/WS-0002',
        }),
      ],
      [
        payment({ id: 'bpy_1', provider: 'mollie', providerPaymentId: 'tr_1', kind: 'renewal' }),
        payment({ id: 'bpy_2', provider: 'other', kind: null, status: 'processing' }),
      ],
    );
    expect(html).toContain(c.history.weldbooks);
    expect(html).toContain('tr_1');
    // The document behind the customer's session isn't linked; absolute links are.
    expect(html).not.toContain('/api/billing/invoices/binv_1/document');
    expect(html).toContain('https://files.weldsuite.eu/WS-0002.pdf');
    expect(html).toContain('https://pay.weldsuite.eu/WS-0002');
    expect(html).toContain(`${c.history.mollie} · ${c.history.kinds.renewal}`);
    expect(html).toContain('other');
    expect(html).not.toContain(`>${t.invoices.void}<`);
    expect(html).not.toContain(`>${t.payments.refund}<`);
  });

  it('points staff at the refund command', () => {
    const html = card([], [payment({ id: 'bpy_1', provider: 'mollie', providerPaymentId: 'tr_1', kind: 'addon' })]);
    expect(html).toContain(c.history.refundHint.split(':')[0]);
    expect(html).toContain(c.history.kinds.addon);
  });
});
