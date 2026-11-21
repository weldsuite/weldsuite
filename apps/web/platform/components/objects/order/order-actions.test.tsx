import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Order } from '@/hooks/queries/use-commerce-orders-queries';

const env = vi.hoisted(() => ({
  allowed: new Set<string>(['orders:update']),
  update: vi.fn(),
  retryInvoice: vi.fn(),
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));

vi.mock('sonner', () => ({ toast }));
vi.mock('@weldsuite/permissions/react', () => ({
  usePermissionsMaybe: () => ({ can: (permission: string) => env.allowed.has(permission) }),
}));
vi.mock('@/hooks/queries/use-commerce-orders-queries', () => ({
  useUpdateCommerceOrder: () => ({ mutateAsync: env.update, isPending: false }),
}));
vi.mock('@/hooks/queries/use-commerce-payments-queries', () => ({
  useRetryOrderInvoice: () => ({ mutateAsync: env.retryInvoice, isPending: false }),
}));
vi.mock('./order-payment-dialogs', () => ({
  PaymentLinkDialog: () => <div role="dialog">link dialog</div>,
  RefundDialog: () => <div role="dialog">refund dialog</div>,
}));
vi.mock('@/app/weldcommerce/orders/components/order-edit-dialog', () => ({
  OrderEditDialog: () => <div role="dialog">edit dialog</div>,
}));
vi.mock('./order-dialogs', () => ({
  CancelOrderDialog: () => <div role="dialog">cancel dialog</div>,
  MarkPaidDialog: () => <div role="dialog">paid dialog</div>,
}));

import { OrderActions, canMarkPaid } from './order-actions';

function order(overrides: Partial<Order> = {}): Order {
  return {
    id: 'ord_1',
    orderNumber: 'WC-1001',
    status: 'pending',
    paymentStatus: 'pending',
    editable: true,
    cancellable: true,
    ...overrides,
  } as Order;
}

beforeEach(() => {
  env.allowed = new Set(['orders:update']);
  env.update.mockReset();
  env.retryInvoice.mockReset();
  env.retryInvoice.mockResolvedValue({ data: { id: 'inv_1', number: 'INV-7', status: 'finalised' } });
  env.update.mockResolvedValue({ data: {} });
  toast.success.mockReset();
  toast.error.mockReset();
});

describe('canMarkPaid', () => {
  it('is for orders that can still be paid', () => {
    expect(canMarkPaid(order())).toBe(true);
    expect(canMarkPaid(order({ paymentStatus: 'on_invoice' }))).toBe(true);
    expect(canMarkPaid(order({ paymentStatus: 'paid' }))).toBe(false);
    expect(canMarkPaid(order({ paymentStatus: 'refunded' }))).toBe(false);
    expect(canMarkPaid(order({ status: 'cancelled' }))).toBe(false);
  });
});

describe('OrderActions', () => {
  it('shows nothing to a member who may not update orders', () => {
    env.allowed = new Set(['orders:read']);
    const { container } = render(<OrderActions order={order()} />);
    expect(container.textContent).toBe('');
  });

  it('takes a pending order to confirmed, saying so', async () => {
    const user = userEvent.setup();
    render(<OrderActions order={order()} />);
    await user.click(screen.getByRole('button', { name: 'Confirm order' }));
    expect(env.update).toHaveBeenCalledWith({ id: 'ord_1', data: { status: 'confirmed' } });
    expect(toast.success).toHaveBeenCalledWith('Order confirmed');
  });

  it.each([
    ['confirmed', 'Start processing', 'processing'],
    ['processing', 'Mark as completed', 'completed'],
  ] as const)('offers the next step of a %s order', async (status, label, next) => {
    const user = userEvent.setup();
    render(<OrderActions order={order({ status })} />);
    await user.click(screen.getByRole('button', { name: label }));
    expect(env.update).toHaveBeenCalledWith({ id: 'ord_1', data: { status: next } });
  });

  it('words a refused step instead of failing silently', async () => {
    env.update.mockRejectedValue({ status: 409, body: { error: { code: 'ORDER_NOT_EDITABLE', message: 'x' } } });
    const user = userEvent.setup();
    render(<OrderActions order={order()} />);
    await user.click(screen.getByRole('button', { name: 'Confirm order' }));
    expect(toast.error).toHaveBeenCalledWith('This order can no longer be changed.');
  });

  it.each([
    ['Edit order', 'edit dialog'],
    ['Mark as paid', 'paid dialog'],
    ['Cancel order', 'cancel dialog'],
  ])('opens the dialog of %s', async (button, dialog) => {
    const user = userEvent.setup();
    render(<OrderActions order={order()} />);
    await user.click(screen.getByRole('button', { name: button }));
    expect(screen.getByText(dialog)).toBeTruthy();
  });

  describe('payments', () => {
    it('offers a payment link for an unpaid order, and opens its dialog', async () => {
      const user = userEvent.setup();
      render(<OrderActions order={order()} />);
      await user.click(screen.getByRole('button', { name: 'Payment link' }));
      expect(screen.getByText('link dialog')).toBeTruthy();
    });

    it.each([
      ['paid', 'paid'],
      ['on invoice', 'on_invoice'],
    ] as const)('has no payment link for an order that is %s', (_label, paymentStatus) => {
      render(<OrderActions order={order({ paymentStatus })} />);
      expect(screen.queryByRole('button', { name: 'Payment link' })).toBeNull();
    });

    it('offers a refund while something is left, and not once everything went back', async () => {
      const user = userEvent.setup();
      const { rerender } = render(<OrderActions order={order({ paymentStatus: 'paid', amountPaid: '50.00', amountRefunded: '10.00' })} />);
      await user.click(screen.getByRole('button', { name: 'Refund' }));
      expect(screen.getByText('refund dialog')).toBeTruthy();
      rerender(<OrderActions order={order({ paymentStatus: 'refunded', amountPaid: '50.00', amountRefunded: '50.00' })} />);
      expect(screen.queryByRole('button', { name: 'Refund' })).toBeNull();
    });

    it('offers Create invoice only when the invoice failed, and says which invoice it made', async () => {
      const user = userEvent.setup();
      const { rerender } = render(<OrderActions order={order({ paymentStatus: 'paid' })} />);
      expect(screen.queryByRole('button', { name: 'Create invoice' })).toBeNull();
      rerender(<OrderActions order={order({ paymentStatus: 'paid', metadata: { invoiceError: 'No default entity' } })} />);
      await user.click(screen.getByRole('button', { name: 'Create invoice' }));
      expect(env.retryInvoice).toHaveBeenCalledWith('ord_1');
      expect(toast.success).toHaveBeenCalledWith('Invoice INV-7 created');
    });

    it('words a failed invoice retry', async () => {
      env.retryInvoice.mockRejectedValue(new Error('WeldBooks down'));
      const user = userEvent.setup();
      render(<OrderActions order={order({ paymentStatus: 'paid', metadata: { invoiceError: 'x' } })} />);
      await user.click(screen.getByRole('button', { name: 'Create invoice' }));
      expect(toast.error).toHaveBeenCalledWith('WeldBooks down');
    });
  });

  it('hides Cancel when the order cannot be cancelled and explains a locked order', () => {
    render(<OrderActions order={order({ cancellable: false, editable: false, status: 'processing', paymentStatus: 'paid' })} />);
    expect(screen.queryByRole('button', { name: 'Cancel order' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Mark as paid' })).toBeNull();
    expect(screen.getByText(/can no longer change/)).toBeTruthy();
    // Addresses and notes can still be edited.
    expect(screen.getByRole('button', { name: 'Edit order' })).toBeTruthy();
  });

  it('has no step, payment or edit on a cancelled order', () => {
    render(<OrderActions order={order({ status: 'cancelled', cancellable: false, editable: false })} />);
    expect(screen.queryByRole('button')).toBeNull();
  });
});
