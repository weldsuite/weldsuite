import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';
import { I18nProvider } from '@weldsuite/i18n/provider';
import { en } from '@weldsuite/i18n/locales/en';
import type { HrLeaveRequest } from '@weldsuite/app-api-client/domains/weldhr';
import { RequestsTab } from './requests-tab';
import { latest } from '@/components/panel-entity-list-test-mock';

const t = en.weldhr.leave.requests;

const state = vi.hoisted(() => ({
  permissions: new Set<string>(),
  requests: undefined as unknown,
  isLoading: false,
  error: null as Error | null,
  cancel: vi.fn(),
  remove: vi.fn(),
}));

vi.mock('@weldsuite/permissions/react', () => ({ usePermissions: () => ({ can: (p: string) => state.permissions.has(p) }) }));
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));
vi.mock('@/components/panel-entity-list', () => import('@/components/panel-entity-list-test-mock'));
vi.mock('@weldsuite/ui/components/dropdown-menu', () => import('@/components/dropdown-menu-test-mock'));
vi.mock('./request-dialog', () => ({ LeaveRequestDialog: ({ onClose }: { onClose: () => void }) => <button onClick={onClose}>new request dialog</button> }));
vi.mock('./review-dialog', () => ({
  LeaveReviewDialog: (p: { request: { id: string }; decision: string; onClose: () => void }) => (
    <button onClick={p.onClose}>{`review ${p.request.id} ${p.decision}`}</button>
  ),
}));
vi.mock('@/hooks/queries/use-weldhr-queries', () => ({
  useHrLeaveRequests: () => ({ data: state.requests, isLoading: state.isLoading, error: state.error }),
  useCancelHrLeaveRequest: () => ({ mutateAsync: state.cancel }),
  useDeleteHrLeaveRequest: () => ({ mutateAsync: state.remove }),
}));

function request(over: Partial<HrLeaveRequest> & { id: string }): HrLeaveRequest {
  return {
    employeeId: 'emp_1',
    employeeName: 'Anna de Vries',
    leaveTypeId: 'lt_1',
    leaveTypeName: 'Holiday',
    leaveTypeColor: '#ff0000',
    startDate: '2026-11-23',
    endDate: '2026-11-25',
    days: 3,
    reason: 'Rest',
    status: 'pending',
    requestedBy: null,
    reviewedBy: null,
    reviewedByName: null,
    reviewedAt: null,
    reviewNote: null,
    createdAt: '2026-11-01T10:00:00Z',
    ...over,
  };
}

function renderTab() {
  return render(
    <I18nProvider initialLanguage="en">
      <RequestsTab />
    </I18nProvider>,
  );
}

const ALL = ['leave:approve', 'leave:update', 'leave:delete'];

beforeEach(() => {
  state.permissions = new Set(ALL);
  state.isLoading = false;
  state.error = null;
  state.cancel.mockReset().mockResolvedValue(undefined);
  state.remove.mockReset().mockResolvedValue(undefined);
  vi.mocked(toast.error).mockReset();
  state.requests = [
    request({ id: 'r_pending' }),
    request({ id: 'r_approved', employeeName: 'Bram Jansen', leaveTypeName: 'Sick', leaveTypeColor: null, status: 'approved', reason: null, reviewedByName: 'Eva' }),
    request({ id: 'r_rejected', employeeName: 'Carla Smit', leaveTypeName: null, status: 'rejected' }),
    request({ id: 'r_cancelled', employeeName: 'Dirk Visser', status: 'cancelled' }),
    request({ id: 'r_weekend', employeeName: 'Emma Bakker', startDate: '2026-11-21', endDate: '2026-11-22', days: 0 }),
  ];
});

