import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Order } from '@/hooks/queries/use-commerce-orders-queries';

vi.mock('./order-form', () => ({
  OrderForm: ({ order, defaultCurrency, onSaved, onCancel }: { order: Order; defaultCurrency: string; onSaved: () => void; onCancel: () => void }) => (
    <div>
      <p data-testid="form">
        {order.id} {defaultCurrency}
      </p>
      <button type="button" onClick={onSaved}>
        saved
      </button>
      <button type="button" onClick={onCancel}>
        cancel
      </button>
    </div>
  ),
}));

import { OrderEditDialog } from './order-edit-dialog';

const order = { id: 'ord_1', orderNumber: 'WC-1001', currency: 'USD' } as Order;

describe('OrderEditDialog', () => {
  it('titles the dialog with the order number and edits the order in its own currency', () => {
    render(<OrderEditDialog order={order} open onOpenChange={vi.fn()} />);
    expect(screen.getByRole('dialog', { name: 'Edit order WC-1001' })).toBeTruthy();
    expect(screen.getByTestId('form').textContent).toBe('ord_1 USD');
  });

  it('closes when the order is saved or the edit is cancelled', async () => {
    const onOpenChange = vi.fn();
    const user = userEvent.setup();
    render(<OrderEditDialog order={order} open onOpenChange={onOpenChange} />);
    await user.click(screen.getByRole('button', { name: 'saved' }));
    await user.click(screen.getByRole('button', { name: 'cancel' }));
    expect(onOpenChange).toHaveBeenCalledTimes(2);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
