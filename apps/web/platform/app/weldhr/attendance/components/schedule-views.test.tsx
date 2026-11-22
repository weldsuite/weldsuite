import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { I18nProvider } from '@weldsuite/i18n/provider';
import type { HrAbsence, HrEmployee, HrLeaveRequest, HrShift } from '@weldsuite/app-api-client/domains/weldhr';
import { buildDayStats, groupByDepartment, viewDays, type RosterEmployee, type TimeOff } from './schedule-model';
import { ScheduleDayView } from './schedule-day-view';
import { ScheduleMonthView } from './schedule-month-view';
import { ScheduleTab } from './schedule-tab';
import { ScheduleWeekView } from './schedule-week-view';

const mocks = vi.hoisted(() => ({
  shifts: [] as HrShift[],
  employees: [] as HrEmployee[],
  leave: [] as HrLeaveRequest[],
  absences: [] as HrAbsence[],
}));

vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, children, className }: { to: string; children: ReactNode; className?: string }) => (
    <a href={to} className={className}>
      {children}
    </a>
  ),
}));
vi.mock('@weldsuite/permissions/react', () => ({ usePermissions: () => ({ can: () => true }) }));
vi.mock('@/app/weldcalendar/lib/calendar-format', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/app/weldcalendar/lib/calendar-format')>()),
  useTimeFormat: () => '24h',
}));
vi.mock('@/components/entity-list', () => ({ FilterPills: () => null }));
vi.mock('./shift-dialog', () => ({ ShiftDialog: () => <div role="dialog" /> }));
vi.mock('@/hooks/queries/use-weldhr-queries', () => ({
  useHrShifts: () => ({ data: mocks.shifts, isLoading: false, error: null }),
  useHrEmployees: () => ({ data: { data: mocks.employees }, isLoading: false }),
  useHrLeaveRequests: () => ({ data: mocks.leave }),
  useHrAbsences: () => ({ data: { data: mocks.absences } }),
  useDeleteHrShift: () => ({ mutateAsync: vi.fn() }),
}));

/** Monday 16 to Sunday 22 November 2026. */
const WEEK = viewDays('2026-11-18', 'week');

function at(day: number, hour: number, minute = 0): string {
  return new Date(2026, 10, day, hour, minute).toISOString();
}

function shift(id: string, employeeId: string, start: string, end: string, extra: Partial<HrShift> = {}): HrShift {
  return {
    id,
    employeeId,
    employeeName: employeeId,
    companyId: null,
    companyName: null,
    startsAt: start,
    endsAt: end,
    workType: null,
    breakStartsAt: null,
    breakEndsAt: null,
    notes: null,
    ...extra,
  };
}

function person(id: string, name: string, departmentName: string | null = 'Shop'): RosterEmployee {
  return { id, name, avatarUrl: null, departmentName, jobTitle: null, clientIds: [] };
}

function timeOff(overrides: Partial<TimeOff>): TimeOff {
  return { id: 'to', employeeId: 'e2', kind: 'leave', pending: false, typeName: 'Holiday', color: '#14b8a6', startDate: '2026-11-18', endDate: '2026-11-20', ...overrides };
}

function byCell(shifts: HrShift[]): Map<string, HrShift[]> {
  const map = new Map<string, HrShift[]>();
  for (const s of shifts) {
    const d = new Date(s.startsAt);
    const key = `${s.employeeId}|2026-11-${String(d.getDate()).padStart(2, '0')}`;
    map.set(key, [...(map.get(key) ?? []), s]);
  }
  return map;
}

function wrap(node: ReactNode) {
  return render(<I18nProvider initialLanguage="en">{node}</I18nProvider>);
}

const EMMA = person('e1', 'Emma Bakker');
const JULIA = person('e2', 'Julia Smit');
const NOAH = person('e3', 'Noah Visser', 'Warehouse');
const ROSTER = [EMMA, JULIA, NOAH];

