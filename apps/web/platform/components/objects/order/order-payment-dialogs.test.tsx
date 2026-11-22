import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Order } from '@/hooks/queries/use-commerce-orders-queries';

const env = vi.hoisted(() => ({
  payments: [] as unknown[],
  createLink: vi.fn(),
  refund: vi.fn(),
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));

vi.mock('sonner', () => ({ toast }));
vi.mock('@/hooks/queries/use-commerce-payments-queries', () => ({
  useOrderPayments: () => ({ data: { data: { payments: env.payments, refunds: [] } } }),
  useCreatePaymentLink: () => ({ mutateAsync: env.createLink, isPending: false }),
  useCreateRefund: () => ({ mutateAsync: env.refund, isPending: false }),
}));

import { PaymentLinkDialog, RefundDialog } from './order-payment-dialogs';

const order = (over: Partial<Order> = {}): Order =>
  ({
    id: 'ord_1',
    orderNumber: 'WC-1001',
    currency: 'EUR',
    total: '100.00',
    amountPaid: '60.00',
    amountRefunded: '10.00',
    ...over,
  }) as Order;

const apiError = (status: number, code: string, details?: Record<string, unknown>, message = 'server words') => ({
  status,
  body: { error: { code, message, details } },
});

beforeEach(() => {
  env.payments = [];
  env.createLink.mockReset();
  env.refund.mockReset();
  env.refund.mockResolvedValue({ data: {} });
  toast.success.mockReset();
  toast.error.mockReset();
});

describe('PaymentLinkDialog', () => {
  it('names what the customer still owes and creates the link on request', async () => {
    env.createLink.mockResolvedValue({ data: { id: 'pay_9', status: 'open', checkoutUrl: 'https://www.mollie.com/checkout/abc', testmode: false } });
    const user = userEvent.setup();
    render(<PaymentLinkDialog order={order()} open onOpenChange={vi.fn()} />);
    expect(screen.getByText(/outstanding amount of .*40\.00/)).toBeTruthy();
    expect(screen.queryByTestId('payment-link')).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Create link' }));
    expect(env.createLink).toHaveBeenCalledWith('ord_1');
    expect(((await screen.findByTestId('payment-link')) as HTMLTextAreaElement).value).toBe('https://www.mollie.com/checkout/abc');
    expect(toast.success).toHaveBeenCalledWith('Payment link created');
    expect(screen.getByRole('link', { name: 'Open the link' }).getAttribute('href')).toBe('https://www.mollie.com/checkout/abc');
    // Once made, the button to make another one is gone.
    expect(screen.queryByRole('button', { name: 'Create link' })).toBeNull();
  });

  it('copies the link and says so', async () => {
    env.payments = [{ id: 'pay_1', status: 'open', checkoutUrl: 'https://www.mollie.com/checkout/old', testmode: false }];
    const user = userEvent.setup();
    render(<PaymentLinkDialog order={order()} open onOpenChange={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'Copy Payment link' }));
    expect(await navigator.clipboard.readText()).toBe('https://www.mollie.com/checkout/old');
    expect(await screen.findAllByText('Copied')).not.toHaveLength(0);
  });

  it('shows an open payment link that already exists, and offers a new one', async () => {
    env.payments = [{ id: 'pay_1', status: 'open', checkoutUrl: 'https://www.mollie.com/checkout/old', testmode: true }];
    const user = userEvent.setup();
    render(<PaymentLinkDialog order={order()} open onOpenChange={vi.fn()} />);
    expect(screen.getByText(/already has an open payment link/)).toBeTruthy();
    expect((screen.getByTestId('payment-link') as HTMLTextAreaElement).value).toBe('https://www.mollie.com/checkout/old');
    expect(screen.getByText('This is a test payment: no real money moves.')).toBeTruthy();
    env.createLink.mockResolvedValue({ data: { id: 'pay_2', status: 'open', checkoutUrl: 'https://www.mollie.com/checkout/new', testmode: false } });
    await user.click(screen.getByRole('button', { name: 'Create a new link' }));
    expect(((await screen.findByTestId('payment-link')) as HTMLTextAreaElement).value).toBe('https://www.mollie.com/checkout/new');
  });

  it('ignores a link that is not https', () => {
    env.payments = [{ id: 'pay_1', status: 'open', checkoutUrl: 'javascript:alert(1)', testmode: false }];
    render(<PaymentLinkDialog order={order()} open onOpenChange={vi.fn()} />);
    expect(screen.queryByTestId('payment-link')).toBeNull();
  });

  it('words a refusal', async () => {
    env.createLink.mockRejectedValue(apiError(409, 'PAYMENT_PROVIDER_NOT_CONNECTED'));
    const user = userEvent.setup();
    render(<PaymentLinkDialog order={order()} open onOpenChange={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'Create link' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('Mollie is not connected')));
  });
});

