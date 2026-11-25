import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { HrSelfLeave, HrSelfLeaveRequest } from '@weldsuite/app-api-client/domains/weldhr';

const mocks = vi.hoisted(() => ({
  cancel: vi.fn(),
  refetch: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));
let queryState: 'loaded' | 'loading' | 'failed' = 'loaded';
let leave: HrSelfLeave;

vi.mock('@/components/object-panel', () => import('@/components/objects/_shared/object-panel-test-mock'));
vi.mock('sonner', () => ({
  toast: { success: mocks.toastSuccess, error: mocks.toastError },
}));
vi.mock('@/hooks/use-workspace-url', () => ({
  useWorkspaceUrl: () => (path: string) => `https://app.test${path}`,
}));
vi.mock('@/app/weldhr/me/components/leave-tab', () => ({
  isCancellable: (request: { status: string }) => request.status === 'pending',
}));
vi.mock('@/hooks/queries/use-weldhr-queries', () => ({
  useMyHrLeave: () => ({
    data: queryState === 'loaded' ? leave : undefined,
    isLoading: queryState === 'loading',
    error: queryState === 'failed' ? new Error('Server unavailable') : null,
    refetch: mocks.refetch,
  }),
  useMyHrCancelLeave: () => ({ mutateAsync: mocks.cancel }),
}));

import { MyLeaveRequestPanel } from './my-leave-request-panel';
import { renderWithProviders } from '@/app/weldbooks/fixed-assets/test-utils';

function makeRequest(extra: Partial<HrSelfLeaveRequest> = {}): HrSelfLeaveRequest {
  return {
    id: 'req_1',
    leaveTypeId: 'type_1',
    leaveTypeName: 'Holiday',
    leaveTypeColor: '#ff0000',
    startDate: '2026-07-01',
    endDate: '2026-07-05',
    days: 5,
    reason: 'Beach trip',
    status: 'pending',
    reviewNote: null,
    reviewedAt: null,
    reviewedByName: null,
    createdAt: '2026-06-01T10:00:00Z',
    ...extra,
  };
}

function renderPanel(id = 'req_1') {
  return renderWithProviders(<MyLeaveRequestPanel id={id} isOpen onClose={() => {}} />);
}

async function openMenu(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: /more actions/i }));
}

beforeEach(() => {
  vi.clearAllMocks();
  queryState = 'loaded';
  leave = { types: [], balances: [], requests: [makeRequest()] };
  mocks.cancel.mockResolvedValue(undefined);
});

describe('MyLeaveRequestPanel', () => {
  it('shows the request with its type, days and reason', () => {
    renderPanel();
    expect(screen.getAllByText('Holiday').length).toBeGreaterThan(0);
    expect(screen.getByText('Beach trip')).toBeInTheDocument();
    expect(screen.getByText('5')).toBeInTheDocument();
  });

  it('shows the review of a reviewed request', () => {
    leave.requests = [
      makeRequest({
        status: 'approved',
        reviewedByName: 'Hannah HR',
        reviewedAt: '2026-06-03T09:00:00Z',
        reviewNote: 'Enjoy',
      }),
    ];
    renderPanel();
    expect(screen.getByText('Hannah HR')).toBeInTheDocument();
    expect(screen.getByText('Enjoy')).toBeInTheDocument();
  });

  it('shows dashes when the optional fields are empty', () => {
    leave.requests = [makeRequest({ leaveTypeName: null, leaveTypeColor: null, reason: null })];
    renderPanel();
    expect(screen.getAllByText('—').length).toBeGreaterThan(1);
  });

  it('shows no actions while loading', () => {
    queryState = 'loading';
    renderPanel();
    expect(screen.queryByRole('button', { name: /more actions/i })).not.toBeInTheDocument();
  });

  it('says so when the request is gone', () => {
    renderPanel('req_unknown');
    expect(screen.getByText('This item is no longer there.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /more actions/i })).not.toBeInTheDocument();
  });

  it('shows the error with Retry when the list failed', async () => {
    queryState = 'failed';
    renderPanel();
    expect(screen.getByRole('alert')).toHaveTextContent('Server unavailable');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Try again' }));
    expect(mocks.refetch).toHaveBeenCalled();
  });

  it('cancels a pending request after confirmation', async () => {
    const user = userEvent.setup();
    renderPanel();
    await openMenu(user);
    await user.click(await screen.findByRole('menuitem', { name: /cancel request/i }));
    await user.click(await screen.findByRole('button', { name: /cancel request/i }));
    await waitFor(() => expect(mocks.cancel).toHaveBeenCalledWith('req_1'));
    expect(mocks.toastSuccess).toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('asks for confirmation for a nameless leave type too', async () => {
    leave.requests = [makeRequest({ leaveTypeName: null })];
    const user = userEvent.setup();
    renderPanel();
    await openMenu(user);
    await user.click(await screen.findByRole('menuitem', { name: /cancel request/i }));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
  });

  it('keeps the request when the confirmation is dismissed', async () => {
    const user = userEvent.setup();
    renderPanel();
    await openMenu(user);
    await user.click(await screen.findByRole('menuitem', { name: /cancel request/i }));
    await screen.findByRole('dialog');
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(mocks.cancel).not.toHaveBeenCalled();
  });

  it('shows the error when cancelling fails', async () => {
    mocks.cancel.mockRejectedValue(new Error('Too late'));
    const user = userEvent.setup();
    renderPanel();
    await openMenu(user);
    await user.click(await screen.findByRole('menuitem', { name: /cancel request/i }));
    await user.click(await screen.findByRole('button', { name: /cancel request/i }));
    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith('Too late'));
  });

  it('offers no cancel action for a request that can no longer be cancelled', async () => {
    leave.requests = [makeRequest({ status: 'rejected' })];
    const user = userEvent.setup();
    renderPanel();
    await openMenu(user);
    expect(await screen.findByRole('menuitem', { name: /copy link/i })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: /cancel request/i })).not.toBeInTheDocument();
  });

  it('copies the deep link of the request', async () => {
    const user = userEvent.setup();
    const write = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
    renderPanel();
    await openMenu(user);
    await user.click(await screen.findByRole('menuitem', { name: /copy link/i }));
    await waitFor(() =>
      expect(write).toHaveBeenCalledWith(expect.stringContaining('?stack=hr_my_leave_request:req_1')),
    );
    expect(mocks.toastSuccess).toHaveBeenCalled();
  });

  it('reports a failed copy', async () => {
    const user = userEvent.setup();
    vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('denied'));
    renderPanel();
    await openMenu(user);
    await user.click(await screen.findByRole('menuitem', { name: /copy link/i }));
    await waitFor(() => expect(mocks.toastError).toHaveBeenCalled());
  });
});