const SHIFTS = [
  shift('s1', 'e1', at(18, 9), at(18, 17), { workType: 'Cashier', breakStartsAt: at(18, 12), breakEndsAt: at(18, 12, 30) }),
  shift('s2', 'e3', at(17, 22), at(18, 6)),
  shift('s3', 'e1', at(20, 10), at(20, 18)),
];
const TIME_OFF = new Map<string, TimeOff[]>([
  ['e2', [timeOff({ id: 'leave' }), timeOff({ id: 'ask', pending: true, startDate: '2026-11-21', endDate: '2026-11-21' })]],
  ['e3', [timeOff({ id: 'sick', employeeId: 'e3', kind: 'sick', typeName: null, color: null, startDate: '2026-11-12', endDate: null })]],
]);

describe('ScheduleWeekView', () => {
  function renderWeek() {
    const handlers = { onAddShift: vi.fn(), onOpenShift: vi.fn(), onOpenDay: vi.fn() };
    const shiftsByCell = byCell(SHIFTS);
    wrap(
      <ScheduleWeekView
        days={WEEK}
        groups={groupByDepartment(ROSTER)}
        showGroupHeaders
        employeeCount={3}
        totalHours={23.5}
        hoursByEmployee={new Map([['e1', 15.5], ['e3', 8]])}
        shiftsByCell={shiftsByCell}
        timeOffByEmployee={TIME_OFF}
        dayStats={buildDayStats(WEEK, ROSTER, shiftsByCell, TIME_OFF)}
        timeFormat="24h"
        canCreate
        {...handlers}
      />,
    );
    return handlers;
  }

  it('counts who works and who is away under each day, and opens a day from its header', () => {
    const handlers = renderWeek();
    const wednesday = screen.getByRole('button', { name: 'Show Wednesday 18 November' }).parentElement!;
    expect(within(wednesday).getByText('1 on')).toBeInTheDocument();
    expect(within(wednesday).getByText('· 2 away')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Show Wednesday 18 November' }));
    expect(handlers.onOpenDay).toHaveBeenCalledWith('2026-11-18');
  });

  it('draws leave, a pending request and an open sick report as bars', () => {
    renderWeek();
    expect(screen.getByTitle(/^Holiday: /)).toHaveTextContent('Holiday');
    expect(screen.getByText('Holiday · requested')).toBeInTheDocument();
    expect(screen.getByText('Sick since Thu 12 Nov')).toBeInTheDocument();
    expect(screen.getByTitle(/^Sick: .* – no end date yet$/)).toBeInTheDocument();
  });

  it('edits a shift and adds one to an empty day', () => {
    const handlers = renderWeek();
    fireEvent.click(screen.getByRole('button', { name: /09:00 – 17:00/ }));
    expect(handlers.onOpenShift).toHaveBeenCalledWith(SHIFTS[0]);

    fireEvent.click(screen.getByRole('button', { name: 'Add shift: Julia Smit, Mon 16 Nov' }));
    expect(handlers.onAddShift).toHaveBeenCalledWith(JULIA, '2026-11-16');
  });
});

describe('ScheduleDayView', () => {
  function renderDay(overnight = new Map<string, HrShift[]>()) {
    const handlers = { onAddShift: vi.fn(), onOpenShift: vi.fn() };
    wrap(
      <ScheduleDayView
        day="2026-11-18"
        groups={groupByDepartment(ROSTER)}
        showGroupHeaders
        shiftsByCell={byCell(SHIFTS.filter((s) => s.id !== 's2'))}
        overnightShifts={overnight}
        timeOffByEmployee={TIME_OFF}
        timeFormat="24h"
        canCreate
        {...handlers}
      />,
    );
    return handlers;
  }

  it('shows each employee with their hours, leave or sickness, grouped by department', () => {
    renderDay();
    expect(screen.getByRole('columnheader', { name: 'Shop' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Warehouse' })).toBeInTheDocument();
    const emma = screen.getByRole('columnheader', { name: /Emma Bakker/ });
    expect(within(emma).getByText('7.5 hours')).toBeInTheDocument();
    expect(within(screen.getByRole('columnheader', { name: /Julia Smit/ })).getByText('Holiday')).toBeInTheDocument();
    expect(within(screen.getByRole('columnheader', { name: /Noah Visser/ })).getByText('Sick')).toBeInTheDocument();
  });

  it('starts at midnight and counts a night shift that began the evening before', () => {
    renderDay(new Map([['e3', [SHIFTS[1]!]]]));
    expect(within(screen.getByRole('columnheader', { name: /Noah Visser/ })).getByText('6 hours')).toBeInTheDocument();
    expect(screen.getByText('00:00')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /22:00 – 06:00/ })).toBeInTheDocument();
    const coverage = screen.getAllByRole('cell')[0]!;
    expect(coverage.firstElementChild).toHaveTextContent('1');
  });

  it('adds a shift from an empty column and edits one from its block', () => {
    const handlers = renderDay();
    fireEvent.click(screen.getByRole('button', { name: 'Add shift: Julia Smit, Wed 18 Nov' }));
    expect(handlers.onAddShift).toHaveBeenCalledWith(JULIA, '2026-11-18');
    fireEvent.click(screen.getByRole('button', { name: /09:00 – 17:00/ }));
    expect(handlers.onOpenShift).toHaveBeenCalledWith(SHIFTS[0]);
  });
});

describe('ScheduleMonthView', () => {
  it('shows who works and who is away per day, and opens a day', () => {
    const days = viewDays('2026-11-18', 'month');
    const shiftsByCell = byCell(SHIFTS);
    const onOpenDay = vi.fn();
    wrap(<ScheduleMonthView anchor="2026-11-18" dayStats={buildDayStats(days, ROSTER, shiftsByCell, TIME_OFF)} onOpenDay={onOpenDay} />);

    const wednesday = screen.getByRole('button', { name: 'Show Wednesday 18 November' }).parentElement!;
    expect(within(wednesday).getByText('1 on')).toBeInTheDocument();
    expect(within(wednesday).getByText('Julia · Holiday')).toBeInTheDocument();
    expect(within(wednesday).getByText('Noah · Sick')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Show Friday 20 November' }));
    expect(onOpenDay).toHaveBeenCalledWith('2026-11-20');
    // Days of the months either side have no button.
    expect(screen.queryByRole('button', { name: /Show Monday 26 October/ })).toBeNull();
  });
});

describe('ScheduleTab', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 10, 18, 10, 0));
    mocks.employees = [
      { id: 'e1', displayName: 'Emma Bakker', avatarUrl: null, departmentName: 'Shop', jobTitle: 'Cashier', clients: [] },
      { id: 'e3', displayName: 'Noah Visser', avatarUrl: null, departmentName: 'Warehouse', jobTitle: null, clients: [] },
    ] as unknown as HrEmployee[];
    mocks.shifts = SHIFTS;
    mocks.leave = [];
    mocks.absences = [
      { id: 'a1', employeeId: 'e3', startDate: '2026-11-19', endDate: null } as HrAbsence,
    ];
  });
  afterEach(() => vi.useRealTimers());

  it('opens on this week and drills into a day, carrying last night’s shift over', () => {
    wrap(<ScheduleTab />);
    expect(screen.getByRole('heading', { name: 'November 2026' })).toBeInTheDocument();
    expect(screen.getByText('Sick')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Show Wednesday 18 November' }));
    expect(screen.getByRole('heading', { name: 'Wednesday 18 November 2026' })).toBeInTheDocument();
    expect(within(screen.getByRole('columnheader', { name: /Noah Visser/ })).getByText('6 hours')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByRole('heading', { name: 'Thursday 19 November 2026' })).toBeInTheDocument();
    expect(within(screen.getByRole('columnheader', { name: /Noah Visser/ })).getByText('Sick')).toBeInTheDocument();
  });
});
