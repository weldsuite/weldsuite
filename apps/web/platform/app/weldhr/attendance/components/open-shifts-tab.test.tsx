import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { toast } from 'sonner';
import { I18nProvider } from '@weldsuite/i18n/provider';
import { en } from '@weldsuite/i18n/locales/en';
import type { HrOpenShift } from '@weldsuite/app-api-client/domains/weldhr';
import { latest } from '@/components/panel-entity-list-test-mock';
import { OpenShiftsTab } from './open-shifts-tab';

const t = en.weldhr.attendance.openShifts;

const state = vi.hoisted(() => ({
  permissions: new Set<string>(),
  data: undefined as unknown,
  isLoading: false,
  error: null as Error | null,
  params: [] as unknown[],
  withdraw: vi.fn(),
}));

vi.mock('@weldsuite/permissions/react', () => ({ usePermissions: () => ({ can: (p: string) => state.permissions.has(p) }) }));
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));
vi.mock('@/components/panel-entity-list', () => import('@/components/panel-entity-list-test-mock'));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, search, title, children }: { to: string; search: { tab: string }; title?: string; children: ReactNode }) => (
    <a href={`${to}?tab=${search.tab}`} title={title}>
      {children}
    </a>
  ),
}));
vi.mock('@/app/weldcalendar/lib/calendar-format', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/app/weldcalendar/lib/calendar-format')>()),
  useTimeFormat: () => '24h',
}));
vi.mock('./open-shift-dialog', () => ({
  OpenShiftDialog: (p: { shift?: { id: string }; onClose: () => void }) => (
    <button onClick={p.onClose}>{p.shift ? `edit dialog ${p.shift.id}` : 'create dialog'}</button>
  ),
}));
vi.mock('@/hooks/queries/use-weldhr-queries', () => ({
  useHrOpenShifts: (params: unknown) => {
    state.params.push(params);
    return { data: state.data, isLoading: state.isLoading, error: state.error };
  },
  useCancelHrOpenShift: () => ({ mutateAsync: state.withdraw }),
}));

function openShift(over: Partial<HrOpenShift> & { id: string }): HrOpenShift {
  return {
    companyId: null,
    companyName: null,
    departmentId: null,
    departmentName: null,
    startsAt: '2026-11-25T09:00:00',
    endsAt: '2026-11-25T17:00:00',
    workType: 'Cashier',
    breakStartsAt: null,
    breakEndsAt: null,
    notes: null,
    spots: 2,
    status: 'open',
    filled: 1,
    pending: 0,
    spotsLeft: 1,
    createdBy: null,
    createdAt: '2026-11-20T08:00:00',
    updatedAt: '2026-11-20T08:00:00',
    ...over,
  };
}

function renderTab() {
  return render(
    <I18nProvider initialLanguage="en">
      <OpenShiftsTab />
    </I18nProvider>,
  );
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-23T10:00:00'));
  state.permissions = new Set(['attendance:create', 'attendance:update', 'attendance:delete']);
  state.isLoading = false;
  state.error = null;
  state.params = [];
  state.withdraw.mockReset().mockResolvedValue(undefined);
  vi.mocked(toast.error).mockReset();
  state.data = [
    openShift({ id: 'os_open', companyName: 'Acme', departmentName: 'Shop', pending: 3 }),
    openShift({ id: 'os_full', workType: null, filled: 2, spotsLeft: 0, pending: 0, companyName: 'Globex' }),
    openShift({ id: 'os_cancelled', status: 'cancelled', pending: 1 }),
  ];
});

afterEach(() => vi.useRealTimers());

