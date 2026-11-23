import { useState, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nProvider } from '@weldsuite/i18n/provider';
import { en } from '@weldsuite/i18n/locales/en';
import type { HrSelfAttendance } from '@weldsuite/app-api-client/domains/weldhr';
import { MY_SHIFT_PANEL_TYPE } from '@/components/objects/hr-my-hr/types';
import { formatWeekdayDate } from '../../components/shared';
import { MyShiftsList, plannedHours, type MyShift } from './schedule-shifts-tab';

const t = en.weldhr.me.schedule;

interface StubFilter {
  field: string;
  options?: { value: string; label: string }[];
}
interface StubProps {
  items: MyShift[];
  isLoading: boolean;
  error: Error | null;
  columns: { id: string; header: string; render: (row: MyShift) => ReactNode }[];
  groups: { id: string; label: string; filter: (row: MyShift) => boolean }[];
  filters: StubFilter[];
  applyFilters: (rows: MyShift[], active: { id: string; field: string; operator: string; value: string }[]) => MyShift[];
  searchFields: (keyof MyShift)[];
  searchPlaceholder: string;
  onRowClick: (row: MyShift) => void;
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
        <button type="button" onClick={() => setActive([{ id: 'x', field: 'when', operator: 'is', value: '' }])}>
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

function shift(id: string, startsAt: string, endsAt: string, extra: Partial<MyShift> = {}): MyShift {
  return { id, startsAt, endsAt, companyName: null, notes: null, workType: null, breakStartsAt: null, breakEndsAt: null, ...extra };
}

const SHIFTS: MyShift[] = [
  shift('later', at(24, 9), at(24, 17), { workType: 'Cashier', companyName: 'Acme', breakStartsAt: at(24, 12), breakEndsAt: at(24, 12, 30) }),
  shift('soon', at(19, 8), at(19, 12)),
  shift('recent', at(16, 9), at(16, 13), { companyName: 'Beta', notes: 'Cover for Sam' }),
  shift('old', at(10, 9), at(10, 17), { workType: 'Stock', companyName: 'Acme' }),
];

function attendance(shifts: MyShift[]): HrSelfAttendance {
  return { records: [], shifts };
}

function renderList(onPeriodChange = vi.fn(), viewToggle?: ReactNode) {
  render(
    <I18nProvider initialLanguage="en">
      <MyShiftsList period="thisMonth" onPeriodChange={onPeriodChange} viewToggle={viewToggle} />
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
  mocks.data = attendance(SHIFTS);
  mocks.isLoading = false;
  mocks.error = null;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('plannedHours', () => {
  it('is the shift length minus its break', () => {
    expect(plannedHours(SHIFTS[0]!)).toBe('7.5');
  });

  it('is the whole length without a break, or with half of one', () => {
    expect(plannedHours(SHIFTS[1]!)).toBe('4');
    expect(plannedHours(shift('half', at(19, 8), at(19, 12), { breakStartsAt: at(19, 10), breakEndsAt: null }))).toBe('4');
  });

  it('never goes below zero', () => {
    expect(plannedHours(shift('odd', at(19, 8), at(19, 9), { breakStartsAt: at(19, 8), breakEndsAt: at(19, 11) }))).toBe('0');
    expect(plannedHours(shift('backwards', at(19, 9), at(19, 8), { breakStartsAt: at(19, 11), breakEndsAt: at(19, 10) }))).toBe('0');
  });
});

describe('MyShiftsList', () => {
  it('asks for the picked period', () => {
    renderList();
    expect(mocks.attendance).toHaveBeenCalledWith({ from: '2026-11-01', to: '2026-11-30' });
  });

  it('lists upcoming shifts soonest first, then past shifts latest first', () => {
    renderList();
    expect(rowIds(t.groups.upcoming)).toEqual(['soon', 'later']);
    expect(rowIds(t.groups.past)).toEqual(['recent', 'old']);
  });

  it('shows the date, time, hours, type of work and client of a shift', () => {
    renderList();
    expect(screen.getByTestId('later-date')).toHaveTextContent(formatWeekdayDate(at(24, 9)));
    expect(screen.getByTestId('later-date')).toHaveTextContent('09:00 – 17:00 · Cashier');
    expect(screen.getByTestId('later-time')).toHaveTextContent('09:00 – 17:00');
    expect(screen.getByTestId('later-hours')).toHaveTextContent('7.5');
    expect(screen.getByTestId('later-workType')).toHaveTextContent('Cashier');
    expect(screen.getByTestId('later-client')).toHaveTextContent('Acme');
  });

  it('shows a dash for a missing type of work and client', () => {
    renderList();
    expect(screen.getByTestId('soon-workType')).toHaveTextContent('—');
    expect(screen.getByTestId('soon-client')).toHaveTextContent('—');
    expect(screen.getByTestId('soon-date')).toHaveTextContent('08:00 – 12:00');
    expect(screen.getByTestId('soon-date')).not.toHaveTextContent('·');
  });

  it('opens the shift in its panel', async () => {
    renderList();
    await userEvent.setup({ advanceTimers: vi.advanceTimersByTime }).click(screen.getByRole('button', { name: 'open later' }));
    expect(mocks.open).toHaveBeenCalledWith({ type: MY_SHIFT_PANEL_TYPE, id: 'later' });
  });

  it('narrows the rows by when, and by client', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderList();
    await user.click(screen.getByRole('button', { name: `filter when: ${t.groups.past}` }));
    expect(rowIds(t.groups.upcoming)).toEqual([]);
    expect(rowIds(t.groups.past)).toEqual(['recent', 'old']);

    await user.click(screen.getByRole('button', { name: `filter when: ${t.groups.upcoming}` }));
    expect(rowIds(t.groups.upcoming)).toEqual(['soon', 'later']);
    expect(rowIds(t.groups.past)).toEqual([]);

    await user.click(screen.getByRole('button', { name: 'filter client: Acme' }));
    expect(rowIds(t.groups.upcoming)).toEqual(['later']);
    expect(rowIds(t.groups.past)).toEqual(['old']);
  });

  it('offers each client once, and only the clients that have shifts', () => {
    renderList();
    expect(screen.getAllByRole('button', { name: /^filter client:/ }).map((b) => b.textContent)).toEqual([
      'filter client: Acme',
      'filter client: Beta',
    ]);
  });

  it('leaves every shift in when a filter has no value or an unknown field', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderList();
    await user.click(screen.getByRole('button', { name: 'filter without value' }));
    expect(rowIds(t.groups.upcoming)).toHaveLength(2);
    await user.click(screen.getByRole('button', { name: 'filter unknown field' }));
    expect(rowIds(t.groups.past)).toHaveLength(2);
  });

  it('searches the type of work, client and notes', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderList();
    const search = screen.getByPlaceholderText(t.search.shifts);
    await user.type(search, 'cover');
    expect(rowIds(t.groups.past)).toEqual(['recent']);
    expect(rowIds(t.groups.upcoming)).toEqual([]);
  });

  it('offers no client filter when no shift has a client', () => {
    mocks.data = attendance([SHIFTS[1]!]);
    renderList();
    expect(screen.queryByRole('button', { name: /^filter client:/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: `filter when: ${t.groups.past}` })).toBeInTheDocument();
  });

  it('puts the view toggle and the period picker next to the filter', () => {
    renderList(vi.fn(), <span>view toggle</span>);
    expect(screen.getByText('view toggle')).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: t.period.label })).toHaveTextContent(t.period.thisMonth);
  });

  it('shows the loading state', () => {
    mocks.data = undefined;
    mocks.isLoading = true;
    renderList();
    expect(screen.getByText('loading')).toBeInTheDocument();
  });

  it('shows a readable error when the shifts could not load', () => {
    mocks.data = undefined;
    mocks.error = new Error('Boom');
    renderList();
    expect(screen.getByText('Boom')).toBeInTheDocument();
  });

  it('falls back to the standard message for an error without one', () => {
    mocks.data = undefined;
    mocks.error = new Error('');
    renderList();
    expect(screen.getByText(en.weldhr.me.attendance.loadFailed)).toBeInTheDocument();
  });

  it('shows the empty state when there are no shifts in the period', () => {
    mocks.data = undefined;
    renderList();
    expect(screen.getByText(t.empty.shifts.title)).toBeInTheDocument();
  });
});
