import { useState, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nProvider } from '@weldsuite/i18n/provider';
import { en } from '@weldsuite/i18n/locales/en';
import type { HrSelfAttendance } from '@weldsuite/app-api-client/domains/weldhr';
import { MY_ATTENDANCE_PANEL_TYPE } from '@/components/objects/hr-my-hr/types';
import { formatWeekdayDate } from '../../components/shared';
import { MyHoursList, RecordStatus, type MyAttendanceRecord } from './schedule-hours-tab';

const t = en.weldhr.me.schedule;
const status = en.weldhr.status.attendance;

interface StubFilter {
  field: string;
  options?: { value: string; label: string }[];
}
interface StubProps {
  items: MyAttendanceRecord[];
  isLoading: boolean;
  error: Error | null;
  columns: { id: string; header: string; render: (row: MyAttendanceRecord) => ReactNode }[];
  groups: { id: string; label: string; filter: (row: MyAttendanceRecord) => boolean }[];
  filters: StubFilter[];
  applyFilters: (rows: MyAttendanceRecord[], active: { id: string; field: string; operator: string; value: string }[]) => MyAttendanceRecord[];
  searchFields: (keyof MyAttendanceRecord)[];
  searchPlaceholder: string;
  onRowClick: (row: MyAttendanceRecord) => void;
  leftActionButtons: ReactNode;
  emptyState: { title: string; description: string };
}

const mocks = vi.hoisted(() => ({
  attendance: vi.fn(),
  open: vi.fn(),
  data: undefined as unknown,
  isLoading: false,
  error: null as unknown,
}));

vi.mock('@/app/weldcalendar/lib/calendar-format', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/app/weldcalendar/lib/calendar-format')>()),
  useTimeFormat: () => '24h',
}));
vi.mock('@/components/object-panel', () => ({ useObjectPanel: () => ({ open: mocks.open }) }));
vi.mock('@/hooks/queries/use-weldhr-queries', () => ({
  useMyHrAttendance: (range: unknown) => {
    mocks.attendance(range);
    return { data: mocks.data, isLoading: mocks.isLoading, error: mocks.error };
  },
}));
// The list shell has its own tests: this stand-in renders every column of each row, applies the search and the
// filters the way the shell does, and shows the states.
vi.mock('@/components/panel-entity-list', () => ({
  PanelEntityList: (props: StubProps) => {
    const [search, setSearch] = useState('');
    const [active, setActive] = useState<{ id: string; field: string; operator: string; value: string }[]>([]);
    if (props.isLoading) return <p>loading</p>;
    if (props.error) return <p>{props.error.message}</p>;
    if (props.items.length === 0) return <p>{props.emptyState.title}</p>;
    const query = search.toLowerCase();
    const rows = props
      .applyFilters(props.items, active)
      .filter((row) => !query || props.searchFields.some((field) => String(row[field] ?? '').toLowerCase().includes(query)));
    return (
      <div>
        {props.leftActionButtons}
        <input placeholder={props.searchPlaceholder} value={search} onChange={(event) => setSearch(event.target.value)} />
        {props.filters.flatMap((filter) =>
          (filter.options ?? []).map((option) => (
            <button
              key={`${filter.field}=${option.value}`}
              type="button"
              onClick={() => setActive([{ id: filter.field, field: filter.field, operator: 'is', value: option.value }])}
            >
              {`filter ${filter.field}: ${option.label}`}
            </button>
          )),
        )}
        <button type="button" onClick={() => setActive([{ id: 'x', field: 'status', operator: 'is', value: '' }])}>
          filter without value
        </button>
        <button type="button" onClick={() => setActive([{ id: 'x', field: 'unknown', operator: 'is', value: 'a' }])}>
          filter unknown field
        </button>
        {props.groups.map((group) => (
          <section key={group.id} aria-label={group.label}>
            {rows
              .filter((row) => group.filter(row))
              .map((row) => (
                <div key={row.id} data-testid={`row-${row.id}`}>
                  <button type="button" onClick={() => props.onRowClick(row)}>{`open ${row.id}`}</button>
                  {props.columns.map((column) => (
                    <div key={column.id} data-testid={`${row.id}-${column.id}`}>
                      {column.render(row)}
                    </div>
                  ))}
                </div>
              ))}
          </section>
        ))}
      </div>
    );
  },
}));

