import type { ReactNode } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nProvider } from '@weldsuite/i18n/provider';
import { en } from '@weldsuite/i18n/locales/en';
import type {
  HrSelfAbsence,
  HrSelfAbsences,
  HrSelfAttendance,
  HrSelfLeave,
  HrSelfLeaveRequest,
} from '@weldsuite/app-api-client/domains/weldhr';
import {
  MY_ATTENDANCE_PANEL_TYPE,
  MY_LEAVE_REQUEST_PANEL_TYPE,
  MY_SHIFT_PANEL_TYPE,
  MY_SICK_REPORT_PANEL_TYPE,
} from '@/components/objects/hr-my-hr/types';
import { formatWeekdayDate } from '../../components/shared';
import { MyScheduleCalendar } from './schedule-calendar-tab';

const t = en.weldhr.me.schedule;
const sched = en.weldhr.attendance.schedule;
const status = en.weldhr.status.attendance;

interface StubFilter {
  id: string;
  field: string;
  operator: string;
  value: string;
}

const mocks = vi.hoisted(() => ({
  open: vi.fn(),
  attendance: vi.fn(),
  data: undefined as unknown,
  leave: undefined as unknown,
  absences: undefined as unknown,
}));

vi.mock('@/app/weldcalendar/lib/calendar-format', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/app/weldcalendar/lib/calendar-format')>()),
  useTimeFormat: () => '24h',
}));
vi.mock('@/components/object-panel', () => ({ useObjectPanel: () => ({ open: mocks.open }) }));
vi.mock('@/hooks/queries/use-weldhr-queries', () => ({
  useMyHrAttendance: (range: unknown) => {
    mocks.attendance(range);
    return { data: mocks.data };
  },
  useMyHrLeave: () => ({ data: mocks.leave }),
  useMyHrAbsences: () => ({ data: mocks.absences }),
}));
// The filter control has its own tests: these buttons set the filters it would.
vi.mock('@/components/entity-list', () => ({
  FilterPills: ({
    filterConfigs,
    onFiltersChange,
  }: {
    filterConfigs: { field: string; options: { value: string; label: string }[] }[];
    onFiltersChange: (filters: StubFilter[]) => void;
  }) => (
    <div>
      {filterConfigs.flatMap((config) =>
        config.options.flatMap((option) =>
          ['is', 'is not'].map((operator) => (
            <button
              key={`${config.field}-${option.value}-${operator}`}
              type="button"
              onClick={() => onFiltersChange([{ id: 'f', field: config.field, operator, value: option.value }])}
            >
              {`${config.field} ${operator} ${option.value}`}
            </button>
          )),
        ),
      )}
      <button type="button" onClick={() => onFiltersChange([])}>
        clear filters
      </button>
    </div>
  ),
}));

function at(day: number, hour: number, minute = 0, month = 10): string {
  return new Date(2026, month, day, hour, minute).toISOString();
}

type Shift = HrSelfAttendance['shifts'][number];
type Rec = HrSelfAttendance['records'][number];

function shift(id: string, startsAt: string, endsAt: string, extra: Partial<Shift> = {}): Shift {
  return { id, startsAt, endsAt, companyName: null, notes: null, workType: null, breakStartsAt: null, breakEndsAt: null, ...extra };
}

function record(id: string, date: string, extra: Partial<Rec> = {}): Rec {
  return {
    id,
    date,
    clockIn: null,
    clockOut: null,
    breakMinutes: null,
    workedMinutes: null,
    lateMinutes: null,
    status: 'present',
    source: 'web',
    approved: true,
    companyName: null,
    ...extra,
  };
}

function leaveRequest(id: string, status: HrSelfLeaveRequest['status'], startDate: string, endDate: string): HrSelfLeaveRequest {
  return {
    id,
    leaveTypeId: 'lt',
    leaveTypeName: 'Holiday',
    leaveTypeColor: '#14b8a6',
    startDate,
    endDate,
    days: 1,
    reason: null,
    status,
    reviewNote: null,
    reviewedAt: null,
  };
}

function sick(id: string, startDate: string, endDate: string | null): HrSelfAbsence {
  return { id, startDate, endDate, firstDay: 'full', note: null, status: endDate ? 'completed' : 'ongoing', days: 1, createdAt: at(1, 9) };
}

/** Wednesday 18 November 2026, 12:00; the week runs Monday 16 to Sunday 22. */
const TODAY = '2026-11-18';

