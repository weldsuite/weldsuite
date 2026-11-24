import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { setHrFormatLocale } from '@/app/weldhr/components/shared';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';
import { I18nProvider } from '@weldsuite/i18n/provider';
import { en } from '@weldsuite/i18n/locales/en';
import type { HrAbsence, HrAbsenceStatus } from '@weldsuite/app-api-client/domains/weldhr';
import { AbsencesTab } from './absences-tab';

const t = en.weldhr.absenteeism;

const state = vi.hoisted(() => ({
  permissions: new Set<string>(),
  absences: undefined as unknown,
  isLoading: false,
  error: null as Error | null,
  queries: [] as unknown[],
  employeeOptions: [] as unknown[],
  remove: vi.fn(),
}));

vi.mock('@weldsuite/permissions/react', () => ({ usePermissions: () => ({ can: (p: string) => state.permissions.has(p) }) }));
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));
vi.mock('@/components/panel-entity-list', () => import('@/components/panel-entity-list-test-mock'));
vi.mock('./absence-dialog', () => ({
  AbsenceDialog: (p: { mode: { kind: string; absence?: { id: string } }; onClose: () => void }) => (
    <button onClick={p.onClose}>{`absence dialog ${p.mode.kind} ${p.mode.absence?.id ?? ''}`.trim()}</button>
  ),
}));
vi.mock('./recover-dialog', () => ({
  RecoverDialog: (p: { absence: { id: string }; employeeName: string; onClose: () => void }) => (
    <button onClick={p.onClose}>{`recover ${p.absence.id} ${p.employeeName}`}</button>
  ),
}));
vi.mock('@/hooks/queries/use-weldhr-queries', () => ({
  useHrAbsences: (params: unknown) => {
    state.queries.push(params);
    return { data: state.absences, isLoading: state.isLoading, isFetching: false, error: state.error };
  },
  useHrEmployees: (_params: unknown, opts: { enabled: boolean }) => {
    state.employeeOptions.push(opts);
    return { data: { data: [{ id: 'emp_1', displayName: 'Anna de Vries' }] } };
  },
  useHrDepartments: () => ({ data: [{ id: 'dep_1', name: 'Sales' }] }),
  useDeleteHrAbsence: () => ({ mutateAsync: state.remove }),
}));

function absence(over: Partial<HrAbsence> & { id: string }): HrAbsence {
  return {
    employeeId: 'emp_1',
    employeeName: 'Anna de Vries',
    departmentName: 'Sales',
    startDate: '2026-11-16',
    endDate: '2026-11-18',
    firstDay: 'full',
    note: 'Flu',
    status: 'completed',
    days: 3,
    relapse: false,
    reportedBySelf: false,
    reportedByName: 'HR Hannah',
    recoveredReportedAt: null,
    createdAt: '2026-11-16T09:00:00Z',
    ...over,
  } as HrAbsence;
}

function renderTab(status: HrAbsenceStatus = 'ongoing') {
  return render(
    <I18nProvider initialLanguage="en">
      <AbsencesTab status={status} />
    </I18nProvider>,
  );
}

const ALL = ['absences:create', 'absences:update', 'absences:delete', 'employees:read'];

beforeEach(() => {
  state.permissions = new Set(ALL);
  state.isLoading = false;
  state.error = null;
  state.queries = [];
  state.employeeOptions = [];
  state.remove.mockReset().mockResolvedValue(undefined);
  vi.mocked(toast.error).mockReset();
  state.absences = {
    data: [
      absence({ id: 'a_open', endDate: null, relapse: true, firstDay: 'half', days: 2.5, note: null, reportedBySelf: true, status: 'ongoing' }),
      absence({ id: 'a_soon', endDate: '2026-11-30', status: 'ongoing' }),
      absence({ id: 'a_weekend', startDate: '2026-11-21', endDate: '2026-11-22', days: 0, reportedByName: null }),
    ],
    pagination: { hasMore: false },
  };
});

// The dates below read as WeldHR writes them in en-GB, whatever the machine's locale.
beforeAll(() => setHrFormatLocale('en-GB'));
afterAll(() => setHrFormatLocale(undefined));

