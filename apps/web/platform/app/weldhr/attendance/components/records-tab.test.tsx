import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';
import { en } from '@weldsuite/i18n/locales/en';
import type { HrAttendanceRecord } from '@weldsuite/app-api-client/domains/weldhr';
import { renderWithProviders } from '@/app/weldbooks/fixed-assets/test-utils';
import { latest } from '@/components/panel-entity-list-test-mock';
import { RecordsTab } from './records-tab';

const t = en.weldhr.attendance.records;

const state = vi.hoisted(() => ({
  permissions: new Set<string>(),
  records: undefined as unknown,
  summary: undefined as unknown,
  isLoading: false,
  error: null as Error | null,
  queries: [] as Array<Record<string, unknown>>,
  summaries: [] as unknown[],
  approve: vi.fn(),
  remove: vi.fn(),
  companies: { data: [{ id: 'co_1', displayName: 'Acme' }, { id: 'co_2', name: 'Globex' }, { id: 'co_3' }] },
}));

vi.mock('@weldsuite/permissions/react', () => ({ usePermissions: () => ({ can: (p: string) => state.permissions.has(p) }) }));
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));
vi.mock('@/components/panel-entity-list', () => import('@/components/panel-entity-list-test-mock'));
vi.mock('@/app/weldcalendar/lib/calendar-format', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/app/weldcalendar/lib/calendar-format')>()),
  useTimeFormat: () => '24h',
}));
vi.mock('@/lib/api/use-app-api', () => ({
  useAppApiClient: () => ({ getClient: async () => ({ get: async () => state.companies }) }),
}));
vi.mock('./record-dialog', () => ({
  AttendanceRecordDialog: (p: { record?: { id: string }; onClose: () => void }) => (
    <button onClick={p.onClose}>{p.record ? `record dialog ${p.record.id}` : 'record dialog new'}</button>
  ),
}));
vi.mock('@/hooks/queries/use-weldhr-queries', () => ({
  useHrAttendance: (params: Record<string, unknown>) => {
    state.queries.push(params);
    return { data: state.records, isLoading: state.isLoading, isFetching: false, error: state.error };
  },
  useHrAttendanceSummary: (params: unknown) => {
    state.summaries.push(params);
    return { data: state.summary };
  },
  useHrEmployees: () => ({ data: { data: [{ id: 'emp_1', displayName: 'Anna de Vries' }] } }),
  useApproveHrAttendance: () => ({ mutateAsync: state.approve, isPending: false }),
  useDeleteHrAttendance: () => ({ mutateAsync: state.remove }),
}));

function record(over: Partial<HrAttendanceRecord> & { id: string }): HrAttendanceRecord {
  return {
    employeeId: 'emp_1',
    employeeName: 'Anna de Vries',
    companyId: null,
    companyName: null,
    shiftId: null,
    date: '2026-11-20',
    clockIn: '2026-11-20T08:00:00',
    clockOut: '2026-11-20T16:30:00',
    breakMinutes: 30,
    workedMinutes: 480,
    lateMinutes: 0,
    status: 'present',
    source: 'portal',
    notes: null,
    approvedBy: null,
    approvedByName: null,
    approvedAt: null,
    createdAt: '2026-11-20T08:00:00',
    ...over,
  };
}

function renderTab() {
  return renderWithProviders(<RecordsTab />);
}

const ALL = ['attendance:create', 'attendance:update', 'attendance:delete', 'attendance:approve'];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-23T10:00:00'));
  state.permissions = new Set(ALL);
  state.isLoading = false;
  state.error = null;
  state.queries = [];
  state.summaries = [];
  state.approve.mockReset().mockResolvedValue(undefined);
  state.remove.mockReset().mockResolvedValue(undefined);
  vi.mocked(toast.error).mockReset();
  state.summary = { records: 3, workedMinutes: 1440, lateMinutes: 10, byStatus: { absent: 2 }, attendanceRate: 91 };
  state.records = {
    data: [
      record({ id: 'r_open', clockInLocationName: 'HQ', clockOutLocationName: 'Depot', companyName: 'Acme', lateMinutes: 7 }),
      record({ id: 'r_same', clockInLocationName: 'HQ', clockOutLocationName: 'HQ', approvedAt: '2026-11-21T09:00:00', approvedByName: 'Eva' }),
      record({ id: 'r_auto', clockIn: null, clockOut: null, workedMinutes: null, approvedAt: '2026-11-21T09:00:00', approvedByName: null, source: 'manual' }),
      record({ id: 'r_in', clockOutLocationName: 'Depot' }),
    ],
    pagination: { hasMore: false },
  };
});

