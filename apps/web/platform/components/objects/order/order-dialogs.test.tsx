import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Order } from '@/hooks/queries/use-commerce-orders-queries';

const env = vi.hoisted(() => ({
  cancel: vi.fn(),
  markPaid: vi.fn(),
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));

vi.mock('sonner', () => ({ toast }));
vi.mock('@/hooks/queries/use-commerce-orders-queries', () => ({
  useCancelCommerceOrder: () => ({ mutateAsync: env.cancel }),
  useMarkCommerceOrderPaid: () => ({ mutateAsync: env.markPaid }),
}));

import { CancelOrderDialog, MarkPaidDialog } from './order-dialogs';

const order = { id: 'ord_1', orderNumber: 'WC-1001', total: '125.00', currency: 'EUR' } as Order;

beforeEach(() => {
  env.cancel.mockReset();
  env.cancel.mockResolvedValue({ data: {} });
  env.markPaid.mockReset();
  env.markPaid.mockResolvedValue({ data: {} });
  toast.success.mockReset();
  toast.error.mockReset();
});

describe('CancelOrderDialog', () => {
  it('asks before cancelling and sends the reason', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    render(<CancelOrderDialog order={order} open onOpenChange={onOpenChange} />);
    expect(screen.getByRole('dialog', { name: 'Cancel order WC-1001?' })).toBeTruthy();

    await user.type(screen.getByLabelText('Reason (optional)'), 'Customer changed their mind');
    await user.click(screen.getByRole('button', { name: 'Cancel order' }));

    expect(env.cancel).toHaveBeenCalledWith({ id: 'ord_1', reason: 'Customer changed their mind' });
    expect(toast.success).toHaveBeenCalledWith('Order cancelled');
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('cancels without a reason when none is given', async () => {
    const user = userEvent.setup();
    render(<CancelOrderDialog order={order} open onOpenChange={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'Cancel order' }));
    expect(env.cancel).toHaveBeenCalledWith({ id: 'ord_1', reason: undefined });
  });

  it('keeps the order when the member backs out', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    render(<CancelOrderDialog order={order} open onOpenChange={onOpenChange} />);
    await user.click(screen.getByRole('button', { name: 'Keep order' }));
    expect(env.cancel).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('says why a refused cancel was refused and stays open', async () => {
    env.cancel.mockRejectedValue({ status: 409, body: { error: { code: 'ORDER_NOT_CANCELLABLE', message: 'x' } } });
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    render(<CancelOrderDialog order={order} open onOpenChange={onOpenChange} />);
    await user.click(screen.getByRole('button', { name: 'Cancel order' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(String(toast.error.mock.calls[0][0])).toContain('can no longer be cancelled');
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });
});

describe('MarkPaidDialog', () => {
  it('records the payment with its method and reference', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    render(<MarkPaidDialog order={order} open onOpenChange={onOpenChange} />);
    expect(screen.getByText(/payment of .*125\.00 has arrived/)).toBeTruthy();

    await user.type(screen.getByLabelText('Payment method'), 'Bank transfer');
    await user.type(screen.getByLabelText('Payment reference'), 'TRX-1');
    await user.click(screen.getByRole('button', { name: 'Mark as paid' }));

    await waitFor(() => expect(env.markPaid).toHaveBeenCalled());
    const call = env.markPaid.mock.calls[0][0] as { id: string; data: { paidAt?: string; paymentMethod?: string; paymentReference?: string } };
    expect(call.id).toBe('ord_1');
    expect(call.data.paymentMethod).toBe('Bank transfer');
    expect(call.data.paymentReference).toBe('TRX-1');
    expect(call.data.paidAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(toast.success).toHaveBeenCalledWith('Order marked as paid');
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('leaves out a blank method and reference', async () => {
    const user = userEvent.setup();
    render(<MarkPaidDialog order={order} open onOpenChange={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'Mark as paid' }));
    await waitFor(() => expect(env.markPaid).toHaveBeenCalled());
    const data = (env.markPaid.mock.calls[0][0] as { data: Record<string, unknown> }).data;
    expect(data.paymentMethod).toBeUndefined();
    expect(data.paymentReference).toBeUndefined();
  });

  it('says that the order is already paid', async () => {
    env.markPaid.mockRejectedValue({ status: 409, body: { error: { code: 'ALREADY_PAID', message: 'x' } } });
    const user = userEvent.setup();
    render(<MarkPaidDialog order={order} open onOpenChange={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'Mark as paid' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('This order is already paid.'));
  });
});