function at(day: number, hour: number, minute = 0): string {
  return new Date(2026, 10, day, hour, minute).toISOString();
}

function record(id: string, date: string, extra: Partial<MyAttendanceRecord> = {}): MyAttendanceRecord {
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

const RECORDS: MyAttendanceRecord[] = [
  record('old', '2026-11-10', { clockIn: at(10, 9), clockOut: at(10, 17), breakMinutes: 30, workedMinutes: 450, companyName: 'Acme' }),
  record('new', '2026-11-17', {
    clockIn: at(17, 9, 15),
    clockOut: at(17, 17),
    breakMinutes: 30,
    workedMinutes: 435,
    lateMinutes: 15,
    status: 'late',
    approved: false,
    companyName: 'Beta',
    notes: 'Train delay',
  }),
  record('open', '2026-11-16', { clockIn: at(16, 9), approved: false }),
];

function renderList(onPeriodChange = vi.fn()) {
  render(
    <I18nProvider initialLanguage="en">
      <MyHoursList period="last3Months" onPeriodChange={onPeriodChange} />
    </I18nProvider>,
  );
}

function rowIds(group: string): string[] {
  return within(screen.getByRole('region', { name: group }))
    .queryAllByTestId(/^row-/)
    .map((row) => row.dataset.testid!.replace('row-', ''));
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 10, 18, 12, 0));
  mocks.attendance.mockClear();
  mocks.open.mockClear();
  mocks.data = { records: RECORDS, shifts: [] } satisfies HrSelfAttendance;
  mocks.isLoading = false;
  mocks.error = null;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('RecordStatus', () => {
  const renderStatus = (rec: MyAttendanceRecord) =>
    render(
      <I18nProvider initialLanguage="en">
        <RecordStatus record={rec} />
      </I18nProvider>,
    );

  it('shows how late a late record was', () => {
    renderStatus(RECORDS[1]!);
    expect(screen.getByText(status.late)).toBeInTheDocument();
    expect(screen.getByText('15 min late')).toBeInTheDocument();
  });

  it('shows only the status for an on-time record, or when lateness is unknown', () => {
    const { unmount } = renderStatus(record('a', '2026-11-10', { lateMinutes: 0 }));
    expect(screen.getByText(status.present)).toBeInTheDocument();
    expect(screen.queryByText(/min late/)).not.toBeInTheDocument();
    unmount();
    renderStatus(record('b', '2026-11-10', { lateMinutes: null }));
    expect(screen.queryByText(/min late/)).not.toBeInTheDocument();
  });
});

