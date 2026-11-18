import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nProvider } from '@weldsuite/i18n/provider';
import type { HrSelfOverview, HrSelfProfile } from '@weldsuite/app-api-client/domains/weldhr';
import { MyHrProvider } from './my-hr-context';
import { MyHrRecord } from './my-hr-record';

const mocks = vi.hoisted(() => ({ clock: vi.fn(), navigate: vi.fn(), toastError: vi.fn() }));

let overview: HrSelfOverview;

vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, children, className }: { to: string; children: ReactNode; className?: string }) => (
    <a href={to} className={className}>
      {children}
    </a>
  ),
  useNavigate: () => mocks.navigate,
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: (message: string) => mocks.toastError(message) } }));
vi.mock('@/app/weldcalendar/lib/calendar-format', () => ({
  useTimeFormat: () => '24h',
  toTimeFormat: () => '24h',
}));
vi.mock('@/hooks/queries/use-weldhr-queries', () => ({
  useMyHrOverview: () => ({ data: overview, isLoading: false, error: null, refetch: vi.fn() }),
  useMyHrClock: () => ({ mutateAsync: mocks.clock, isPending: false }),
}));

const employee: HrSelfProfile = {
  id: 'hremp_ann',
  displayName: 'Ann Archer',
  firstName: 'Ann',
  lastName: 'Archer',
  email: 'ann@example.com',
  phone: null,
  avatarUrl: null,
  jobTitle: 'Engineer',
  employeeNumber: null,
  status: 'active',
  employmentType: 'full_time',
  startDate: '2026-01-05',
  location: null,
  departmentName: 'Product',
  manager: { displayName: 'Bea Boss', email: 'bea@example.com' },
  clients: [{ companyId: 'cmp_1', companyName: 'Acme', isPrimary: true }],
};

function makeOverview(extra: Partial<HrSelfOverview> = {}): HrSelfOverview {
  return {
    profile: employee,
    clock: { clockedIn: false, since: null, shiftId: null },
    upcomingShifts: [],
    leaveBalances: [],
    openTasks: 3,
    toAcknowledge: { coaching: 1, evaluations: 0 },
    latestEvaluation: null,
    milestones: { achieved: 1, open: 2 },
    unreadAnnouncements: 0,
    openShifts: 0,
    ...extra,
  } as HrSelfOverview;
}

function renderRecord(canClockIn = true) {
  return render(
    <I18nProvider initialLanguage="en">
      <MyHrProvider
        value={{
          employee,
          features: { selfClockIn: canClockIn, clockInRequiresLocation: false, leaveRequests: true, declarations: true },
        }}
      >
        <MyHrRecord employee={employee} canClockIn={canClockIn} />
      </MyHrProvider>
    </I18nProvider>,
  );
}

describe('MyHrRecord', () => {
  beforeEach(() => {
    mocks.clock.mockReset().mockResolvedValue({});
    mocks.navigate.mockReset();
    mocks.toastError.mockReset();
    overview = makeOverview();
  });

  it('shows the overview as property rows that link to the page behind them', () => {
    renderRecord();

    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual([
      'Details',
      'Leave balances',
      'Upcoming shifts',
    ]);
    expect(screen.getByText('Not clocked in')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '3' })).toHaveAttribute('href', '/weldhr/me/tasks');
    expect(screen.getByText('1 of 3 achieved')).toBeInTheDocument();
    expect(screen.getByText('Bea Boss')).toBeInTheDocument();
    expect(screen.getByText('Acme')).toBeInTheDocument();
  });

  it('clocks in from the header', async () => {
    const user = userEvent.setup();
    renderRecord();

    await user.click(screen.getByRole('button', { name: 'Clock in' }));
    expect(mocks.clock).toHaveBeenCalledWith({ action: 'in' });
  });

  it('has no clock for a workspace without self clock-in', () => {
    renderRecord(false);

    expect(screen.queryByRole('button', { name: 'Clock in' })).not.toBeInTheDocument();
    expect(screen.queryByText('Not clocked in')).not.toBeInTheDocument();
  });

  it('lists leave balances as rows, and a row opens Time off', async () => {
    overview = makeOverview({
      leaveBalances: [
        {
          leaveTypeId: 'lt_1',
          name: 'Annual leave',
          color: null,
          isPaid: true,
          overAllowance: 'allow',
          allowance: 25,
          fullAllowance: 25,
          prorated: false,
          used: 5,
          pending: 2,
          remaining: 18,
        },
      ],
    });
    const user = userEvent.setup();
    renderRecord();

    await user.click(screen.getByRole('tab', { name: /Leave balances/ }));
    expect(screen.getByText('Annual leave')).toBeInTheDocument();
    expect(screen.getByText('18')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Annual leave' }));
    expect(mocks.navigate).toHaveBeenCalledWith({ to: '/weldhr/me/time-off' });
  });

  it('shows the empty state when no shifts are planned', async () => {
    const user = userEvent.setup();
    renderRecord();

    await user.click(screen.getByRole('tab', { name: /Upcoming shifts/ }));
    expect(screen.getByText('No upcoming shifts')).toBeInTheDocument();
  });
});