afterEach(() => vi.useRealTimers());

describe('attendance RecordsTab', () => {
  it('opens on the last seven days', () => {
    renderTab();
    expect(state.queries[0]).toMatchObject({ from: '2026-11-17', limit: 50 });
    expect(state.summaries[0]).toMatchObject({ from: '2026-11-17' });
  });

  it('shows the date filter pill in the list format, not the browser format', () => {
    renderTab();
    const date = latest.filters!.find((f) => f.field === 'date')!;
    expect(date.getDisplayValue?.('2026-11-16')).toMatch(/16 Nov 2026|Nov 16, 2026/);
  });

  it('applies the picked filters to the query', async () => {
    vi.useRealTimers();
    const user = userEvent.setup();
    renderTab();
    await user.click(screen.getByRole('button', { name: 'employeeId=emp_1' }));
    await waitFor(() => expect(state.queries.at(-1)).toMatchObject({ employeeId: 'emp_1', from: undefined }));
    await user.click(screen.getByRole('button', { name: 'status=late' }));
    await waitFor(() => expect(state.queries.at(-1)).toMatchObject({ status: 'late' }));
  });

  it('uses a single day for the "is" date filter', async () => {
    renderTab();
    const { act } = await import('@testing-library/react');
    act(() => latest.onFiltersChange?.([{ id: 'd', field: 'date', operator: 'is', value: '2026-11-10' }]));
    await waitFor(() => expect(state.queries.at(-1)).toMatchObject({ from: '2026-11-10', to: '2026-11-10' }));
    act(() => latest.onFiltersChange?.([{ id: 'u', field: 'unapproved', operator: 'is', value: 'true' }]));
    await waitFor(() => expect(state.queries.at(-1)).toMatchObject({ unapproved: true }));
  });

  it('lists the client filter options by display name, name or id', async () => {
    renderTab();
    await waitFor(() => {
      const client = latest.filters!.find((f) => f.field === 'companyId')!;
      expect(client.options.map((o) => o.label)).toEqual(['Acme', 'Globex', 'co_3']);
    });
  });

  describe('rows', () => {
    it('shows one location name when clock-in and clock-out match, and both when they differ', () => {
      renderTab();
      expect(within(screen.getByTestId('row-r_open')).getAllByText('HQ → Depot').length).toBeGreaterThan(0);
      expect(within(screen.getByTestId('row-r_same')).getAllByText('HQ').length).toBeGreaterThan(0);
      expect(within(screen.getByTestId('row-r_in')).getAllByText('Depot').length).toBeGreaterThan(0);
      expect(within(screen.getByTestId('row-r_auto')).queryByText(/HQ|Depot/)).not.toBeInTheDocument();
    });

    it('shows how late someone was', () => {
      renderTab();
      expect(within(screen.getByTestId('row-r_open')).getByText('+7m')).toBeInTheDocument();
    });

    it('shows who approved, a tick when the approver is unknown, and Approve otherwise', () => {
      renderTab();
      expect(within(screen.getByTestId('row-r_same')).getByText('Eva')).toBeInTheDocument();
      expect(within(screen.getByTestId('row-r_auto')).getByText('✓')).toBeInTheDocument();
      expect(within(screen.getByTestId('row-r_open')).getByRole('button', { name: en.weldhr.leave.requests.approve })).toBeInTheDocument();
    });

    it('shows a dash instead of Approve without permission to approve', () => {
      state.permissions = new Set(['attendance:update']);
      renderTab();
      expect(within(screen.getByTestId('row-r_open')).queryByRole('button', { name: en.weldhr.leave.requests.approve })).not.toBeInTheDocument();
      expect(screen.getByTestId('row-r_open').querySelector('[data-column="approved"]')).toHaveTextContent('—');
    });

    it('shows the summary of the period', () => {
      renderTab();
      expect(screen.getByText('91%')).toBeInTheDocument();
      expect(screen.getByText('2', { selector: 'strong' })).toBeInTheDocument();
    });

    it('shows a dash for an attendance rate that is not known, and no absences as 0', () => {
      state.summary = { records: 0, workedMinutes: 0, lateMinutes: 0, byStatus: {}, attendanceRate: null };
      renderTab();
      expect(screen.getAllByText('—').length).toBeGreaterThan(0);
      expect(screen.getByText('0', { selector: 'strong' })).toBeInTheDocument();
    });

    it('shows loading, error and the empty state', () => {
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
      state.records = undefined;
      state.summary = undefined;
      renderTab();
      expect(screen.getByText(t.empty.title)).toBeInTheDocument();
    });

    it('searches by employee, client, notes and clock-in location', async () => {
      vi.useRealTimers();
      const user = userEvent.setup();
      renderTab();
      await user.type(screen.getByLabelText('search'), 'acme');
      expect(screen.getByTestId('row-r_open')).toBeInTheDocument();
      expect(screen.queryByTestId('row-r_auto')).not.toBeInTheDocument();
    });
  });

  describe('approving', () => {
    it('approves one record', async () => {
      vi.useRealTimers();
      const user = userEvent.setup();
      renderTab();
      await user.click(within(screen.getByTestId('row-r_open')).getByRole('button', { name: en.weldhr.leave.requests.approve }));
      expect(state.approve).toHaveBeenCalledWith(['r_open']);
    });

    it('shows the error when approving one fails', async () => {
      vi.useRealTimers();
      state.approve.mockRejectedValue(new Error('Locked period'));
      const user = userEvent.setup();
      renderTab();
      await user.click(within(screen.getByTestId('row-r_open')).getByRole('button', { name: en.weldhr.leave.requests.approve }));
      await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Locked period'));
    });

    it('offers to approve everything that is shown, with the count, after confirming', async () => {
      vi.useRealTimers();
      const user = userEvent.setup();
      renderTab();
      const all = screen.getByRole('button', { name: 'Approve all pending (2)' });
      expect(all).toHaveTextContent('2');
      await user.click(all);
      const dialog = await screen.findByRole('dialog');
      expect(within(dialog).getByText(/2/)).toBeInTheDocument();
      await user.click(within(dialog).getByRole('button', { name: en.weldhr.leave.requests.approve }));
      await waitFor(() => expect(state.approve).toHaveBeenCalledWith(['r_open', 'r_in']));
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    });

    it('keeps the confirmation open and shows the error when approving all fails', async () => {
      vi.useRealTimers();
      state.approve.mockRejectedValue('x');
      const user = userEvent.setup();
      renderTab();
      await user.click(screen.getByRole('button', { name: /^Approve all/ }));
      const dialog = await screen.findByRole('dialog');
      await user.click(within(dialog).getByRole('button', { name: en.weldhr.leave.requests.approve }));
      await waitFor(() => expect(toast.error).toHaveBeenCalledWith(t.approveFailed));
      expect(screen.getByRole('dialog')).toBeInTheDocument();
    });

    it('has no approve-all button when everything is approved or without permission', () => {
      state.permissions = new Set(['attendance:update']);
      const first = renderTab();
      expect(screen.queryByRole('button', { name: /^Approve all/ })).not.toBeInTheDocument();
      first.unmount();
      state.permissions = new Set(ALL);
      state.records = { data: [record({ id: 'done', approvedAt: '2026-11-21T09:00:00' })], pagination: { hasMore: false } };
      renderTab();
      expect(screen.queryByRole('button', { name: /^Approve all/ })).not.toBeInTheDocument();
    });
  });

  describe('create, edit and delete', () => {
    it('adds and edits a record', async () => {
      vi.useRealTimers();
      const user = userEvent.setup();
      renderTab();
      await user.click(screen.getByRole('button', { name: t.addRecord }));
      await user.click(screen.getByRole('button', { name: 'record dialog new' }));
      await user.click(screen.getByRole('button', { name: 'edit r_open' }));
      expect(screen.getByRole('button', { name: 'record dialog r_open' })).toBeInTheDocument();
    });

    it('names the employee and day in the delete confirmation, and deletes', async () => {
      vi.useRealTimers();
      const user = userEvent.setup();
      renderTab();
      await user.click(screen.getByRole('button', { name: 'delete r_open' }));
      const dialog = await screen.findByRole('dialog');
      expect(within(dialog).getByText(/Anna de Vries/)).toBeInTheDocument();
      await user.click(within(dialog).getByRole('button', { name: /^confirm$/i }));
      await waitFor(() => expect(state.remove).toHaveBeenCalledWith('r_open'));
    });

    it('shows why deleting failed', async () => {
      vi.useRealTimers();
      state.remove.mockRejectedValue(new Error('Approved records are locked'));
      const user = userEvent.setup();
      renderTab();
      await user.click(screen.getByRole('button', { name: 'delete r_open' }));
      await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: /^confirm$/i }));
      await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Approved records are locked'));
    });

    it('has no create, edit or delete without permission', () => {
      state.permissions = new Set();
      renderTab();
      expect(screen.queryByRole('button', { name: t.addRecord })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'edit r_open' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'delete r_open' })).not.toBeInTheDocument();
    });
  });
});
