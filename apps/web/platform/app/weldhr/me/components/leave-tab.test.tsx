import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nProvider } from '@weldsuite/i18n/provider';
import type { HrSelfLeave, HrSelfLeaveRequest } from '@weldsuite/app-api-client/domains/weldhr';
import { MyLeaveList, isCancellable } from './leave-tab';

type Row = HrSelfLeaveRequest;
interface StubProps {
  items: Row[];
  isLoading: boolean;
  error: Error | null;
  columns: Array<{ id: string; render: (row: Row) => ReactNode }>;
  filters: Array<{ field: string; options: Array<{ value: string; label: string }> }>;
  groups: Array<{ id: string; filter: (row: Row) => boolean }>;
  applyFilters: (rows: Row[], active: Array<{ field: string; value: string }>) => Row[];
  onRowClick: (row: Row) => void;
  rowMenu: (row: Row) => ReactNode;
  createButton?: { label: string; onClick: () => void };
  emptyState: { title: string; description: string; action?: { label: string } };
}

const mocks = vi.hoisted(() => ({ open: vi.fn(), cancel: vi.fn(), toastSuccess: vi.fn(), toastError: vi.fn() }));
let data: HrSelfLeave | undefined;
let loading = false;
let failure: Error | null = null;

vi.mock('sonner', () => ({
  toast: { success: (message: string) => mocks.toastSuccess(message), error: (message: string) => mocks.toastError(message) },
}));
vi.mock('@weldsuite/ui/components/dropdown-menu', () => ({
  DropdownMenuItem: ({ children, onClick }: { children: ReactNode; onClick?: () => void }) => (
    <button type="button" onClick={onClick}>
      {children}
    </button>
  ),
}));
vi.mock('@/components/object-panel', () => ({ useObjectPanel: () => ({ open: mocks.open }) }));
vi.mock('./leave-request-dialog', () => ({
  LeaveRequestDialog: ({ types, onClose }: { types: HrSelfLeave['types']; onClose: () => void }) => (
    <div role="dialog" aria-label="request dialog">
      {types.length} types
      <button type="button" onClick={onClose}>
        close request dialog
      </button>
    </div>
  ),
}));
vi.mock('@/hooks/queries/use-weldhr-queries', () => ({
  useMyHrLeave: () => ({ data, isLoading: loading, error: failure }),
  useMyHrCancelLeave: () => ({ mutateAsync: mocks.cancel }),
}));
vi.mock('@/components/panel-entity-list', async () => {
  const { useState } = await import('react');
  return {
    PanelEntityList: (props: StubProps) => {
      const [shown, setShown] = useState<Row[] | null>(null);
      const rows = shown ?? props.items;
      if (props.isLoading) return <p>stub loading</p>;
      if (props.error) return <p>stub error: {props.error.message}</p>;
      return (
        <div>
          {props.filters.map((filter) =>
            filter.options.map((option) => (
              <button
                key={`${filter.field}-${option.value}`}
                type="button"
                onClick={() => setShown(props.applyFilters(props.items, [{ field: filter.field, value: option.value }]))}
              >
                filter {filter.field} {option.label}
              </button>
            )),
          )}
          <button type="button" onClick={() => setShown(props.applyFilters(props.items, [{ field: 'status', value: '' }, { field: 'x', value: 'y' }]))}>
            filter ignored
          </button>
          {props.groups.map((group) => (
            <p key={group.id} data-testid={`group-${group.id}`}>
              {props.items
                .filter(group.filter)
                .map((row) => row.id)
                .join(',')}
            </p>
          ))}
          {props.createButton && (
            <button type="button" onClick={props.createButton.onClick}>
              {props.createButton.label}
            </button>
          )}
          {rows.length === 0 && (
            <div data-testid="empty">
              <p>{props.emptyState.title}</p>
              <p>{props.emptyState.description}</p>
              {props.emptyState.action && <span>empty action {props.emptyState.action.label}</span>}
            </div>
          )}
          <ul>
            {rows.map((row) => (
              <li key={row.id} data-testid={`row-${row.id}`}>
                {props.columns.map((column) => (
                  <span key={column.id} data-testid={`${row.id}-${column.id}`}>
                    {column.render(row)}
                  </span>
                ))}
                <button type="button" onClick={() => props.onRowClick(row)}>
                  open {row.id}
                </button>
                <span data-testid={`${row.id}-menu`}>{props.rowMenu(row)}</span>
              </li>
            ))}
          </ul>
        </div>
      );
    },
  };
});

