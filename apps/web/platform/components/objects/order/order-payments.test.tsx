import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Order } from '@/hooks/queries/use-commerce-orders-queries';
import type { OrderPayment, OrderRefund } from '@/hooks/queries/use-commerce-payments-queries';

const env = vi.hoisted(() => ({
  query: { isPending: false, isError: false, data: undefined } as {
    isPending: boolean;
    isError: boolean;
    data?: { data: { payments: unknown[]; refunds: unknown[] } };
  },
  open: vi.fn(),
}));

vi.mock('@/components/object-panel', () => ({ useObjectPanel: () => ({ open: env.open }) }));
vi.mock('@/hooks/queries/use-commerce-payments-queries', () => ({ useOrderPayments: () => env.query }));

import { PaymentsSection } from './order-payments';

const order = (over: Partial<Order> = {}): Order =>
  ({ id: 'ord_1', currency: 'EUR', total: '100.00', amountPaid: '0.00', amountRefunded: '0.00', ...over }) as Order;

const payment = (over: Partial<OrderPayment> = {}): OrderPayment => ({
  id: 'pay_1',
  provider: 'mollie',
  providerPaymentId: 'tr_1',
  status: 'paid',
  amount: '100.00',
  amountRefunded: '0.00',
  currency: 'EUR',
  method: 'ideal',
  checkoutUrl: null,
  testmode: false,
  failureReason: null,
  createdAt: '2026-11-20T10:00:00.000Z',
  paidAt: '2026-11-20T10:05:00.000Z',
  failedAt: null,
  expiredAt: null,
  ...over,
});

const refund = (over: Partial<OrderRefund> = {}): OrderRefund => ({
  id: 'ref_1',
  paymentId: 'pay_1',
  providerRefundId: 're_1',
  status: 'refunded',
  amount: '20.00',
  currency: 'EUR',
  reason: 'Damaged',
  creditNoteId: null,
  createdAt: '2026-11-21T10:00:00.000Z',
  refundedAt: '2026-11-21T10:01:00.000Z',
  ...over,
});

function give(payments: OrderPayment[], refunds: OrderRefund[] = []) {
  env.query = { isPending: false, isError: false, data: { data: { payments, refunds } } };
}

beforeEach(() => {
  env.query = { isPending: false, isError: false, data: undefined };
  env.open.mockReset();
});

describe('PaymentsSection', () => {
  it('shows a spinner while loading and an error when it fails', () => {
    env.query = { isPending: true, isError: false, data: undefined };
    const { rerender } = render(<PaymentsSection order={order()} />);
    expect(screen.getByRole('status')).toBeTruthy();
    env.query = { isPending: false, isError: true, data: undefined };
    rerender(<PaymentsSection order={order()} />);
    expect(screen.getByText('Could not load the payments.')).toBeTruthy();
  });

  it('says so when there are no payments', () => {
    give([]);
    render(<PaymentsSection order={order()} />);
    expect(screen.getByText('No online payments for this order yet.')).toBeTruthy();
  });

  it('lists an attempt with its status, method, amount and test badge', () => {
    give([payment({ testmode: true })]);
    render(<PaymentsSection order={order()} />);
    expect(screen.getByText('Paid')).toBeTruthy();
    expect(screen.getByText('Test')).toBeTruthy();
    expect(screen.getByText(/iDEAL/)).toBeTruthy();
    expect(screen.getByText(/100\.00/)).toBeTruthy();
  });

  it('shows how much of a payment has been refunded and why a payment failed', () => {
    give([payment({ amountRefunded: '20.00' }), payment({ id: 'pay_2', status: 'failed', failureReason: 'Card declined', paidAt: null })]);
    render(<PaymentsSection order={order()} />);
    expect(screen.getByText(/20\.00.* refunded/)).toBeTruthy();
    expect(screen.getByText('Card declined')).toBeTruthy();
  });

  it('shows paid, refunded and what can still be refunded', () => {
    give([payment()]);
    render(<PaymentsSection order={order({ amountPaid: '100.00', amountRefunded: '20.00' })} />);
    expect(screen.getByText('Can still be refunded').closest('div')?.textContent).toMatch(/80\.00/);
    expect(screen.getByText('Refunded').closest('div')?.textContent).toMatch(/20\.00/);
  });

  it('lists the refunds and opens the credit note in the panel stack', async () => {
    const user = userEvent.setup();
    give([payment()], [refund({ creditNoteId: 'inv_cn1' })]);
    render(<PaymentsSection order={order()} />);
    expect(screen.getByText(/Reason: Damaged/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Open the credit note' }));
    expect(env.open).toHaveBeenCalledWith({ type: 'invoice', id: 'inv_cn1', stack: true });
  });

  it('has no credit note link while the refund has none', () => {
    give([payment()], [refund({ status: 'processing', creditNoteId: null })]);
    render(<PaymentsSection order={order()} />);
    expect(screen.getByText('Processing')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Open the credit note' })).toBeNull();
  });

  it('warns when the WeldBooks invoice failed', () => {
    give([payment()]);
    render(<PaymentsSection order={order({ metadata: { invoiceError: 'No default legal entity' } })} />);
    expect(screen.getByText('The WeldBooks invoice could not be created')).toBeTruthy();
    expect(screen.getByText('No default legal entity')).toBeTruthy();
  });
});
