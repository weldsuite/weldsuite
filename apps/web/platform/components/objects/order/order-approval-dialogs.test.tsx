import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Order } from '@/hooks/queries/use-commerce-orders-queries';

const env = vi.hoisted(() => ({
  approve: vi.fn(),
  reject: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
}));

vi.mock('sonner', () => ({ toast: { success: env.success, error: env.error } }));
vi.mock('@/hooks/queries/use-commerce-buyers-queries', () => ({
  useApproveCommerceOrder: () => ({ mutateAsync: env.approve }),
  useRejectCommerceOrder: () => ({ mutateAsync: env.reject }),
}));

import { ApprovalDecisionDialog } from './order-approval-dialogs';

const order = { id: 'ord_1', orderNumber: 'WC-1001' } as Order;
const notPending = { status: 409, body: { error: { code: 'NOT_PENDING', message: 'raw' } } };

function setup(decision: 'approve' | 'reject') {
  const onOpenChange = vi.fn();
  render(<ApprovalDecisionDialog order={order} decision={decision} open onOpenChange={onOpenChange} />);
  return { onOpenChange, user: userEvent.setup() };
}

beforeEach(() => {
  for (const fn of Object.values(env)) fn.mockReset();
  env.approve.mockResolvedValue({});
  env.reject.mockResolvedValue({});
});

describe('ApprovalDecisionDialog', () => {
  it('approves, says so and closes', async () => {
    const { user, onOpenChange } = setup('approve');
    await user.click(screen.getByRole('button', { name: 'Approve order' }));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(env.approve).toHaveBeenCalledWith({ id: 'ord_1', data: undefined });
    expect(env.success).toHaveBeenCalledWith('Order approved');
  });

  it('warns that a rejection cannot be undone and rejects with the comment', async () => {
    const { user, onOpenChange } = setup('reject');
    expect(screen.getByText(/This cannot be undone/)).toBeTruthy();
    await user.type(screen.getByLabelText('Comment (optional)'), 'Not on our list');
    await user.click(screen.getByRole('button', { name: 'Reject order' }));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(env.reject).toHaveBeenCalledWith({ id: 'ord_1', data: { comment: 'Not on our list' } });
    expect(env.success).toHaveBeenCalledWith('Order rejected');
  });

  it('says NOT_PENDING in words and closes, as somebody decided first', async () => {
    env.approve.mockRejectedValue(notPending);
    const { user, onOpenChange } = setup('approve');
    await user.click(screen.getByRole('button', { name: 'Approve order' }));
    await waitFor(() => expect(env.error).toHaveBeenCalledWith(expect.stringContaining('no longer waiting for approval')));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('keeps the dialog open on another failure, so the comment is not lost', async () => {
    env.reject.mockRejectedValue(new Error('network down'));
    const { user, onOpenChange } = setup('reject');
    await user.click(screen.getByRole('button', { name: 'Reject order' }));
    await waitFor(() => expect(env.error).toHaveBeenCalledWith('network down'));
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it('is cancelled with the safe button', async () => {
    const { user, onOpenChange } = setup('reject');
    await user.click(screen.getByRole('button', { name: 'Keep waiting' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(env.reject).not.toHaveBeenCalled();
  });
});