const SHIFTS: Shift[] = [
  // Today: a long shift with a break, and an early one that widens the day to 06:00.
  shift('s1', at(18, 9), at(18, 17), {
    workType: 'Cashier',
    companyName: 'Acme',
    notes: 'Bring the keys',
    breakStartsAt: at(18, 12),
    breakEndsAt: at(18, 12, 30),
  }),
  shift('s2', at(18, 6), at(18, 8)),
  // Thursday evening: widens the day to 23:00, and a shift without a client.
  shift('s3', at(19, 20), at(19, 23), { workType: 'Night' }),
  // A break with no length draws no break band.
  shift('s4', at(20, 9), at(20, 10), { breakStartsAt: at(20, 9, 30), breakEndsAt: at(20, 9, 30) }),
  // Runs past midnight: the day ends at 24.
  shift('s5', at(21, 22), at(22, 2)),
];

const RECORDS: Rec[] = [
  // Today, still clocked in.
  record('r1', TODAY, { clockIn: at(18, 9, 5), status: 'late', lateMinutes: 5 }),
  // Thursday, finished but with no minutes counted: shows the status.
  record('r2', '2026-11-19', { clockIn: at(19, 20, 10), clockOut: at(19, 23), status: 'remote' }),
  // Friday, never clocked in.
  record('r3', '2026-11-20', { status: 'absent' }),
  // Tuesday: no shift that day, so the bar takes the whole column; a status without a colour of its own.
  record('r4', '2026-11-17', { clockIn: at(17, 10), clockOut: at(17, 12), workedMinutes: 120, status: 'excused', companyName: 'Beta', notes: 'Training' }),
  // Sunday: a night shift clocked in the evening before; and a clock-out only the next day.
  record('r5', '2026-11-22', { clockIn: at(21, 23), clockOut: at(22, 1), workedMinutes: 120, status: 'half_day' }),
  // Monday: an open record that is not today.
  record('r6', '2026-11-16', { clockIn: at(16, 9), status: 'present', workedMinutes: 480 }),
];

const LEAVE: HrSelfLeave = {
  types: [],
  balances: [],
  requests: [
    leaveRequest('l1', 'approved', '2026-11-17', '2026-11-18'),
    leaveRequest('l2', 'pending', '2026-11-20', '2026-11-20'),
    leaveRequest('l3', 'rejected', '2026-11-19', '2026-11-19'),
    leaveRequest('l4', 'cancelled', '2026-11-19', '2026-11-19'),
  ],
};

// The open report is also in the history, as the API sends it.
const ABSENCES: HrSelfAbsences = {
  current: sick('a1', TODAY, null),
  history: [sick('a1', TODAY, null), sick('a2', '2026-11-21', '2026-11-21')],
};

function renderCalendar(viewToggle?: ReactNode) {
  return render(
    <I18nProvider initialLanguage="en">
      <MyScheduleCalendar viewToggle={viewToggle} />
    </I18nProvider>,
  );
}

const user = () => userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
const heading = () => screen.getByRole('heading', { level: 2 }).textContent;
const press = (name: string | RegExp) => user().click(screen.getByRole('button', { name }));

async function chooseView(label: string) {
  const u = user();
  await u.click(screen.getByRole('combobox', { name: sched.viewLabel }));
  await u.click(screen.getByRole('option', { name: label }));
}

