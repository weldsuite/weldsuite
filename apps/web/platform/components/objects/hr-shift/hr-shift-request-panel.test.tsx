import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { HrShiftRequest } from '@weldsuite/app-api-client/domains/weldhr';

const reviewAsync = vi.fn();
const toastError = vi.fn();
const toastSuccess = vi.fn();
const permissions = new Set<string>();
/** What the request lists have loaded: the request, nothing yet (undefined) or no such request (null). */
let loadedRequest: HrShiftRequest | null | undefined;
let reviewPending = false;

vi.mock('@/components/object-panel', () => import('@/components/objects/_shared/object-panel-test-mock'));
vi.mock('@weldsuite/permissions/react', () => ({
  usePermissions: () => ({ can: (permission: string) => permissions.has(permission) }),
}));
vi.mock('sonner', () => ({
  toast: { success: (message: string) => toastSuccess(message), error: (message: string) => toastError(message) },
}));
vi.mock('@/app/weldcalendar/lib/calendar-format', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/app/weldcalendar/lib/calendar-format')>()),
  useTimeFormat: () => '24h',
}));
vi.mock('@/hooks/queries/use-weldhr-queries', () => ({
  useLoadedHrShiftRequest: () => loadedRequest,
  useReviewHrShiftRequest: () => ({ mutateAsync: reviewAsync, isPending: reviewPending }),
}));
vi.mock('@/app/weldhr/attendance/components/shift-request-decline-dialog', () => ({
  ShiftRequestDeclineDialog: ({
    summary,
    onConfirm,
    onClose,
  }: {
    summary: string;
    onConfirm: (note: string | null) => Promise<boolean>;
    onClose: () => void;
  }) => (
    <div role="dialog" aria-label="Decline request">
      <p>{summary}</p>
      <button type="button" onClick={() => void onConfirm('Too short notice').then((done) => done && onClose())}>
        Send the decline
      </button>
      <button type="button" onClick={onClose}>
        Close the decline
      </button>
    </div>
  ),
}));

import { HrShiftRequestPanel } from './hr-shift-request-panel';
import { panelOpen } from '@/components/objects/_shared/object-panel-test-mock';
import { renderWithProviders } from '@/app/weldbooks/fixed-assets/test-utils';

function makeRequest(extra: Partial<HrShiftRequest> = {}): HrShiftRequest {
  return {
    id: 'req_1',
    employeeId: 'hremp_ann',
    employeeName: 'Ann Archer',
    openShiftId: null,
    startsAt: new Date(2026, 10, 18, 9, 0).toISOString(),
    endsAt: new Date(2026, 10, 18, 13, 30).toISOString(),
    workType: null,
    note: null,
    status: 'pending',
    shiftId: null,
    reviewedBy: null,
    reviewedByName: null,
    reviewedAt: null,
    reviewNote: null,
    createdAt: new Date(2026, 10, 10, 8, 0).toISOString(),
    ...extra,
  };
}

function renderPanel() {
  return renderWithProviders(
    <HrShiftRequestPanel id="req_1" isOpen onClose={vi.fn()} mode="fullscreen" onModeChange={vi.fn()} />,
  );
}