describe('MyHoursList', () => {
  it('asks for the picked period', () => {
    renderList();
    expect(mocks.attendance).toHaveBeenCalledWith({ from: '2026-08-19', to: '2026-11-18' });
  });

  it('groups the records awaiting approval before the approved ones, latest day first', () => {
    renderList();
    expect(rowIds(t.groups.awaitingApproval)).toEqual(['new', 'open']);
    expect(rowIds(t.groups.approved)).toEqual(['old']);
  });

  it('shows the clock times, break, hours, status and client of a record', () => {
    renderList();
    expect(screen.getByTestId('new-date')).toHaveTextContent(formatWeekdayDate('2026-11-17'));
    expect(screen.getByTestId('new-date')).toHaveTextContent('09:15 – 17:00 · 7h 15m');
    expect(screen.getByTestId('new-clockIn')).toHaveTextContent('09:15');
    expect(screen.getByTestId('new-clockOut')).toHaveTextContent('17:00');
    expect(screen.getByTestId('new-break')).toHaveTextContent('0h 30m');
    expect(screen.getByTestId('new-worked')).toHaveTextContent('7h 15m');
    expect(screen.getByTestId('new-status')).toHaveTextContent(`${status.late}15 min late`);
    expect(screen.getByTestId('new-client')).toHaveTextContent('Beta');
  });

  it('shows dashes, and mutes the times, for a record still clocked in', () => {
    renderList();
    expect(screen.getByTestId('open-clockOut')).toHaveTextContent('—');
    expect(screen.getByTestId('open-clockOut').firstElementChild).toHaveClass('text-muted-foreground');
    expect(screen.getByTestId('open-clockIn').firstElementChild).not.toHaveClass('text-muted-foreground');
    expect(screen.getByTestId('open-break')).toHaveTextContent('—');
    expect(screen.getByTestId('open-worked')).toHaveTextContent('—');
    expect(screen.getByTestId('open-client')).toHaveTextContent('—');
  });

  it('mutes a missing clock in', () => {
    mocks.data = { records: [record('none', '2026-11-12')], shifts: [] };
    renderList();
    expect(screen.getByTestId('none-clockIn').firstElementChild).toHaveClass('text-muted-foreground');
  });

  it('opens the record in its panel', async () => {
    renderList();
    await userEvent.setup({ advanceTimers: vi.advanceTimersByTime }).click(screen.getByRole('button', { name: 'open old' }));
    expect(mocks.open).toHaveBeenCalledWith({ type: MY_ATTENDANCE_PANEL_TYPE, id: 'old' });
  });

  it('narrows the rows by status, and by client', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderList();
    expect(screen.getAllByRole('button', { name: /^filter status:/ }).map((b) => b.textContent)).toEqual([
      `filter status: ${status.late}`,
      `filter status: ${status.present}`,
    ]);

    await user.click(screen.getByRole('button', { name: `filter status: ${status.late}` }));
    expect(rowIds(t.groups.awaitingApproval)).toEqual(['new']);
    expect(rowIds(t.groups.approved)).toEqual([]);

    await user.click(screen.getByRole('button', { name: 'filter client: Acme' }));
    expect(rowIds(t.groups.awaitingApproval)).toEqual([]);
    expect(rowIds(t.groups.approved)).toEqual(['old']);
  });

  it('leaves every record in when a filter has no value or an unknown field', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderList();
    await user.click(screen.getByRole('button', { name: 'filter without value' }));
    expect(rowIds(t.groups.awaitingApproval)).toHaveLength(2);
    await user.click(screen.getByRole('button', { name: 'filter unknown field' }));
    expect(rowIds(t.groups.approved)).toHaveLength(1);
  });

  it('searches the client and notes', async () => {
    renderList();
    await userEvent.setup({ advanceTimers: vi.advanceTimersByTime }).type(screen.getByPlaceholderText(t.search.hours), 'train');
    expect(rowIds(t.groups.awaitingApproval)).toEqual(['new']);
    expect(rowIds(t.groups.approved)).toEqual([]);
  });

  it('offers no client filter when no record has a client', () => {
    mocks.data = { records: [RECORDS[2]!], shifts: [] };
    renderList();
    expect(screen.queryByRole('button', { name: /^filter client:/ })).not.toBeInTheDocument();
  });

  it('puts the period picker next to the filter', () => {
    renderList();
    expect(screen.getByRole('combobox', { name: t.period.label })).toHaveTextContent(t.period.last3Months);
  });

  it('shows the loading state', () => {
    mocks.data = undefined;
    mocks.isLoading = true;
    renderList();
    expect(screen.getByText('loading')).toBeInTheDocument();
  });

  it('shows the error when the hours could not load', () => {
    mocks.data = undefined;
    mocks.error = new Error('Boom');
    renderList();
    expect(screen.getByText('Boom')).toBeInTheDocument();
  });

  it('shows the empty state when there are no records in the period', () => {
    mocks.data = undefined;
    renderList();
    expect(screen.getByText(t.empty.hours.title)).toBeInTheDocument();
  });
});