beforeAll(() => {
  const proto = window.HTMLElement.prototype as unknown as Record<string, unknown>;
  proto.hasPointerCapture ??= () => false;
  proto.setPointerCapture ??= () => undefined;
  proto.releasePointerCapture ??= () => undefined;
  proto.scrollIntoView ??= () => undefined;
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
  vi.setSystemTime(new Date(2026, 10, 18, 12, 0));
  mocks.open.mockClear();
  mocks.attendance.mockClear();
  mocks.data = { records: RECORDS, shifts: SHIFTS } satisfies HrSelfAttendance;
  mocks.leave = LEAVE;
  mocks.absences = ABSENCES;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('MyScheduleCalendar toolbar', () => {
  it('opens on the week of today, asking for exactly its days', () => {
    renderCalendar();
    expect(heading()).toBe('November 2026');
    expect(mocks.attendance).toHaveBeenLastCalledWith({ from: '2026-11-16', to: '2026-11-22' });
    expect(screen.getByRole('combobox', { name: sched.viewLabel })).toHaveTextContent(sched.viewWeek);
  });

  it('shows the view toggle it is given', () => {
    renderCalendar(<span>view toggle</span>);
    expect(screen.getByText('view toggle')).toBeInTheDocument();
  });

  it('steps a week back and forward, and offers Today only away from this week', async () => {
    renderCalendar();
    expect(screen.queryByRole('button', { name: sched.today })).not.toBeInTheDocument();

    await press(sched.next);
    expect(mocks.attendance).toHaveBeenLastCalledWith({ from: '2026-11-23', to: '2026-11-29' });
    await press(sched.next);
    // 30 November to 6 December straddles two months.
    expect(heading()).toBe('Nov – Dec 2026');
    expect(mocks.attendance).toHaveBeenLastCalledWith({ from: '2026-11-30', to: '2026-12-06' });

    await press(sched.today);
    expect(mocks.attendance).toHaveBeenLastCalledWith({ from: '2026-11-16', to: '2026-11-22' });
    expect(screen.queryByRole('button', { name: sched.today })).not.toBeInTheDocument();

    await press(sched.previous);
    expect(mocks.attendance).toHaveBeenLastCalledWith({ from: '2026-11-09', to: '2026-11-15' });
  });

  it('switches to the day view, titled with the day', async () => {
    renderCalendar();
    await chooseView(sched.viewDay);
    expect(heading()).toBe(formatWeekdayDate(TODAY));
    expect(mocks.attendance).toHaveBeenLastCalledWith({ from: TODAY, to: TODAY });

    await press(sched.next);
    expect(heading()).toBe(formatWeekdayDate('2026-11-19'));
    await press(sched.today);
    expect(heading()).toBe(formatWeekdayDate(TODAY));
  });

  it('switches to the month view, which spans whole weeks and steps by month', async () => {
    renderCalendar();
    await chooseView(sched.viewMonth);
    expect(heading()).toBe('November 2026');
    expect(mocks.attendance).toHaveBeenLastCalledWith({ from: '2026-10-26', to: '2026-12-06' });

    await press(sched.next);
    expect(heading()).toBe('December 2026');
    expect(screen.getByRole('button', { name: sched.today })).toBeInTheDocument();
    await press(sched.today);
    expect(heading()).toBe('November 2026');
  });
});

describe('MyScheduleCalendar week view', () => {
  it('shows the weekdays with their dates, and only today in blue', () => {
    renderCalendar();
    const dayButtons = screen.getAllByRole('button', { name: /^\w+, \d+ \w+/ });
    expect(dayButtons.map((b) => b.textContent)).toEqual(['16', '17', '18', '19', '20', '21', '22']);
    expect(screen.getByRole('button', { name: formatWeekdayDate(TODAY) }).style.color).not.toBe('');
    expect(screen.getByRole('button', { name: formatWeekdayDate('2026-11-19') }).style.color).toBe('');
  });

  it('opens a day from its date', async () => {
    renderCalendar();
    await press(formatWeekdayDate('2026-11-19'));
    expect(heading()).toBe(formatWeekdayDate('2026-11-19'));
    // In the day view the date is no longer a button.
    expect(screen.queryByRole('button', { name: formatWeekdayDate('2026-11-19') })).not.toBeInTheDocument();
  });

  it('draws the whole day when a record starts before midnight and a shift ends after it', () => {
    renderCalendar();
    expect(screen.getByText('00:00')).toBeInTheDocument();
    expect(screen.getByText('23:00')).toBeInTheDocument();
  });

  it('widens the hours to the earliest and latest item, to whole hours', () => {
    mocks.data = { records: [], shifts: [SHIFTS[1]!, SHIFTS[2]!] } satisfies HrSelfAttendance;
    renderCalendar();
    expect(screen.getByText('06:00')).toBeInTheDocument();
    expect(screen.getByText('22:00')).toBeInTheDocument();
    expect(screen.queryByText('05:00')).not.toBeInTheDocument();
    expect(screen.queryByText('23:00')).not.toBeInTheDocument();
  });

  it('draws only 08:00 to 18:00 when nothing falls outside it', () => {
    mocks.data = { records: [], shifts: [SHIFTS[0]!] } satisfies HrSelfAttendance;
    renderCalendar();
    expect(screen.getByText('08:00')).toBeInTheDocument();
    expect(screen.getByText('17:00')).toBeInTheDocument();
    expect(screen.queryByText('07:00')).not.toBeInTheDocument();
    expect(screen.queryByText('18:00')).not.toBeInTheDocument();
  });

  it('draws a shift as planned, with its type of work, and opens its panel', async () => {
    renderCalendar();
    const button = screen.getByTitle('09:00 – 17:00 · Cashier · Acme');
    expect(button).toHaveTextContent('09:00 – 17:00');
    expect(button).toHaveTextContent('Cashier');
    await user().click(button);
    expect(mocks.open).toHaveBeenCalledWith({ type: MY_SHIFT_PANEL_TYPE, id: 's1' });
  });

  it('leaves room for the clocked time only on days that have one', () => {
    renderCalendar();
    // Today has a clock record: the shift stops short of it.
    expect(screen.getByTitle('09:00 – 17:00 · Cashier · Acme').style.right).toContain('32%');
    // Saturday has a shift and no record.
    expect(screen.getByTitle('22:00 – 02:00').style.right).toBe('4px');
  });

  it('shades a shift break, but not one without length', () => {
    renderCalendar();
    const withBreak = screen.getByTitle('09:00 – 17:00 · Cashier · Acme');
    expect(withBreak.querySelector('.bg-black\\/20')).not.toBeNull();
    expect(screen.getByTitle('09:00 – 10:00').querySelector('.bg-black\\/20')).toBeNull();
  });

  it('shows a shift that runs past midnight on the day it starts, up to the end of the day', () => {
    renderCalendar();
    expect(screen.getByTitle('22:00 – 02:00')).toBeInTheDocument();
  });

  it('draws the clocked time beside the shift, with its worked time or status, and opens its panel', async () => {
    renderCalendar();
    const open = screen.getByTitle(`${en.weldhr.me.attendance.table.clockIn} 09:05 · ${en.weldhr.me.attendance.table.clockOut} —`);
    expect(open).toHaveTextContent(status.late);
    expect(open.style.width).toBe('32%');
    await user().click(open);
    expect(mocks.open).toHaveBeenCalledWith({ type: MY_ATTENDANCE_PANEL_TYPE, id: 'r1' });

  });

  it('shows the worked time of a finished record, across the whole column when there is no shift', () => {
    renderCalendar();
    const tuesday = screen.getByTitle(/10:00 · .* 12:00$/);
    expect(tuesday).toHaveTextContent('2h 00m');
    expect(tuesday.style.width).toBe('calc(100% - 8px)');
  });

  it('draws nothing for a record that was never clocked in', () => {
    renderCalendar();
    expect(screen.queryByText(status.absent)).not.toBeInTheDocument();
  });

  it('draws a record clocked in the evening before from midnight, and one clocked out later up to the end of the day', () => {
    renderCalendar();
    expect(screen.getByTitle(/23:00 · .* 01:00$/)).toHaveTextContent('2h 00m');
  });

  it('draws time off in an all-day row, and opens the leave request or sick report', async () => {
    renderCalendar();
    // Approved leave covers Tuesday and Wednesday; the pending request is dashed and marked as requested.
    expect(screen.getAllByTitle(/^Holiday: /)).toHaveLength(2);
    expect(screen.getByText('Holiday · requested')).toBeInTheDocument();
    // The sick report (open, and also in the history) shows once a day from Wednesday on, and a2 on Saturday.
    expect(screen.getAllByTitle(/^Sick: .*no end date yet$/).length).toBeGreaterThan(0);

    await user().click(screen.getAllByTitle(/^Holiday: /)[0]!);
    expect(mocks.open).toHaveBeenLastCalledWith({ type: MY_LEAVE_REQUEST_PANEL_TYPE, id: 'l1' });
    await user().click(screen.getAllByTitle(/^Sick: /)[0]!);
    expect(mocks.open).toHaveBeenLastCalledWith({ type: MY_SICK_REPORT_PANEL_TYPE, id: 'a1' });
  });

  it('leaves out rejected and cancelled leave', () => {
    renderCalendar();
    expect(screen.queryByTitle(/^Holiday: .*19 Nov/)).not.toBeInTheDocument();
  });

  it('has no all-day row without time off', () => {
    mocks.leave = undefined;
    mocks.absences = undefined;
    renderCalendar();
    expect(screen.queryByTitle(/^Holiday: /)).not.toBeInTheDocument();
    expect(screen.queryByTitle(/^Sick/)).not.toBeInTheDocument();
  });

  it('works while nothing has loaded', () => {
    mocks.data = undefined;
    mocks.leave = undefined;
    mocks.absences = undefined;
    renderCalendar();
    expect(heading()).toBe('November 2026');
    expect(screen.getByText('08:00')).toBeInTheDocument();
  });

  it('shows the sick report without an open one', () => {
    mocks.absences = { current: null, history: [sick('a2', TODAY, TODAY)] } satisfies HrSelfAbsences;
    renderCalendar();
    expect(screen.getByTitle(/^Sick: .*18 Nov.* – .*18 Nov/)).toBeInTheDocument();
  });

  it('marks the current time, and moves it every minute', () => {
    mocks.data = { records: [RECORDS[0]!], shifts: [SHIFTS[0]!, SHIFTS[1]!] } satisfies HrSelfAttendance;
    const { container } = renderCalendar();
    const line = () => container.querySelector('.bg-red-500.h-2\\.5');
    expect(line()).not.toBeNull();

    // At 03:00 the day starts at 06:00, so the line has nowhere to be.
    act(() => {
      vi.setSystemTime(new Date(2026, 10, 18, 3, 0));
      vi.advanceTimersByTime(60_000);
    });
    expect(line()).toBeNull();
  });

  it('only marks the time on today', async () => {
    const { container } = renderCalendar();
    await press(sched.next);
    expect(container.querySelector('.bg-red-500.h-2\\.5')).toBeNull();
  });

  it('stops the clock when it goes away', () => {
    const { unmount } = renderCalendar();
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('MyScheduleCalendar month view', () => {
  async function renderMonth() {
    const view = renderCalendar();
    await chooseView(sched.viewMonth);
    return view;
  }

  it('shows the weekday header and every day of the weeks around the month', async () => {
    await renderMonth();
    for (const day of ['26', '30', '31']) expect(screen.getAllByRole('button', { name: new RegExp(`^\\w+, ${day} `) }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole('button', { name: /^\w+, \d+ \w+/ })).toHaveLength(42);
  });

  it('shows shifts as chips with their time, and opens their panel', async () => {
    await renderMonth();
    const chip = screen.getByTitle('20:00 – 23:00 · Night');
    expect(chip).toHaveTextContent('20:00 – 23:00');
    await user().click(chip);
    expect(mocks.open).toHaveBeenCalledWith({ type: MY_SHIFT_PANEL_TYPE, id: 's3' });
  });

  it('shows records as chips with worked time or status, and opens their panel', async () => {
    await renderMonth();
    const chip = screen.getByTitle(/10:00 · .* 12:00$/);
    expect(chip).toHaveTextContent('2h 00m');
    await user().click(chip);
    expect(mocks.open).toHaveBeenCalledWith({ type: MY_ATTENDANCE_PANEL_TYPE, id: 'r4' });
    expect(screen.getByTitle(/20:10 · .* 23:00$/)).toHaveTextContent(status.remote);
  });

  it('sums up what does not fit on a day, and opens the day from it', async () => {
    await renderMonth();
    // Wednesday: leave, sick, two shifts and a record; two are shown and three are summed up.
    const more = screen.getByRole('button', { name: sched.more.replace('{count}', '3') });
    await user().click(more);
    expect(heading()).toBe(formatWeekdayDate(TODAY));
    expect(mocks.attendance).toHaveBeenLastCalledWith({ from: TODAY, to: TODAY });
  });

  it('opens a day from its number', async () => {
    await renderMonth();
    await user().click(screen.getAllByRole('button', { name: formatWeekdayDate('2026-11-19') })[0]!);
    expect(heading()).toBe(formatWeekdayDate('2026-11-19'));
  });

  it('opens time off from its chip', async () => {
    await renderMonth();
    await user().click(screen.getByText('Holiday · requested'));
    expect(mocks.open).toHaveBeenCalledWith({ type: MY_LEAVE_REQUEST_PANEL_TYPE, id: 'l2' });
  });

  it('greys the days of the neighbouring months', async () => {
    const { container } = await renderMonth();
    expect(container.querySelectorAll('.bg-muted\\/50').length).toBe(42 - 30);
  });
});

describe('MyScheduleCalendar filters and search', () => {
  it('shows only the picked kind of item', async () => {
    renderCalendar();
    await press('show is shifts');
    expect(screen.getByTitle('09:00 – 17:00 · Cashier · Acme')).toBeInTheDocument();
    expect(screen.queryByText(status.late)).not.toBeInTheDocument();
    expect(screen.queryByTitle(/^Holiday: /)).not.toBeInTheDocument();

    await press('show is hours');
    expect(screen.queryByTitle('09:00 – 17:00 · Cashier · Acme')).not.toBeInTheDocument();
    expect(screen.getByText(status.late)).toBeInTheDocument();

    await press('show is timeOff');
    expect(screen.getAllByTitle(/^Holiday: /)).toHaveLength(2);
    expect(screen.queryByText(status.late)).not.toBeInTheDocument();
  });

  it('hides the picked kind with "is not"', async () => {
    renderCalendar();
    await press('show is not shifts');
    expect(screen.queryByTitle('09:00 – 17:00 · Cashier · Acme')).not.toBeInTheDocument();
    expect(screen.getByText(status.late)).toBeInTheDocument();
  });

  it('shows only the shifts and records of a client, and no time off', async () => {
    renderCalendar();
    expect(screen.getAllByRole('button', { name: /^client / }).map((b) => b.textContent)).toEqual([
      'client is Acme',
      'client is not Acme',
      'client is Beta',
      'client is not Beta',
    ]);
    await press('client is Acme');
    expect(screen.getByTitle('09:00 – 17:00 · Cashier · Acme')).toBeInTheDocument();
    expect(screen.queryByTitle('22:00 – 02:00')).not.toBeInTheDocument();
    expect(screen.queryByTitle(/^Holiday: /)).not.toBeInTheDocument();

    await press('client is not Acme');
    expect(screen.queryByTitle('09:00 – 17:00 · Cashier · Acme')).not.toBeInTheDocument();
    expect(screen.getByTitle('22:00 – 02:00')).toBeInTheDocument();
  });

  it('offers no client filter when nothing has a client', () => {
    mocks.data = { records: [record('r', TODAY, { clockIn: at(18, 9) })], shifts: [shift('s', at(18, 9), at(18, 17))] } satisfies HrSelfAttendance;
    renderCalendar();
    expect(screen.queryByRole('button', { name: /^client / })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'show is shifts' })).toBeInTheDocument();
  });

  it('clears the filters', async () => {
    renderCalendar();
    await press('show is hours');
    await press('clear filters');
    expect(screen.getByTitle('09:00 – 17:00 · Cashier · Acme')).toBeInTheDocument();
  });

  it('searches shifts by type of work, client and notes', async () => {
    renderCalendar();
    await press(t.search.shifts);
    const search = screen.getByRole('textbox', { name: t.search.shifts });
    await user().type(search, 'keys');
    expect(screen.getByTitle('09:00 – 17:00 · Cashier · Acme')).toBeInTheDocument();
    expect(screen.queryByTitle('22:00 – 02:00')).not.toBeInTheDocument();
    expect(screen.queryByTitle(/^Holiday: /)).not.toBeInTheDocument();
  });

  it('searches records by client, notes and status', async () => {
    renderCalendar();
    await press(t.search.shifts);
    const search = screen.getByRole('textbox', { name: t.search.shifts });
    await user().type(search, 'training');
    expect(screen.getByTitle(/10:00 · .* 12:00$/)).toBeInTheDocument();
    expect(screen.queryByTitle('09:00 – 17:00 · Cashier · Acme')).not.toBeInTheDocument();

    await user().clear(search);
    await user().type(search, status.remote);
    expect(screen.getByTitle(/20:10 · .* 23:00$/)).toBeInTheDocument();
    expect(screen.queryByTitle(/10:00 · .* 12:00$/)).not.toBeInTheDocument();
  });

  it('searches time off by its label', async () => {
    renderCalendar();
    await press(t.search.shifts);
    await user().type(screen.getByRole('textbox', { name: t.search.shifts }), 'requested');
    expect(screen.getByText('Holiday · requested')).toBeInTheDocument();
    expect(screen.queryAllByTitle(/^Holiday: .*17 Nov/)).toHaveLength(0);
    expect(screen.queryByTitle('09:00 – 17:00 · Cashier · Acme')).not.toBeInTheDocument();
  });

  it('closes the search with Escape and shows everything again', async () => {
    renderCalendar();
    await press(t.search.shifts);
    const search = screen.getByRole('textbox', { name: t.search.shifts });
    await user().type(search, 'keys');
    fireEvent.keyDown(search, { key: 'Escape' });
    expect(screen.getByTitle('22:00 – 02:00')).toBeInTheDocument();
    expect(within(document.body).getByRole('button', { name: t.search.shifts })).toBeInTheDocument();
  });
});