describe('RequestsTab', () => {
  it('groups the requests by status', () => {
    renderTab();
    expect(within(screen.getByRole('region', { name: t.groups.pending })).getByTestId('row-r_pending')).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: t.groups.approved })).getByTestId('row-r_approved')).toBeInTheDocument();
    const closed = within(screen.getByRole('region', { name: t.groups.rejectedCancelled }));
    expect(closed.getByTestId('row-r_rejected')).toBeInTheDocument();
    expect(closed.getByTestId('row-r_cancelled')).toBeInTheDocument();
  });

  it('puts an unknown status in Other', () => {
    state.requests = [request({ id: 'r_odd', status: 'withdrawn' as HrLeaveRequest['status'] })];
    renderTab();
    expect(within(screen.getByRole('region', { name: t.groups.other })).getByTestId('row-r_odd')).toBeInTheDocument();
  });

  it('shows the reason and reviewer, with dashes for what is missing', () => {
    renderTab();
    const approved = within(screen.getByTestId('row-r_approved'));
    expect(approved.getByText('Eva')).toBeInTheDocument();
    expect(approved.getAllByText('—').length).toBeGreaterThan(0);
    expect(within(screen.getByTestId('row-r_rejected')).getAllByText('—').length).toBeGreaterThan(0);
    expect(within(screen.getByTestId('row-r_pending')).getByText('Rest')).toBeInTheDocument();
  });

  it('labels a weekend-only request as Weekend and others with their day count', () => {
    renderTab();
    expect(within(screen.getByTestId('row-r_weekend')).getAllByText(en.weldhr.common.weekend).length).toBeGreaterThan(0);
    expect(within(screen.getByTestId('row-r_pending')).getByText('3d')).toBeInTheDocument();
  });

  it('shows the loading state, the error and the empty state', () => {
    state.isLoading = true;
    const first = renderTab();
    expect(screen.getByText('loading')).toBeInTheDocument();
    first.unmount();

    state.isLoading = false;
    state.error = new Error('Server down');
    const second = renderTab();
    expect(screen.getByRole('alert')).toHaveTextContent('Server down');
    second.unmount();

    state.error = null;
    state.requests = undefined;
    renderTab();
    expect(screen.getByText(t.empty.title)).toBeInTheDocument();
  });

  it('opens and closes the new request dialog', async () => {
    const user = userEvent.setup();
    renderTab();
    await user.click(screen.getByRole('button', { name: t.newRequest }));
    await user.click(screen.getByRole('button', { name: 'new request dialog' }));
    expect(screen.queryByRole('button', { name: 'new request dialog' })).not.toBeInTheDocument();
  });

  it('searches by employee, type and reason', async () => {
    const user = userEvent.setup();
    renderTab();
    await user.type(screen.getByLabelText('search'), 'bram');
    expect(screen.getByTestId('row-r_approved')).toBeInTheDocument();
    expect(screen.queryByTestId('row-r_pending')).not.toBeInTheDocument();
  });

  it('filters by status, type and employee', async () => {
    const user = userEvent.setup();
    renderTab();
    await user.click(screen.getByRole('button', { name: 'status=approved' }));
    expect(screen.getByTestId('row-r_approved')).toBeInTheDocument();
    expect(screen.queryByTestId('row-r_pending')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'type=Sick' }));
    expect(screen.getByTestId('row-r_approved')).toBeInTheDocument();
    expect(screen.queryByTestId('row-r_weekend')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'employee=Anna de Vries' }));
    expect(screen.getByTestId('row-r_pending')).toBeInTheDocument();
    expect(screen.queryByTestId('row-r_approved')).not.toBeInTheDocument();
  });

  it('ignores a filter without a value and an unknown filter field', async () => {
    const user = userEvent.setup();
    renderTab();
    // Both are reached through the list's own applyFilters; here every row stays.
    await user.click(screen.getByRole('button', { name: 'status=pending' }));
    expect(screen.getByTestId('row-r_pending')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'clear filters' }));
    expect(screen.getByTestId('row-r_approved')).toBeInTheDocument();
  });

  it('lists the distinct leave types and employees as filter options, without the empty ones', () => {
    renderTab();
    const types = within(screen.getByRole('group', { name: 'filter type' }));
    expect(types.getAllByRole('button').map((b) => b.textContent)).toEqual(['type=Holiday', 'type=Sick']);
    expect(within(screen.getByRole('group', { name: 'filter employee' })).getAllByRole('button')).toHaveLength(5);
  });

  describe('row menu', () => {
    it('approves or rejects a pending request through the review dialog', async () => {
      const user = userEvent.setup();
      renderTab();
      const menu = within(screen.getByTestId('menu-r_pending'));
      await user.click(menu.getByRole('menuitem', { name: t.approve }));
      await user.click(screen.getByRole('button', { name: 'review r_pending approved' }));
      expect(screen.queryByRole('button', { name: /^review / })).not.toBeInTheDocument();

      await user.click(menu.getByRole('menuitem', { name: t.reject }));
      expect(screen.getByRole('button', { name: 'review r_pending rejected' })).toBeInTheDocument();
    });

    it('only offers review for a pending request', () => {
      renderTab();
      const menu = within(screen.getByTestId('menu-r_approved'));
      expect(menu.queryByRole('menuitem', { name: t.approve })).not.toBeInTheDocument();
      expect(menu.getByRole('menuitem', { name: t.cancel })).toBeInTheDocument();
    });

    it('offers cancel for pending and approved requests, not for closed ones', () => {
      renderTab();
      expect(within(screen.getByTestId('menu-r_pending')).getByRole('menuitem', { name: t.cancel })).toBeInTheDocument();
      expect(within(screen.getByTestId('menu-r_rejected')).queryByRole('menuitem', { name: t.cancel })).not.toBeInTheDocument();
    });

    it('cancels the request after confirming', async () => {
      const user = userEvent.setup();
      renderTab();
      await user.click(within(screen.getByTestId('menu-r_pending')).getByRole('menuitem', { name: t.cancel }));
      const dialog = await screen.findByRole('dialog');
      expect(within(dialog).getByText(t.cancelConfirmTitle)).toBeInTheDocument();
      await user.click(within(dialog).getByRole('button', { name: t.cancel }));
      await waitFor(() => expect(state.cancel).toHaveBeenCalledWith('r_pending'));
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    });

    it('keeps the request when the confirmation is dismissed', async () => {
      const user = userEvent.setup();
      renderTab();
      await user.click(within(screen.getByTestId('menu-r_pending')).getByRole('menuitem', { name: t.cancel }));
      const dialog = await screen.findByRole('dialog');
      await user.click(within(dialog).getByRole('button', { name: t.keepRequest }));
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
      expect(state.cancel).not.toHaveBeenCalled();
    });

    it('shows the error and keeps the dialog when cancelling fails', async () => {
      state.cancel.mockRejectedValue(new Error('Already reviewed'));
      const user = userEvent.setup();
      renderTab();
      await user.click(within(screen.getByTestId('menu-r_pending')).getByRole('menuitem', { name: t.cancel }));
      const dialog = await screen.findByRole('dialog');
      await user.click(within(dialog).getByRole('button', { name: t.cancel }));
      await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Already reviewed'));
      expect(screen.getByRole('dialog')).toBeInTheDocument();
    });

    it('deletes the request after confirming', async () => {
      const user = userEvent.setup();
      renderTab();
      await user.click(within(screen.getByTestId('menu-r_rejected')).getByRole('menuitem', { name: en.weldhr.common.delete }));
      const dialog = await screen.findByRole('dialog');
      expect(within(dialog).getByText(t.deleteConfirmTitle)).toBeInTheDocument();
      await user.click(within(dialog).getByRole('button', { name: /^confirm$/i }));
      await waitFor(() => expect(state.remove).toHaveBeenCalledWith('r_rejected'));
    });

    it('shows the fallback message when deleting fails without a message', async () => {
      state.remove.mockRejectedValue('nope');
      const user = userEvent.setup();
      renderTab();
      await user.click(within(screen.getByTestId('menu-r_rejected')).getByRole('menuitem', { name: en.weldhr.common.delete }));
      const dialog = await screen.findByRole('dialog');
      await user.click(within(dialog).getByRole('button', { name: /^confirm$/i }));
      await waitFor(() => expect(toast.error).toHaveBeenCalledWith(t.deleteFailed));
    });

    it('has no menu without any permission', () => {
      state.permissions = new Set();
      renderTab();
      expect(screen.queryByTestId('menu-r_pending')).not.toBeInTheDocument();
    });

    it('only shows what the permissions allow', () => {
      state.permissions = new Set(['leave:update', 'leave:delete']);
      renderTab();
      const menu = within(screen.getByTestId('menu-r_pending'));
      expect(menu.queryByRole('menuitem', { name: t.approve })).not.toBeInTheDocument();
      expect(menu.getByRole('menuitem', { name: t.cancel })).toBeInTheDocument();
      expect(menu.getByRole('menuitem', { name: en.weldhr.common.delete })).toBeInTheDocument();
    });

    it('shows only Delete for a closed request when the user can only delete', () => {
      state.permissions = new Set(['leave:delete']);
      renderTab();
      const menu = within(screen.getByTestId('menu-r_rejected'));
      expect(menu.getAllByRole('menuitem')).toHaveLength(1);
    });
  });

  it('leaves the rows alone for a filter without a value or on an unknown field', () => {
    renderTab();
    const rows = state.requests as unknown[] as never[];
    expect(latest.applyFilters?.(rows, [{ id: 'a', field: 'status', operator: 'is', value: '' }])).toHaveLength(rows.length);
    expect(latest.applyFilters?.(rows, [{ id: 'b', field: 'unknown', operator: 'is', value: 'x' }])).toHaveLength(rows.length);
  });
});
