import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Order } from '@/hooks/queries/use-commerce-orders-queries';

const env = vi.hoisted(() => ({
  allowed: new Set<string>(['orders:update']),
  update: vi.fn(),
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));

vi.mock('sonner', () => ({ toast }));
vi.mock('@weldsuite/permissions/react', () => ({
  usePermissionsMaybe: () => ({ can: (permission: string) => env.allowed.has(permission) }),
}));
vi.mock('@/hooks/queries/use-commerce-orders-queries', () => ({
  useUpdateCommerceOrder: () => ({ mutateAsync: env.update, isPending: false }),
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
