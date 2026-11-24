import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nProvider } from '@weldsuite/i18n/provider';
import type { HrSelfOverview, HrSelfProfile } from '@weldsuite/app-api-client/domains/weldhr';
import { MyHrProvider } from './my-hr-context';
import { MyHrRecord } from './my-hr-record';

interface StubProps {
  items: Array<{ id: string }>;
  filters: Array<{ field: string; options: Array<{ value: string; label: string }> }>;
  applyFilters: (rows: Array<{ id: string }>, active: Array<{ field: string; operator: string; value: string }>) => Array<{ id: string }>;
  renderRow: (row: { id: string }) => ReactNode;
}

const mocks = vi.hoisted(() => ({ navigate: vi.fn() }));
let overview: HrSelfOverview;

vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, children }: { to: string; children: ReactNode }) => <a href={to}>{children}</a>,
  useNavigate: () => mocks.navigate,
}));
vi.mock('@/app/weldcalendar/lib/calendar-format', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/app/weldcalendar/lib/calendar-format')>()),
  useTimeFormat: () => '24h',
  toTimeFormat: () => '24h',
}));
vi.mock('@/hooks/queries/use-weldhr-queries', () => ({
  useMyHrOverview: () => ({ data: overview, isLoading: false, error: null, refetch: vi.fn() }),
  useMyHrClock: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock('@/components/entity-list', async (importOriginal) => {
  const { useState } = await import('react');
  return {
    ...(await importOriginal<typeof import('@/components/entity-list')>()),
    EntityList: (props: StubProps) => {
      const [shown, setShown] = useState<Array<{ id: string }> | null>(null);
      return (
        <div>
          {props.filters.flatMap((filter) =>
            filter.options.map((option) => (
              <button
                key={`${filter.field}-${option.value}`}
                type="button"
                onClick={() => setShown(props.applyFilters(props.items, [{ field: filter.field, operator: 'is', value: option.value }]))}
              >
                filter {filter.field} {option.label}
              </button>
            )),
          )}
          <button type="button" onClick={() => setShown(props.applyFilters(props.items, [{ field: 'other', operator: 'is', value: 'x' }]))}>
            filter unknown
          </button>
          <div data-testid="rows">{(shown ?? props.items).map((row) => props.renderRow(row))}</div>
        </div>
      );
    },
  };
});

const employee: HrSelfProfile = {
  id: 'hremp_ann',
  displayName: 'Ann Archer',
  firstName: 'Ann',
  lastName: 'Archer',
  email: 'ann@example.com',
  phone: null,
  avatarUrl: null,
  jobTitle: null,
  employeeNumber: null,
  status: 'active',
  employmentType: 'full_time',
  startDate: '2026-01-05',
  location: null,
  departmentName: null,
  manager: null,
  clients: [],
};

beforeEach(() => {
  mocks.navigate.mockReset();
  overview = {
    profile: employee,
    clock: { clockedIn: false, since: null, shiftId: null },
    upcomingShifts: [
      { id: 'sh_1', startsAt: '2026-12-01T08:00:00.000Z', endsAt: '2026-12-01T16:00:00.000Z', companyName: 'Acme' },
      { id: 'sh_2', startsAt: '2026-12-02T08:00:00.000Z', endsAt: '2026-12-02T16:00:00.000Z', companyName: 'Globex' },
      { id: 'sh_3', startsAt: '2026-12-03T08:00:00.000Z', endsAt: '2026-12-03T16:00:00.000Z', companyName: 'Acme' },
      { id: 'sh_4', startsAt: '2026-12-04T08:00:00.000Z', endsAt: '2026-12-04T16:00:00.000Z', companyName: null },
    ],
    leaveBalances: [
      { leaveTypeId: 'lt_a', name: 'Annual leave', color: null, isPaid: true, overAllowance: 'allow', allowance: 25, fullAllowance: 25, prorated: false, used: 5, pending: 0, remaining: 20 },
      { leaveTypeId: 'lt_s', name: 'Study day', color: null, isPaid: true, overAllowance: 'allow', allowance: 3, fullAllowance: 3, prorated: false, used: 0, pending: 0, remaining: 3 },
    ],
    openTasks: 0,
    toAcknowledge: { coaching: 0, evaluations: 0 },
    latestEvaluation: null,
    milestones: { achieved: 0, open: 0 },
  };
});

function renderRecord() {
  return render(
    <I18nProvider initialLanguage="en">
      <MyHrProvider value={{ employee, features: { selfClockIn: false, clockInRequiresLocation: false, leaveRequests: true, declarations: true } }}>
        <MyHrRecord employee={employee} canClockIn={false} />
      </MyHrProvider>
    </I18nProvider>,
  );
}

describe('MyHrRecord list filters', () => {
  it('filters the leave balances by leave type', async () => {
    const user = userEvent.setup();
    renderRecord();
    await user.click(screen.getByRole('tab', { name: /Leave balances/ }));

    expect(screen.getByRole('button', { name: 'Annual leave' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'filter type Study day' }));
    expect(screen.queryByRole('button', { name: 'Annual leave' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Study day' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'filter unknown' }));
    expect(screen.getByRole('button', { name: 'Annual leave' })).toBeInTheDocument();
  });

  it('filters the upcoming shifts by client, listing each client once, sorted', async () => {
    const user = userEvent.setup();
    renderRecord();
    await user.click(screen.getByRole('tab', { name: /Upcoming shifts/ }));

    expect(screen.getAllByRole('button', { name: /^filter client / }).map((button) => button.textContent)).toEqual([
      'filter client Acme',
      'filter client Globex',
    ]);
    expect(screen.getByTestId('rows').children).toHaveLength(4);

    await user.click(screen.getByRole('button', { name: 'filter client Acme' }));
    expect(screen.getByTestId('rows').children).toHaveLength(2);

    await user.click(screen.getByRole('button', { name: 'filter unknown' }));
    expect(screen.getByTestId('rows').children).toHaveLength(4);
  });
});