describe('AbsencesTab', () => {
  it('asks for the reports of its status', () => {
    renderTab('completed');
    expect(state.queries[0]).toMatchObject({ status: 'completed', limit: 50 });
  });

  it('shows the first sick day with a half-day marker, and still absent for an open report', () => {
    renderTab();
    const open = within(screen.getByTestId('row-a_open'));
    expect(open.getByText(new RegExp(t.halfFirstDay))).toBeInTheDocument();
    expect(open.getByText(t.stillAbsent)).toBeInTheDocument();
    expect(screen.getByTestId('row-a_open').querySelector('[data-column="days"]')).toHaveTextContent(/2[.,]5/);
  });

  it('marks a relapse', () => {
    renderTab();
    expect(within(screen.getByTestId('row-a_open')).getByText(t.relapse)).toBeInTheDocument();
    expect(within(screen.getByTestId('row-a_soon')).queryByText(t.relapse)).not.toBeInTheDocument();
  });

  it('shows Weekend instead of a bare 0 for a report that only covers a weekend', () => {
    renderTab();
    expect(within(screen.getByTestId('row-a_weekend')).getByText(en.weldhr.common.weekend)).toBeInTheDocument();
  });

  it('names the employee for a self-report, and who filed it otherwise, with a dash for no one', () => {
    renderTab();
    const reportedBy = (id: string) => screen.getByTestId(`row-${id}`).querySelector('[data-column="reportedBy"]')!;
    expect(reportedBy('a_open')).toHaveTextContent('Anna de Vries');
    expect(reportedBy('a_soon')).toHaveTextContent('HR Hannah');
    expect(reportedBy('a_weekend')).toHaveTextContent('—');
  });

  it('shows the note, with a dash for none', () => {
    renderTab();
    const note = (id: string) => screen.getByTestId(`row-${id}`).querySelector('[data-column="note"]')!;
    expect(note('a_soon')).toHaveTextContent('Flu');
    expect(note('a_open')).toHaveTextContent('—');
  });

  describe('Ongoing', () => {
    it('offers Report recovered for an open report, and says when a dated one moves', async () => {
      const user = userEvent.setup();
      renderTab('ongoing');
      await user.click(within(screen.getByTestId('row-a_open')).getByRole('button', { name: t.reportRecovered }));
      expect(screen.getByRole('button', { name: 'recover a_open Anna de Vries' })).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: /^recover/ }));
      expect(screen.queryByRole('button', { name: /^recover/ })).not.toBeInTheDocument();

      expect(within(screen.getByTestId('row-a_soon')).queryByRole('button', { name: t.reportRecovered })).not.toBeInTheDocument();
      expect(screen.getByTestId('row-a_soon').querySelector('[data-column="recover"]')).toHaveTextContent(/30 Nov 2026/);
    });

    it('has no recover column without permission to update', () => {
      state.permissions = new Set(['absences:create']);
      renderTab('ongoing');
      expect(screen.queryByRole('button', { name: t.reportRecovered })).not.toBeInTheDocument();
    });
  });

  describe('Completed', () => {
    it('has no recover column', () => {
      renderTab('completed');
      expect(screen.queryByRole('button', { name: t.reportRecovered })).not.toBeInTheDocument();
      expect(screen.getByTestId('row-a_open').querySelector('[data-column="recover"]')).toBeNull();
    });

    it('shows the completed empty state', () => {
      state.absences = { data: [], pagination: { hasMore: false } };
      renderTab('completed');
      expect(screen.getByText(t.list.emptyCompleted.title)).toBeInTheDocument();
    });
  });

  it('shows the ongoing empty state', () => {
    state.absences = undefined;
    renderTab('ongoing');
    expect(screen.getByText(t.list.emptyOngoing.title)).toBeInTheDocument();
  });

  it('shows loading and error', () => {
    state.isLoading = true;
    const first = renderTab();
    expect(screen.getByText('loading')).toBeInTheDocument();
    first.unmount();
    state.isLoading = false;
    state.error = new Error('Server down');
    renderTab();
    expect(screen.getByRole('alert')).toHaveTextContent('Server down');
  });

  it('searches the reports by employee, note, reporter and department', async () => {
    const user = userEvent.setup();
    renderTab();
    await user.type(screen.getByLabelText('search'), 'hannah');
    expect(screen.getByTestId('row-a_soon')).toBeInTheDocument();
    expect(screen.queryByTestId('row-a_weekend')).not.toBeInTheDocument();
  });

  it('offers employee and department filters to someone who may read employees', () => {
    renderTab();
    expect(screen.getByRole('group', { name: 'filter employeeId' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'filter departmentId' })).toBeInTheDocument();
    expect(state.employeeOptions).toContainEqual({ enabled: true });
  });

  it('has no filters, and does not load employees, without permission to read them', () => {
    state.permissions = new Set(['absences:update']);
    renderTab();
    expect(screen.queryByRole('group', { name: 'filter employeeId' })).not.toBeInTheDocument();
    expect(state.employeeOptions).toContainEqual({ enabled: false });
  });

  describe('create, edit and delete', () => {
    it('reports sick for an employee', async () => {
      const user = userEvent.setup();
      renderTab();
      await user.click(screen.getByRole('button', { name: t.reportSick }));
      await user.click(screen.getByRole('button', { name: 'absence dialog create' }));
      expect(screen.queryByRole('button', { name: /absence dialog/ })).not.toBeInTheDocument();
    });

    it('edits a report', async () => {
      const user = userEvent.setup();
      renderTab();
      await user.click(screen.getByRole('button', { name: 'edit a_soon' }));
      expect(screen.getByRole('button', { name: 'absence dialog edit a_soon' })).toBeInTheDocument();
    });

    it('deletes after confirming', async () => {
      const user = userEvent.setup();
      renderTab();
      await user.click(screen.getByRole('button', { name: 'delete a_soon' }));
      const dialog = await screen.findByRole('dialog');
      expect(within(dialog).getByText(t.deleteConfirmTitle)).toBeInTheDocument();
      await user.click(within(dialog).getByRole('button', { name: /^confirm$/i }));
      await waitFor(() => expect(state.remove).toHaveBeenCalledWith('a_soon'));
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    });

    it('shows why deleting failed, and a general message without a reason', async () => {
      const user = userEvent.setup();
      renderTab();
      state.remove.mockRejectedValueOnce(new Error('Locked'));
      await user.click(screen.getByRole('button', { name: 'delete a_soon' }));
      await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: /^confirm$/i }));
      await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Locked'));

      state.remove.mockRejectedValueOnce('x');
      await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: /^confirm$/i }));
      await waitFor(() => expect(toast.error).toHaveBeenCalledWith(t.deleteFailed));
    });

    it('has no create, edit or delete without permission', () => {
      state.permissions = new Set();
      renderTab();
      expect(screen.queryByRole('button', { name: t.reportSick })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'edit a_soon' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'delete a_soon' })).not.toBeInTheDocument();
    });
  });
});
