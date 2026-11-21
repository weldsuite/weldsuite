import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const env = vi.hoisted(() => ({
  mutateAsync: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('sonner', () => ({ toast: env.toast }));
vi.mock('@/hooks/queries/use-purchasing-queries', () => ({
  useMarkPurchaseOrderOrdered: () => ({ mutateAsync: env.mutateAsync, isPending: false }),
}));

import { MarkOrderedDialog } from './mark-ordered-dialog';

function renderDialog(expectedDate: string | null = '2026-12-01T00:00:00.000Z') {
  const onOpenChange = vi.fn();
  render(<MarkOrderedDialog open onOpenChange={onOpenChange} orderId="po_1" expectedDate={expectedDate} />);
  return onOpenChange;
}

const today = () => new Date().toISOString().slice(0, 10);

beforeEach(() => {
  env.mutateAsync.mockReset().mockResolvedValue({});
  env.toast.success.mockClear();
  env.toast.error.mockClear();
});

describe('MarkOrderedDialog', () => {
  it('starts with today as the order date and the order expected date', () => {
    renderDialog();
    expect(screen.getByLabelText('Order date')).toHaveValue(today());
    expect(screen.getByLabelText('Expected date')).toHaveValue('2026-12-01');
  });

  it('sends both dates as UTC midnights, toasts and closes', async () => {
    const user = userEvent.setup();
    const onOpenChange = renderDialog();
    await user.clear(screen.getByLabelText('Order date'));
    await user.type(screen.getByLabelText('Order date'), '2026-11-20');
    await user.click(screen.getByRole('button', { name: 'Mark as ordered' }));
    await waitFor(() =>
      expect(env.mutateAsync).toHaveBeenCalledWith({
        id: 'po_1',
        data: { orderDate: '2026-11-20T00:00:00.000Z', expectedDate: '2026-12-01T00:00:00.000Z' },
      }),
    );
    expect(env.toast.success).toHaveBeenCalledWith('Purchase order marked as ordered');
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('leaves the expected date out when empty, and uses today for an empty order date', async () => {
    const user = userEvent.setup();
    renderDialog(null);
    await user.clear(screen.getByLabelText('Order date'));
    await user.click(screen.getByRole('button', { name: 'Mark as ordered' }));
    await waitFor(() => expect(env.mutateAsync).toHaveBeenCalled());
    const data = env.mutateAsync.mock.calls[0][0].data;
    expect(data).not.toHaveProperty('expectedDate');
    expect(data.orderDate).toBe(`${today()}T00:00:00.000Z`);
  });

  it('shows the error and stays open when the request fails', async () => {
    env.mutateAsync.mockRejectedValue(new Error('Order is not approved'));
    const user = userEvent.setup();
    const onOpenChange = renderDialog();
    await user.click(screen.getByRole('button', { name: 'Mark as ordered' }));
    await waitFor(() => expect(env.toast.error).toHaveBeenCalledWith('Order is not approved'));
    expect(env.toast.success).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it('falls back to a generic message when the error has none', async () => {
    env.mutateAsync.mockRejectedValue(new Error(''));
    const user = userEvent.setup();
    renderDialog();
    await user.click(screen.getByRole('button', { name: 'Mark as ordered' }));
    await waitFor(() => expect(env.toast.error).toHaveBeenCalledWith('Could not mark the order as ordered'));
  });

  it('closes on cancel without sending anything', async () => {
    const user = userEvent.setup();
    const onOpenChange = renderDialog();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(env.mutateAsync).not.toHaveBeenCalled();
  });
});