function request(extra: Partial<Row> & { id: string }): Row {
  return {
    leaveTypeId: 'lt_annual',
    leaveTypeName: 'Annual leave',
    leaveTypeColor: '#22aa55',
    startDate: '2026-12-21',
    endDate: '2026-12-24',
    days: 4,
    reason: null,
    status: 'pending',
    reviewNote: null,
    reviewedAt: null,
    ...extra,
  };
}

function renderList(canRequest = true) {
  return render(
    <I18nProvider initialLanguage="en">
      <MyLeaveList canRequest={canRequest} />
    </I18nProvider>,
  );
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-23T10:00:00'));
  mocks.open.mockReset();
  mocks.cancel.mockReset().mockResolvedValue(undefined);
  mocks.toastSuccess.mockReset();
  mocks.toastError.mockReset();
  loading = false;
  failure = null;
  data = {
    types: [
      { id: 'lt_annual', name: 'Annual leave', color: '#22aa55', requiresApproval: true },
      { id: 'lt_study', name: 'Study day', color: null, requiresApproval: false },
    ],
    balances: [],
    requests: [
      request({ id: 'r_pending' }),
      request({ id: 'r_future', status: 'approved', startDate: '2026-12-01', endDate: '2026-12-02', days: 2, leaveTypeId: 'lt_study', leaveTypeName: null, leaveTypeColor: null }),
      request({ id: 'r_started', status: 'approved', startDate: '2026-11-20', endDate: '2026-11-25' }),
      request({ id: 'r_rejected', status: 'rejected' }),
      request({ id: 'r_cancelled', status: 'cancelled' }),
    ],
  };
});

afterEach(() => {
  vi.useRealTimers();
});

describe('isCancellable', () => {
  it('allows pending requests and approved ones that have not started', () => {
    expect(isCancellable(request({ id: 'a', status: 'pending', startDate: '2026-01-01' }))).toBe(true);
    expect(isCancellable(request({ id: 'b', status: 'approved', startDate: '2026-11-24' }))).toBe(true);
    expect(isCancellable(request({ id: 'c', status: 'approved', startDate: '2026-11-23' }))).toBe(false);
    expect(isCancellable(request({ id: 'd', status: 'rejected', startDate: '2027-01-01' }))).toBe(false);
  });
});