describe('OpenShiftsTab', () => {
  it('asks for the open shifts from today on', () => {
    renderTab();
    expect(state.params).toContainEqual({ from: '2026-11-23' });
  });

  it('groups open and withdrawn shifts', () => {
    renderTab();
    const open = within(screen.getByRole('region', { name: t.groups.open }));
    expect(open.getByTestId('row-os_open')).toBeInTheDocument();
    expect(open.getByTestId('row-os_full')).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: t.groups.cancelled })).getByTestId('row-os_cancelled')).toBeInTheDocument();
  });

  it('shows the work type, or the day when there is none, with the time range and client', () => {
    renderTab();
    expect(within(screen.getByTestId('row-os_open')).getByText('Cashier', { selector: 'p' })).toBeInTheDocument();
    expect(within(screen.getByTestId('row-os_open')).getAllByText(/09:00 – 17:00/).length).toBeGreaterThan(0);
    expect(within(screen.getByTestId('row-os_open')).getAllByText(/Acme/).length).toBeGreaterThan(0);
    // No work type: the first line falls back to the weekday date.
    expect(within(screen.getByTestId('row-os_full')).getByText(/25 Nov 2026/, { selector: 'p.font-medium' })).toBeInTheDocument();
  });

  it('shows the department or Everyone, and dashes for no client', () => {
    renderTab();
    expect(within(screen.getByTestId('row-os_open')).getByText('Shop')).toBeInTheDocument();
    const full = within(screen.getByTestId('row-os_full'));
    expect(full.getByText(t.everyone)).toBeInTheDocument();
    expect(within(screen.getByTestId('row-os_cancelled')).getAllByText('—').length).toBeGreaterThan(0);
  });

  it('shows how many spots are filled', () => {
    renderTab();
    expect(within(screen.getByTestId('row-os_open')).getByText('1 of 2 filled')).toBeInTheDocument();
  });

  it('links waiting sign-ups to the Requests tab, and shows a dash without any', () => {
    renderTab();
    const link = within(screen.getByTestId('row-os_open')).getByRole('link', { name: '3 waiting' });
    expect(link).toHaveAttribute('href', '/weldhr/attendance?tab=requests');
    expect(link).toHaveAttribute('title', t.reviewSignUps);
    expect(within(screen.getByTestId('row-os_full')).queryByRole('link')).not.toBeInTheDocument();
  });

  it('labels a shift Open, Full or Withdrawn', () => {
    renderTab();
    const status = en.weldhr.status.openShift;
    expect(within(screen.getByTestId('row-os_open')).getAllByText(status.open).length).toBeGreaterThan(0);
    expect(within(screen.getByTestId('row-os_full')).getAllByText(status.full).length).toBeGreaterThan(0);
    expect(within(screen.getByTestId('row-os_cancelled')).getAllByText(status.cancelled).length).toBeGreaterThan(0);
  });

  it('shows loading, error and the empty state with its create action', async () => {
    vi.useRealTimers();
    const user = userEvent.setup();
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
    state.data = undefined;
    renderTab();
    expect(screen.getByText(t.empty.title)).toBeInTheDocument();
    const buttons = screen.getAllByRole('button', { name: t.add });
    expect(buttons).toHaveLength(2);
    await user.click(buttons[1]!);
    expect(screen.getByRole('button', { name: 'create dialog' })).toBeInTheDocument();
  });

  it('has no create buttons without permission', () => {
    state.permissions = new Set();
    state.data = [];
    renderTab();
    expect(screen.queryByRole('button', { name: t.add })).not.toBeInTheDocument();
  });

  it('searches by work type, client, department and notes', async () => {
    vi.useRealTimers();
    const user = userEvent.setup();
    renderTab();
    await user.type(screen.getByLabelText('search'), 'globex');
    expect(screen.getByTestId('row-os_full')).toBeInTheDocument();
    expect(screen.queryByTestId('row-os_open')).not.toBeInTheDocument();
  });

  it('filters by status, client and department', async () => {
    vi.useRealTimers();
    const user = userEvent.setup();
    renderTab();
    await user.click(screen.getByRole('button', { name: 'status=full' }));
    expect(screen.getByTestId('row-os_full')).toBeInTheDocument();
    expect(screen.queryByTestId('row-os_open')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'status=cancelled' }));
    expect(screen.getByTestId('row-os_cancelled')).toBeInTheDocument();
    expect(screen.queryByTestId('row-os_full')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'client=Acme' }));
    expect(screen.getByTestId('row-os_open')).toBeInTheDocument();
    expect(screen.queryByTestId('row-os_full')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'department=Shop' }));
    expect(screen.getByTestId('row-os_open')).toBeInTheDocument();
  });

  it('leaves the rows alone for a filter without a value or on an unknown field', () => {
    renderTab();
    const rows = state.data as never[];
    expect(latest.applyFilters?.(rows, [{ id: 'a', field: 'status', operator: 'is', value: '' }])).toHaveLength(rows.length);
    expect(latest.applyFilters?.(rows, [{ id: 'b', field: 'unknown', operator: 'is', value: 'x' }])).toHaveLength(rows.length);
  });

  describe('edit', () => {
    it('edits an open shift', async () => {
      vi.useRealTimers();
      const user = userEvent.setup();
      renderTab();
      await user.click(screen.getByRole('button', { name: 'edit os_open' }));
      await user.click(screen.getByRole('button', { name: 'edit dialog os_open' }));
      expect(screen.queryByRole('button', { name: /^edit dialog/ })).not.toBeInTheDocument();
    });

    it('does nothing for a withdrawn shift', async () => {
      vi.useRealTimers();
      const user = userEvent.setup();
      renderTab();
      await user.click(screen.getByRole('button', { name: 'edit os_cancelled' }));
      expect(screen.queryByRole('button', { name: /dialog/ })).not.toBeInTheDocument();
    });

    it('has no edit without the update permission', () => {
      state.permissions = new Set(['attendance:create']);
      renderTab();
      expect(screen.queryByRole('button', { name: 'edit os_open' })).not.toBeInTheDocument();
    });
  });

  describe('withdraw', () => {
    it('only offers Withdraw on an open shift, with the permission', () => {
      renderTab();
      expect(within(screen.getByTestId('row-os_open')).getByRole('button', { name: t.withdraw })).toBeInTheDocument();
      expect(within(screen.getByTestId('row-os_cancelled')).queryByRole('button', { name: t.withdraw })).not.toBeInTheDocument();
    });

    it('has no Withdraw without the delete permission', () => {
      state.permissions = new Set(['attendance:create']);
      renderTab();
      expect(screen.queryByRole('button', { name: t.withdraw })).not.toBeInTheDocument();
    });

    it('warns about the waiting sign-ups that get cancelled', async () => {
      vi.useRealTimers();
      const user = userEvent.setup();
      renderTab();
      await user.click(within(screen.getByTestId('row-os_open')).getByRole('button', { name: t.withdraw }));
      const dialog = await screen.findByRole('dialog');
      expect(within(dialog).getByText(/the 3 sign-ups still waiting are cancelled/)).toBeInTheDocument();
    });

    it('withdraws after confirming', async () => {
      vi.useRealTimers();
      const user = userEvent.setup();
      renderTab();
      await user.click(within(screen.getByTestId('row-os_full')).getByRole('button', { name: t.withdraw }));
      const dialog = await screen.findByRole('dialog');
      expect(within(dialog).getByText(t.withdrawDescription)).toBeInTheDocument();
      await user.click(within(dialog).getByRole('button', { name: t.withdraw }));
      await waitFor(() => expect(state.withdraw).toHaveBeenCalledWith('os_full'));
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    });

    it('keeps the shift when the confirmation is cancelled', async () => {
      vi.useRealTimers();
      const user = userEvent.setup();
      renderTab();
      await user.click(within(screen.getByTestId('row-os_full')).getByRole('button', { name: t.withdraw }));
      const dialog = await screen.findByRole('dialog');
      await user.click(within(dialog).getByRole('button', { name: en.weldhr.common.cancel }));
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
      expect(state.withdraw).not.toHaveBeenCalled();
    });

    it('shows the error when withdrawing fails', async () => {
      vi.useRealTimers();
      state.withdraw.mockRejectedValue(new Error('Has approved sign-ups'));
      const user = userEvent.setup();
      renderTab();
      await user.click(within(screen.getByTestId('row-os_full')).getByRole('button', { name: t.withdraw }));
      const dialog = await screen.findByRole('dialog');
      await user.click(within(dialog).getByRole('button', { name: t.withdraw }));
      await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Has approved sign-ups'));
      expect(screen.getByRole('dialog')).toBeInTheDocument();
    });

    it('falls back to a general message when the failure has none', async () => {
      vi.useRealTimers();
      state.withdraw.mockRejectedValue('x');
      const user = userEvent.setup();
      renderTab();
      await user.click(within(screen.getByTestId('row-os_full')).getByRole('button', { name: t.withdraw }));
      const dialog = await screen.findByRole('dialog');
      await user.click(within(dialog).getByRole('button', { name: t.withdraw }));
      await waitFor(() => expect(toast.error).toHaveBeenCalledWith(t.withdrawFailed));
    });
  });
});
