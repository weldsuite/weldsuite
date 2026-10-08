import { describe, expect, it, vi } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';
import type { PaymentRunDetail } from '@/lib/api/domains/weldbooks-payment-runs';
import { renderWithProviders } from '../test-utils';
import { ApprovalControls } from './approval-controls';

const at = '2026-10-08T10:00:00.000Z';

function makeRun(overrides: Partial<PaymentRunDetail> = {}): PaymentRunDetail {
  return {
    id: 'prn_1',
    bankAccountId: 'bnk_1',
    bankAccountName: 'Operating',
    method: 'ach',
    status: 'pending_approval',
    paymentDate: '2026-10-09',
    secCode: null,
    sameDay: false,
    totalAmount: '350.50',
    paymentCount: 1,
    requiredApprovals: 2,
    approvalCount: 0,
    billCount: 2,
    heldVendorCount: 0,
    fileName: null,
    fileGeneratedAt: null,
    createdBy: 'user_maker',
    createdAt: at,
    updatedAt: at,
    notes: null,
    bankAccount: { id: 'bnk_1', name: 'Operating', accountNumberLast4: '1234' },
    heldAmount: '0.00',
    withheldAmount: '0.00',
    netAmount: '350.50',
    approvals: [],
    items: [],
    vendors: [],
    holds: [],
    history: [],
    ...overrides,
  };
}

function setup(run: PaymentRunDetail, userId: string | null, canManage = true, busy = false) {
  const onApprove = vi.fn();
  const onReject = vi.fn();
  renderWithProviders(<ApprovalControls run={run} userId={userId} canManage={canManage} busy={busy} onApprove={onApprove} onReject={onReject} />);
  return { onApprove, onReject };
}

describe('ApprovalControls', () => {
  it('lets the maker approve a two-approval run first and says a second person is still needed', () => {
    const { onApprove } = setup(makeRun(), 'user_maker');
    const button = screen.getByRole('button', { name: 'Approve' });
    expect(button).toBeEnabled();
    expect(screen.getByText(/a second person has to approve it too/)).toBeInTheDocument();
    fireEvent.click(button);
    expect(onApprove).toHaveBeenCalledTimes(1);
  });

  it('disables approving for someone who already approved and says why', () => {
    const run = makeRun({ approvals: [{ userId: 'user_a', at }] });
    setup(run, 'user_a');
    expect(screen.getByRole('button', { name: 'Approve' })).toBeDisabled();
    expect(screen.getByText(/already approved this run/)).toBeInTheDocument();
  });

  it('lets another manager give the second approval', () => {
    const run = makeRun({ approvals: [{ userId: 'user_a', at }] });
    setup(run, 'user_b');
    expect(screen.getByRole('button', { name: 'Approve' })).toBeEnabled();
  });

  it('offers to finish an interrupted approval when every approval is in', () => {
    const run = makeRun({ approvals: [{ userId: 'user_a', at }, { userId: 'user_b', at }] });
    const { onApprove } = setup(run, 'user_a');
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
    const finish = screen.getByRole('button', { name: 'Finish approval' });
    expect(finish).toBeEnabled();
    expect(screen.getByText(/payments were not all made/)).toBeInTheDocument();
    // Rejecting would orphan the payments already made, so it is not offered.
    expect(screen.queryByRole('button', { name: 'Reject' })).not.toBeInTheDocument();
    fireEvent.click(finish);
    expect(onApprove).toHaveBeenCalledTimes(1);
  });

  it('turns everything off without permission to manage banking', () => {
    setup(makeRun(), 'user_a', false);
    expect(screen.getByRole('button', { name: 'Approve' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Reject' })).not.toBeInTheDocument();
    expect(screen.getByText(/permission to manage banking/)).toBeInTheDocument();
  });

  it('rejects through its callback', () => {
    const { onReject } = setup(makeRun({ approvals: [{ userId: 'user_a', at }] }), 'user_b');
    fireEvent.click(screen.getByRole('button', { name: 'Reject' }));
    expect(onReject).toHaveBeenCalledTimes(1);
  });

  it('shows nothing when the run is not waiting for approval', () => {
    setup(makeRun({ status: 'approved' }), 'user_a');
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('does not allow a second click while an approval is on its way', () => {
    setup(makeRun(), 'user_a', true, true);
    expect(screen.getByRole('button', { name: 'Approve' })).toBeDisabled();
  });
});
