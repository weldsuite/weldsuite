import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Order, OrderApproval } from '@/hooks/queries/use-commerce-orders-queries';

const env = vi.hoisted(() => ({
  canUpdate: true,
  approve: vi.fn(),
  reject: vi.fn(),
}));

vi.mock('@weldsuite/permissions/react', () => ({ usePermissionsMaybe: () => ({ can: () => env.canUpdate }) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/hooks/queries/use-commerce-buyers-queries', () => ({
  useApproveCommerceOrder: () => ({ mutateAsync: env.approve }),
  useRejectCommerceOrder: () => ({ mutateAsync: env.reject }),
}));

import { ApprovalSection } from './order-approval';

const approval = (over: Partial<OrderApproval> = {}): OrderApproval => ({
  status: 'pending',
  reason: 'buyer_limit',
  requestedBy: { personId: 'per_1', name: 'Jan de Vries' },
  decidedBy: null,
  decidedAt: null,
  comment: null,
  ...over,
});

const order = (over: Partial<OrderApproval> | null = {}): Order =>
  ({ id: 'ord_1', orderNumber: 'WC-1001', approval: over === null ? null : approval(over) }) as Order;

beforeEach(() => {
  env.canUpdate = true;
  env.approve.mockReset();
  env.reject.mockReset();
  env.approve.mockResolvedValue({});
  env.reject.mockResolvedValue({});
});

describe('ApprovalSection', () => {
  it('stays out for an order that never needed approval', () => {
    const { container } = render(<ApprovalSection order={order(null)} />);
    expect(container.firstChild).toBeNull();
  });

  it('shows a pending approval: the state, why, who asked, and the hold', () => {
    render(<ApprovalSection order={order()} />);
    expect(screen.getByRole('heading', { name: 'Approval' })).toBeTruthy();
    expect(screen.getByText('Awaiting approval')).toBeTruthy();
    expect(screen.getByText("The order total is above the buyer's spend limit.")).toBeTruthy();
    expect(screen.getByText('Requested by')).toBeTruthy();
    expect(screen.getByText('Jan de Vries')).toBeTruthy();
    expect(screen.getByText(/It is not released to the warehouse/)).toBeTruthy();
    expect(screen.queryByText('Decided by')).toBeNull();
  });

  it('says the company threshold as the reason when that was it', () => {
    render(<ApprovalSection order={order({ reason: 'company_threshold' })} />);
    expect(screen.getByText("The order total is above the company's approval threshold.")).toBeTruthy();
  });

  it('shows who decided, when and the comment on a decided approval, and offers no buttons', () => {
    render(
      <ApprovalSection
        order={order({
          status: 'rejected',
          decidedBy: { userId: 'usr_1', name: 'Eva Staff' },
          decidedAt: '2026-11-21T09:00:00.000Z',
          comment: 'Too expensive',
        })}
      />,
    );
    expect(screen.getByText('Rejected')).toBeTruthy();
    expect(screen.getByText('Decided by')).toBeTruthy();
    expect(screen.getByText('Eva Staff')).toBeTruthy();
    expect(screen.getByText('Decided on')).toBeTruthy();
    expect(screen.getByText('Too expensive')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Reject' })).toBeNull();
  });

  it('offers Approve and Reject on a pending approval to a member who may update orders', () => {
    render(<ApprovalSection order={order()} />);
    expect(screen.getByRole('button', { name: 'Approve' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Reject' })).toBeTruthy();
  });

  it('hides both buttons without orders:update', () => {
    env.canUpdate = false;
    render(<ApprovalSection order={order()} />);
    expect(screen.getByText('Awaiting approval')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Reject' })).toBeNull();
  });

  it('approves after a confirmation, with the comment', async () => {
    const user = userEvent.setup();
    render(<ApprovalSection order={order()} />);
    await user.click(screen.getByRole('button', { name: 'Approve' }));
    expect(await screen.findByText('Approve order WC-1001?')).toBeTruthy();
    expect(env.approve).not.toHaveBeenCalled();
    await user.type(screen.getByLabelText('Comment (optional)'), ' Go ahead ');
    await user.click(screen.getByRole('button', { name: 'Approve order' }));
    expect(env.approve).toHaveBeenCalledWith({ id: 'ord_1', data: { comment: 'Go ahead' } });
    expect(env.reject).not.toHaveBeenCalled();
  });

  it('rejects after a confirmation, without a comment when none is typed', async () => {
    const user = userEvent.setup();
    render(<ApprovalSection order={order()} />);
    await user.click(screen.getByRole('button', { name: 'Reject' }));
    expect(await screen.findByText('Reject order WC-1001?')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Reject order' }));
    expect(env.reject).toHaveBeenCalledWith({ id: 'ord_1', data: undefined });
  });
});