describe('MyLeaveList', () => {
  it('shows loading, and the error only when there is no data', () => {
    loading = true;
    const { unmount } = renderList();
    expect(screen.getByText('stub loading')).toBeInTheDocument();
    unmount();

    loading = false;
    data = undefined;
    failure = new Error('Server down');
    renderList();
    expect(screen.getByText('stub error: Server down')).toBeInTheDocument();
  });

  it('renders each request with its type, dates and status, and groups them by status', () => {
    data = { ...(data as HrSelfLeave), requests: [...(data as HrSelfLeave).requests, request({ id: 'r_odd', status: 'withdrawn' as Row['status'] })] };
    renderList();

    expect(screen.getByTestId('r_pending-type')).toHaveTextContent('Annual leave');
    expect(screen.getByTestId('r_future-type')).toHaveTextContent('—');
    expect(screen.getByTestId('r_pending-dates')).toHaveTextContent(/2026.*–.*2026/);
    expect(screen.getByTestId('r_pending-days')).toHaveTextContent('4');
    expect(screen.getByTestId('r_pending-status')).toHaveTextContent('Pending');
    expect(screen.getByTestId('group-pending')).toHaveTextContent('r_pending');
    expect(screen.getByTestId('group-approved')).toHaveTextContent('r_future,r_started');
    expect(screen.getByTestId('group-rejectedCancelled')).toHaveTextContent('r_rejected,r_cancelled');
    expect(screen.getByTestId('group-other')).toHaveTextContent('r_odd');
  });

  it('narrows the rows by status and by leave type', async () => {
    const user = userEvent.setup();
    renderList();

    await user.click(screen.getByRole('button', { name: 'filter status Rejected' }));
    expect(screen.getAllByTestId(/^row-/).map((row) => row.dataset.testid)).toEqual(['row-r_rejected']);

    await user.click(screen.getByRole('button', { name: 'filter type Study day' }));
    expect(screen.getAllByTestId(/^row-/).map((row) => row.dataset.testid)).toEqual(['row-r_future']);

    await user.click(screen.getByRole('button', { name: 'filter ignored' }));
    expect(screen.getAllByTestId(/^row-/)).toHaveLength(5);
  });

  it('opens the request panel from a row', async () => {
    const user = userEvent.setup();
    renderList();

    await user.click(screen.getByRole('button', { name: 'open r_pending' }));
    expect(mocks.open).toHaveBeenCalledWith(expect.objectContaining({ id: 'r_pending' }));
  });

  it('only offers Cancel request for a request that can still be cancelled', () => {
    renderList();

    expect(within(screen.getByTestId('r_pending-menu')).getByRole('button', { name: 'Cancel request' })).toBeInTheDocument();
    expect(within(screen.getByTestId('r_future-menu')).getByRole('button', { name: 'Cancel request' })).toBeInTheDocument();
    expect(within(screen.getByTestId('r_started-menu')).queryByRole('button')).not.toBeInTheDocument();
    expect(within(screen.getByTestId('r_rejected-menu')).queryByRole('button')).not.toBeInTheDocument();
  });

  it('cancels a request after confirming, and toasts', async () => {
    const user = userEvent.setup();
    renderList();

    await user.click(within(screen.getByTestId('r_pending-menu')).getByRole('button', { name: 'Cancel request' }));
    const dialog = await screen.findByRole('dialog', { name: 'Cancel this leave request?' });
    expect(within(dialog).getByText('Cancel this leave request?')).toBeInTheDocument();
    expect(within(dialog).getByText(/Your Annual leave request \(.*2026.*–.*2026.*\) will be cancelled\./)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Cancel request' }));

    await waitFor(() => expect(mocks.cancel).toHaveBeenCalledWith('r_pending'));
    expect(mocks.toastSuccess).toHaveBeenCalledWith('Leave request cancelled');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Cancel this leave request?' })).not.toBeInTheDocument());
  });

  it('names a request without a type "leave", keeps it on Keep request, and toasts a failure', async () => {
    const user = userEvent.setup();
    renderList();

    await user.click(within(screen.getByTestId('r_future-menu')).getByRole('button', { name: 'Cancel request' }));
    let dialog = await screen.findByRole('dialog', { name: 'Cancel this leave request?' });
    expect(within(dialog).getByText(/Your leave request/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Keep request' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Cancel this leave request?' })).not.toBeInTheDocument());
    expect(mocks.cancel).not.toHaveBeenCalled();

    mocks.cancel.mockRejectedValue(new Error('Already reviewed'));
    await user.click(within(screen.getByTestId('r_pending-menu')).getByRole('button', { name: 'Cancel request' }));
    dialog = await screen.findByRole('dialog', { name: 'Cancel this leave request?' });
    await user.click(within(dialog).getByRole('button', { name: 'Cancel request' }));
    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith('Already reviewed'));
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Cancel this leave request?' })).not.toBeInTheDocument());
  });

  it('opens and closes the request dialog from the Request leave button', async () => {
    const user = userEvent.setup();
    renderList();

    expect(screen.queryByRole('dialog', { name: 'request dialog' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Request leave' }));
    expect(screen.getByRole('dialog', { name: 'request dialog' })).toHaveTextContent('2 types');
    await user.click(screen.getByRole('button', { name: 'close request dialog' }));
    expect(screen.queryByRole('dialog', { name: 'request dialog' })).not.toBeInTheDocument();
  });

  it('with requests on, the empty state invites to request leave', () => {
    data = { types: [], balances: [], requests: [] };
    renderList(true);

    expect(screen.getByTestId('empty')).toHaveTextContent('Leave you request shows up here, with its approval.');
    expect(screen.getByText('empty action Request leave')).toBeInTheDocument();
  });

  it('with requests off, there is no button and the empty state says why', () => {
    data = { types: [], balances: [], requests: [] };
    renderList(false);

    expect(screen.queryByRole('button', { name: 'Request leave' })).not.toBeInTheDocument();
    expect(screen.getByTestId('empty')).toHaveTextContent('Leave requests are turned off in your workspace.');
    expect(screen.queryByText(/empty action/)).not.toBeInTheDocument();
  });
});
