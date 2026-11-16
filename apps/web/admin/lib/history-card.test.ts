// The workspace billing history, rendered to markup (the admin tests run in
// node): Stripe rows keep their void and refund actions; the EU edition's
// WeldBooks invoices and Mollie charges show where they came from instead.

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { InvoiceRow, PaymentRow } from './billing-types';

const edition = vi.hoisted(() => ({ global: true }));
vi.mock('@/lib/edition', () => ({
  get GLOBAL() {
    return edition.global;
  },
}));
vi.mock('@/actions/billing', () => ({ refundPayment: vi.fn(), voidInvoice: vi.fn() }));

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

function card(invoices: InvoiceRow[], payments: PaymentRow[], canWrite = true): string {
  return renderToStaticMarkup(createElement(HistoryCard, { workspaceId: 'ws_1', invoices, payments, canWrite }));
}

describe('HistoryCard', () => {
  beforeEach(() => {
    edition.global = true;
  });

  it('keeps the Stripe actions on Stripe rows', () => {
    const html = card(
      [invoice({ status: 'open', pdfUrl: 'https://pay.stripe.com/invoice/acct/pdf' })],
      [payment({})],
    );
    expect(html).toContain('INV-0001');
    expect(html).toContain(`>${t.invoices.void}<`);
    expect(html).toContain(`>${t.payments.refund}<`);
    expect(html).not.toContain(c.history.weldbooks);
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
    // On Global there is no CLI to point at.
    expect(html).not.toContain(c.history.refundHint);
  });

  it('points staff at the refund command on Kubernetes', () => {
    edition.global = false;
    const html = card([], [payment({ id: 'bpy_1', provider: 'mollie', providerPaymentId: 'tr_1', kind: 'addon' })]);
    expect(html).toContain(c.history.refundHint.split(':')[0]);
    expect(html).toContain(c.history.kinds.addon);
  });
});