describe('RefundDialog', () => {
  it('starts with what can still be refunded', () => {
    render(<RefundDialog order={order()} open onOpenChange={vi.fn()} />);
    expect((screen.getByLabelText(/Amount/) as HTMLInputElement).value).toBe('50.00');
  });

  it('refunds the amount and the reason, then closes', async () => {
    const onOpenChange = vi.fn();
    const user = userEvent.setup();
    render(<RefundDialog order={order()} open onOpenChange={onOpenChange} />);
    await user.clear(screen.getByLabelText(/Amount/));
    await user.type(screen.getByLabelText(/Amount/), '12.5');
    await user.type(screen.getByLabelText('Reason (optional)'), ' Damaged ');
    await user.click(screen.getByRole('button', { name: 'Refund' }));
    await waitFor(() => expect(env.refund).toHaveBeenCalled());
    expect(env.refund).toHaveBeenCalledWith({ orderId: 'ord_1', data: { amount: '12.50', reason: 'Damaged' } });
    expect(toast.success).toHaveBeenCalledWith(expect.stringContaining('12.50'));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('leaves the reason out when blank', async () => {
    const user = userEvent.setup();
    render(<RefundDialog order={order()} open onOpenChange={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'Refund' }));
    await waitFor(() => expect(env.refund).toHaveBeenCalled());
    expect(env.refund).toHaveBeenCalledWith({ orderId: 'ord_1', data: { amount: '50.00' } });
  });

  it.each([
    ['abc', 'Enter an amount such as 12.50.'],
    ['0', 'Enter an amount above zero.'],
    ['50.01', /You can refund at most .*50\.00/],
  ])('refuses %s without asking the server', async (value, message) => {
    const user = userEvent.setup();
    render(<RefundDialog order={order()} open onOpenChange={vi.fn()} />);
    await user.clear(screen.getByLabelText(/Amount/));
    await user.type(screen.getByLabelText(/Amount/), value);
    await user.click(screen.getByRole('button', { name: 'Refund' }));
    expect(await screen.findByText(message)).toBeTruthy();
    expect(env.refund).not.toHaveBeenCalled();
  });

  it('puts REFUND_TOO_LARGE on the amount with what is left', async () => {
    env.refund.mockRejectedValue(apiError(409, 'REFUND_TOO_LARGE', { refundable: '30.00' }));
    const user = userEvent.setup();
    render(<RefundDialog order={order()} open onOpenChange={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'Refund' }));
    expect(await screen.findByText(/You can refund at most .*30\.00/)).toBeTruthy();
    expect(screen.getByLabelText(/Amount/).getAttribute('aria-invalid')).toBe('true');
    expect(toast.error).not.toHaveBeenCalled();
  });

  it.each([
    ['NOTHING_TO_REFUND', 409, 'There is nothing left to refund on this order.'],
    ['PAYMENT_PROVIDER_NOT_CONNECTED', 409, 'Mollie is not connected. Connect it in Settings, under Apps, WeldCommerce, Payments.'],
    ['PROVIDER_ERROR', 502, 'Mollie refused this: server words'],
  ])('words %s in a toast and stays open', async (code, status, text) => {
    env.refund.mockRejectedValue(apiError(status, code));
    const onOpenChange = vi.fn();
    const user = userEvent.setup();
    render(<RefundDialog order={order()} open onOpenChange={onOpenChange} />);
    await user.click(screen.getByRole('button', { name: 'Refund' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(text));
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });
});
