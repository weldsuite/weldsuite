import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nProvider } from '@weldsuite/i18n/provider';
import type { HrSelfOverview, HrSelfProfile } from '@weldsuite/app-api-client/domains/weldhr';
import { MyHrProvider } from './my-hr-context';
import { MyHrRecord } from './my-hr-record';

const mocks = vi.hoisted(() => ({ clock: vi.fn(), navigate: vi.fn(), toastError: vi.fn(), position: vi.fn(), refetch: vi.fn() }));

let overview: HrSelfOverview | undefined;

vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, children, className }: { to: string; children: ReactNode; className?: string }) => (
    <a href={to} className={className}>
      {children}
    </a>
  ),
  useNavigate: () => mocks.navigate,
}));
vi.mock('../../lib/geolocation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/geolocation')>()),
  getDevicePosition: () => mocks.position(),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: (message: string) => mocks.toastError(message) } }));
vi.mock('@/app/weldcalendar/lib/calendar-format', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/app/weldcalendar/lib/calendar-format')>()),
  useTimeFormat: () => '24h',
  toTimeFormat: () => '24h',
}));
vi.mock('@/hooks/queries/use-weldhr-queries', () => ({
  useMyHrOverview: () => ({ data: overview, isLoading: false, error: overview ? null : new Error('Server unavailable'), refetch: mocks.refetch }),
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

function renderRecord(canClockIn = true, requiresLocation = false, who: HrSelfProfile = employee) {
  return render(
    <I18nProvider initialLanguage="en">
      <MyHrProvider
        value={{
          employee,
          features: { selfClockIn: canClockIn, clockInRequiresLocation: requiresLocation, leaveRequests: true, declarations: true },
        }}
      >
        <MyHrRecord employee={who} canClockIn={canClockIn} />
      </MyHrProvider>
    </I18nProvider>,
  );
}

describe('MyHrRecord', () => {
  beforeEach(() => {
    mocks.clock.mockReset().mockResolvedValue({});
    mocks.navigate.mockReset();
    mocks.toastError.mockReset();
    mocks.position.mockReset();
    mocks.refetch.mockReset();
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

  it('shows since when someone is clocked in today, and clocks them out', async () => {
    const since = new Date();
    since.setHours(8, 30, 0, 0);
    overview = makeOverview({ clock: { clockedIn: true, since: since.toISOString(), shiftId: null } });
    const user = userEvent.setup();
    renderRecord();

    expect(screen.getByText('Clocked in since 08:30')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Clock out' }));
    expect(mocks.clock).toHaveBeenCalledWith({ action: 'out' });
  });

  it('sends the device position where the workspace asks for it', async () => {
    mocks.position.mockResolvedValue({ latitude: 52.37, longitude: 4.89, accuracy: 12 });
    const user = userEvent.setup();
    renderRecord(true, true);

    await user.click(screen.getByRole('button', { name: 'Clock in' }));
    expect(mocks.clock).toHaveBeenCalledWith({ action: 'in', location: { latitude: 52.37, longitude: 4.89, accuracy: 12 } });
  });

  it('explains a blocked position apart from a refusal by the server', async () => {
    const { GeolocationError } = await import('../../lib/geolocation');
    mocks.position.mockRejectedValue(new GeolocationError('denied'));
    const user = userEvent.setup();
    const { unmount } = renderRecord(true, true);

    await user.click(screen.getByRole('button', { name: 'Clock in' }));
    expect(mocks.toastError).toHaveBeenCalledWith(
      'Location access is blocked. Allow it for this site in your browser settings to clock in or out.',
    );
    expect(mocks.clock).not.toHaveBeenCalled();
    unmount();

    mocks.clock.mockRejectedValue(new Error('Outside every work location'));
    renderRecord();
    await user.click(screen.getByRole('button', { name: 'Clock in' }));
    expect(mocks.toastError).toHaveBeenLastCalledWith(expect.stringMatching(/Outside every work location|Could not update your clock/));
  });

  it('opens the schedule from an upcoming shift', async () => {
    overview = makeOverview({
      upcomingShifts: [{ id: 'sh_1', startsAt: '2026-12-01T08:00:00.000Z', endsAt: '2026-12-01T16:00:00.000Z', companyName: 'Acme' }],
    });
    const user = userEvent.setup();
    renderRecord();

    await user.click(screen.getByRole('tab', { name: /Upcoming shifts/ }));
    await user.click(screen.getAllByRole('button').find((b) => /2026|Dec/.test(b.getAttribute('aria-label') ?? b.textContent ?? ''))!);
    expect(mocks.navigate).toHaveBeenCalledWith({ to: '/weldhr/me/schedule' });
  });

  it('offers a retry when the overview could not load', async () => {
    overview = undefined;
    const user = userEvent.setup();
    renderRecord();

    expect(screen.getByText('Server unavailable')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(mocks.refetch).toHaveBeenCalled();
  });

  it('lists what there is to acknowledge, with singular and plural evaluations', () => {
    overview = makeOverview({ toAcknowledge: { coaching: 0, evaluations: 1 } });
    const { unmount } = renderRecord();
    const one = screen.getAllByRole('link').find((link) => link.getAttribute('href') === '/weldhr/me/reviews' && /valuation/.test(link.textContent ?? ''));
    expect(one?.textContent).toBe('1 evaluation');
    unmount();

    overview = makeOverview({ toAcknowledge: { coaching: 2, evaluations: 3 } });
    renderRecord();
    const both = screen.getAllByRole('link').find((link) => /3 evaluations/.test(link.textContent ?? ''));
    expect(both?.textContent).toMatch(/2 coaching.*3 evaluations/);
  });

  it('says there is nothing to acknowledge', () => {
    overview = makeOverview({ toAcknowledge: { coaching: 0, evaluations: 0 } });
    renderRecord();

    expect(screen.getByText('Nothing to confirm')).toBeInTheDocument();
  });

  it('shows the latest evaluation as a score badge with its form and date', () => {
    overview = makeOverview({
      latestEvaluation: { id: 'ev_1', overallScore: 4.25, formName: 'Annual review', submittedAt: '2026-10-15T09:00:00.000Z' },
    });
    renderRecord();

    expect(screen.getByRole('link', { name: '4.3' })).toHaveAttribute('href', '/weldhr/me/reviews');
    expect(screen.getByText(/Annual review · .*2026/)).toBeInTheDocument();
  });

  it('shows a latest evaluation without score, form or date', () => {
    overview = makeOverview({ latestEvaluation: { id: 'ev_1', overallScore: null, formName: null, submittedAt: null } });
    renderRecord();

    expect(screen.getByRole('link', { name: '—' })).toHaveAttribute('href', '/weldhr/me/reviews');
  });

  it('shows the profile with an avatar, no manager and a client without a name', () => {
    const sparse: HrSelfProfile = {
      ...employee,
      avatarUrl: 'https://example.com/ann.png',
      manager: null,
      phone: '+31 6 12345678',
      employeeNumber: 'E-17',
      clients: [
        { companyId: 'cmp_1', companyName: null, isPrimary: false },
        { companyId: 'cmp_2', companyName: 'Globex', isPrimary: true },
      ],
    };
    renderRecord(true, false, sparse);

    expect(screen.queryByText('Bea Boss')).not.toBeInTheDocument();
    expect(screen.getByText('cmp_1')).toBeInTheDocument();
    expect(screen.getByText('Globex')).toBeInTheDocument();
    expect(screen.getByText('E-17')).toBeInTheDocument();
  });

  it('falls back to a # avatar for a nameless profile', () => {
    renderRecord(true, false, { ...employee, displayName: ' ', avatarUrl: null });

    expect(screen.getByText('#')).toBeInTheDocument();
  });

  it('shows the date and time of a clock-in from an earlier day', () => {
    overview = makeOverview({ clock: { clockedIn: true, since: '2020-03-02T08:30:00.000Z', shiftId: null } });
    renderRecord();

    expect(screen.getByText(/Clocked in since .*Mar/)).toBeInTheDocument();
  });

  it('shows unlimited leave balances', async () => {
    overview = makeOverview({
      leaveBalances: [
        { leaveTypeId: 'lt_u', name: 'Unpaid', color: '#336699', isPaid: false, overAllowance: 'allow', allowance: null, fullAllowance: null, prorated: false, used: 1, pending: 0, remaining: null },
      ],
    });
    const user = userEvent.setup();
    renderRecord();

    await user.click(screen.getByRole('tab', { name: /Leave balances/ }));
    expect(screen.getAllByText('Unlimited')).toHaveLength(2);
  });

  it('shows a shift without a client', async () => {
    overview = makeOverview({
      upcomingShifts: [{ id: 'sh_2', startsAt: '2026-12-01T08:00:00.000Z', endsAt: '2026-12-01T16:00:00.000Z', companyName: null }],
    });
    const user = userEvent.setup();
    renderRecord();

    await user.click(screen.getByRole('tab', { name: /Upcoming shifts/ }));
    expect(screen.getByText('—')).toBeInTheDocument();
  });
});