describe('HrShiftRequestPanel', () => {
  beforeEach(() => {
    reviewAsync.mockReset().mockResolvedValue({});
    toastError.mockReset();
    toastSuccess.mockReset();
    panelOpen.mockReset();
    permissions.clear();
    reviewPending = false;
    loadedRequest = makeRequest();
  });

  it('shows a proposed request that waits, without its review', () => {
    renderPanel();

    expect(screen.getByText('Ann Archer')).toBeInTheDocument();
    expect(screen.getByText(/09:00/)).toBeInTheDocument();
    expect(screen.getByText('Pending')).toBeInTheDocument();
    // Work type and note have no value; a pending request has no reviewer yet.
    expect(screen.getAllByText('—')).toHaveLength(2);
    expect(screen.queryByRole('button', { name: 'More actions' })).not.toBeInTheDocument();
  });

  it('shows the kind of a sign-up for an open shift, with its work type and note', () => {
    loadedRequest = makeRequest({ openShiftId: 'open_1', workType: 'Cashier', note: 'I can swap' });
    renderPanel();

    expect(screen.getAllByText('Cashier').length).toBeGreaterThan(0);
    expect(screen.getByText('I can swap')).toBeInTheDocument();
    expect(screen.queryByText('—')).not.toBeInTheDocument();
  });

  it('shows who reviewed a request that is no longer pending', () => {
    loadedRequest = makeRequest({
      status: 'rejected',
      reviewedByName: 'Bea Boss',
      reviewNote: 'Too short notice',
      reviewedAt: new Date(2026, 10, 11, 8, 0).toISOString(),
    });
    renderPanel();

    expect(screen.getByText('Bea Boss')).toBeInTheDocument();
    expect(screen.getByText('Too short notice')).toBeInTheDocument();
  });

  it('shows an empty reviewer line when an approved request has no reviewer on record', () => {
    loadedRequest = makeRequest({ status: 'approved' });
    renderPanel();

    expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(4);
  });

  it('never goes below zero minutes when the end lies before the start', () => {
    loadedRequest = makeRequest({ endsAt: new Date(2026, 10, 18, 8, 0).toISOString() });
    renderPanel();

    expect(screen.getByText('Ann Archer')).toBeInTheDocument();
  });

  it('opens the employee on top of the request', async () => {
    const user = userEvent.setup();
    renderPanel();

    await user.click(screen.getByRole('button', { name: 'Ann Archer' }));
    expect(panelOpen).toHaveBeenCalledWith({ type: 'hr_employee', id: 'hremp_ann', stack: true });
  });

  it('shows placeholders while the lists load, and says so when the request is gone', () => {
    loadedRequest = undefined;
    const { unmount } = renderPanel();
    expect(screen.queryByText('Ann Archer')).not.toBeInTheDocument();
    unmount();

    loadedRequest = null;
    renderPanel();
    expect(screen.queryByText('Ann Archer')).not.toBeInTheDocument();
    expect(screen.getByText(/not found|no longer|doesn.t exist/i)).toBeInTheDocument();
  });

  it('keeps the menu from a member who may not add shifts, and from a request already reviewed', () => {
    const first = renderPanel();
    expect(screen.queryByRole('button', { name: 'More actions' })).not.toBeInTheDocument();
    first.unmount();

    permissions.add('attendance:create');
    loadedRequest = makeRequest({ status: 'approved' });
    renderPanel();
    expect(screen.queryByRole('button', { name: 'More actions' })).not.toBeInTheDocument();
  });

  it('approves the request and says so', async () => {
    permissions.add('attendance:create');
    const user = userEvent.setup();
    renderPanel();

    await user.click(screen.getByRole('button', { name: 'More actions' }));
    await user.click(await screen.findByRole('menuitem', { name: /Approve/ }));

    expect(reviewAsync).toHaveBeenCalledWith({ id: 'req_1', decision: 'approved', note: null });
    await vi.waitFor(() => expect(toastSuccess).toHaveBeenCalled());
  });

  it('says so when approving fails', async () => {
    permissions.add('attendance:create');
    reviewAsync.mockRejectedValue(new Error('Overlaps a shift'));
    const user = userEvent.setup();
    renderPanel();

    await user.click(screen.getByRole('button', { name: 'More actions' }));
    await user.click(await screen.findByRole('menuitem', { name: /Approve/ }));

    await vi.waitFor(() => expect(toastError).toHaveBeenCalledWith('Overlaps a shift'));
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it('declines with a note through the dialog, which closes when it went through', async () => {
    permissions.add('attendance:create');
    const user = userEvent.setup();
    renderPanel();

    await user.click(screen.getByRole('button', { name: 'More actions' }));
    await user.click(await screen.findByRole('menuitem', { name: /Decline/ }));
    expect(screen.getByRole('dialog', { name: 'Decline request' })).toHaveTextContent(/09:00/);

    await user.click(screen.getByRole('button', { name: 'Send the decline' }));
    expect(reviewAsync).toHaveBeenCalledWith({ id: 'req_1', decision: 'rejected', note: 'Too short notice' });
    await vi.waitFor(() => expect(screen.queryByRole('dialog', { name: 'Decline request' })).not.toBeInTheDocument());
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it('keeps the decline dialog open when declining fails, and lets it be closed', async () => {
    permissions.add('attendance:create');
    reviewAsync.mockRejectedValue(new Error('Gone'));
    const user = userEvent.setup();
    renderPanel();

    await user.click(screen.getByRole('button', { name: 'More actions' }));
    await user.click(await screen.findByRole('menuitem', { name: /Decline/ }));
    await user.click(screen.getByRole('button', { name: 'Send the decline' }));
    await vi.waitFor(() => expect(toastError).toHaveBeenCalledWith('Gone'));
    expect(screen.getByRole('dialog', { name: 'Decline request' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Close the decline' }));
    expect(screen.queryByRole('dialog', { name: 'Decline request' })).not.toBeInTheDocument();
  });

  it('disables the review actions while a review is running', async () => {
    permissions.add('attendance:create');
    reviewPending = true;
    const user = userEvent.setup();
    renderPanel();

    await user.click(screen.getByRole('button', { name: 'More actions' }));
    expect(await screen.findByRole('menuitem', { name: /Approve/ })).toHaveAttribute('data-disabled');
    expect(screen.getByRole('menuitem', { name: /Decline/ })).toHaveAttribute('data-disabled');
  });
});
