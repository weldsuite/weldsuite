import { useState, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nProvider } from '@weldsuite/i18n/provider';
import { en } from '@weldsuite/i18n/locales/en';
import type { HrSelfOpenShift } from '@weldsuite/app-api-client/domains/weldhr';
import { MY_OPEN_SHIFT_PANEL_TYPE } from '@/components/objects/hr-my-hr/types';
import { formatWeekdayDate } from '../../components/shared';
import {
  MyOpenShiftsList,
  OpenShiftMenuItems,
  SignUpBadge,
  SignUpDialog,
  activeRequest,
  useSpotsLabel,
  useWithdrawSignUp,
} from './open-shifts-card';

const t = en.weldhr.me;
const labels = t.openShifts;
const groups = t.schedule.groups;

interface StubFilter {
  field: string;
  options?: { value: string; label: string }[];
}
interface StubProps {
  items: HrSelfOpenShift[];
  isLoading: boolean;
  error: Error | null;
  columns: { id: string; header: string; render: (row: HrSelfOpenShift) => ReactNode }[];
  groups: { id: string; label: string; filter: (row: HrSelfOpenShift) => boolean }[];
  filters: StubFilter[];
  applyFilters: (rows: HrSelfOpenShift[], active: { id: string; field: string; operator: string; value: string }[]) => HrSelfOpenShift[];
  searchFields: (keyof HrSelfOpenShift)[];
  searchPlaceholder: string;
  onRowClick: (row: HrSelfOpenShift) => void;
  rowMenu: (row: HrSelfOpenShift) => ReactNode;
  emptyState: { title: string; description: string };
}

const mocks = vi.hoisted(() => ({
  open: vi.fn(),
  signUp: vi.fn(),
  cancel: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  data: undefined as unknown,
  isLoading: false,
  error: null as unknown,
  signUpPending: false,
  cancelPending: false,
}));

vi.mock('sonner', () => ({ toast: { success: mocks.toastSuccess, error: mocks.toastError } }));
vi.mock('@/app/weldcalendar/lib/calendar-format', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/app/weldcalendar/lib/calendar-format')>()),
  useTimeFormat: () => '24h',
}));
vi.mock('@/components/object-panel', () => ({ useObjectPanel: () => ({ open: mocks.open }) }));
vi.mock('@/hooks/queries/use-weldhr-queries', () => ({
  useMyHrOpenShifts: () => ({ data: mocks.data, isLoading: mocks.isLoading, error: mocks.error }),
  useMyHrSignUpForOpenShift: () => ({ mutateAsync: mocks.signUp, isPending: mocks.signUpPending }),
  useMyHrCancelShiftRequest: () => ({ mutateAsync: mocks.cancel, isPending: mocks.cancelPending }),
}));
// The menu items are plain buttons here: the real menu needs its trigger and portal.
vi.mock('@weldsuite/ui/components/dropdown-menu', () => ({
  DropdownMenuItem: ({
    children,
    onClick,
    disabled,
    variant,
  }: {
    children: ReactNode;
    onClick?: () => void;
    disabled?: boolean;
    variant?: string;
  }) => (
    <button type="button" role="menuitem" disabled={disabled} data-variant={variant} onClick={onClick}>
      {children}
    </button>
  ),
}));
// The list shell has its own tests: this stand-in renders every column and the row menu of each row, applies the
// search and the filters the way the shell does, and shows the states.
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
        <button type="button" onClick={() => setActive([{ id: 'x', field: 'state', operator: 'is', value: '' }])}>
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
                  <div data-testid={`${row.id}-menu`}>{props.rowMenu(row)}</div>
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

function openShift(id: string, day: number, extra: Partial<HrSelfOpenShift> = {}): HrSelfOpenShift {
  return {
    id,
    startsAt: at(day, 9),
    endsAt: at(day, 17),
    workType: null,
    breakStartsAt: null,
    breakEndsAt: null,
    notes: null,
    companyName: null,
    departmentName: null,
    spots: 3,
    spotsLeft: 2,
    myRequest: null,
    ...extra,
  };
}

function request(status: 'pending' | 'approved' | 'rejected' | 'cancelled', id = 'req_1') {
  return { id, status, reviewNote: null };
}

const OPEN = openShift('open', 25, { workType: 'Cashier', companyName: 'Acme', spotsLeft: 2 });
const LAST_SPOT = openShift('last', 24, { spotsLeft: 1, companyName: 'Beta', departmentName: 'Warehouse' });
const FULL = openShift('full', 26, { spotsLeft: 0 });
const PENDING = openShift('pending', 27, { spotsLeft: 1, myRequest: request('pending', 'req_p') });
const APPROVED = openShift('approved', 28, { myRequest: request('approved') });
const REJECTED = openShift('rejected', 29, { myRequest: request('rejected') });
const WITHDRAWN = openShift('withdrawn', 30, { myRequest: request('cancelled') });
const ALL = [OPEN, LAST_SPOT, FULL, PENDING, APPROVED, REJECTED, WITHDRAWN];

function wrap(node: ReactNode) {
  return <I18nProvider initialLanguage="en">{node}</I18nProvider>;
}

function rowIds(group: string): string[] {
  return within(screen.getByRole('region', { name: group }))
    .queryAllByTestId(/^row-/)
    .map((row) => row.dataset.testid!.replace('row-', ''));
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 10, 18, 12, 0));
  for (const mock of [mocks.open, mocks.signUp, mocks.cancel, mocks.toastSuccess, mocks.toastError]) mock.mockReset();
  mocks.signUp.mockResolvedValue(undefined);
  mocks.cancel.mockResolvedValue(undefined);
  mocks.data = ALL;
  mocks.isLoading = false;
  mocks.error = null;
  mocks.signUpPending = false;
  mocks.cancelPending = false;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('activeRequest', () => {
  it('is the sign-up, unless there is none or it was withdrawn', () => {
    expect(activeRequest(PENDING)?.id).toBe('req_p');
    expect(activeRequest(APPROVED)?.status).toBe('approved');
    expect(activeRequest(WITHDRAWN)).toBeNull();
    expect(activeRequest(OPEN)).toBeNull();
  });
});

describe('useSpotsLabel', () => {
  function Label({ spots }: Readonly<{ spots: number }>) {
    return <span>{useSpotsLabel()(spots)}</span>;
  }

  it.each([
    [0, 'Full'],
    [1, '1 spot left'],
    [4, '4 spots left'],
  ])('says %i spots as "%s"', (spots, text) => {
    render(wrap(<Label spots={spots} />));
    expect(screen.getByText(text)).toBeInTheDocument();
  });
});

describe('useWithdrawSignUp', () => {
  function Withdraw() {
    const { withdraw, isPending } = useWithdrawSignUp();
    return (
      <button type="button" onClick={() => void withdraw('req_9')}>
        {isPending ? 'pending' : 'withdraw'}
      </button>
    );
  }

  it('withdraws the sign-up and confirms with a toast', async () => {
    render(wrap(<Withdraw />));
    await userEvent.setup({ advanceTimers: vi.advanceTimersByTime }).click(screen.getByRole('button', { name: 'withdraw' }));
    expect(mocks.cancel).toHaveBeenCalledWith('req_9');
    await waitFor(() => expect(mocks.toastSuccess).toHaveBeenCalledWith(labels.withdrawnToast));
  });

  it('toasts the error message when it fails', async () => {
    mocks.cancel.mockRejectedValue(new Error('Too late'));
    render(wrap(<Withdraw />));
    await userEvent.setup({ advanceTimers: vi.advanceTimersByTime }).click(screen.getByRole('button', { name: 'withdraw' }));
    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith('Too late'));
  });

  it('toasts the standard message for an error without one, and reports the pending state', async () => {
    mocks.cancel.mockRejectedValue('nope');
    mocks.cancelPending = true;
    render(wrap(<Withdraw />));
    await userEvent.setup({ advanceTimers: vi.advanceTimersByTime }).click(screen.getByRole('button', { name: 'pending' }));
    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith(labels.withdrawFailed));
  });
});

describe('SignUpBadge', () => {
  it.each([
    [PENDING, labels.status.pending],
    [APPROVED, labels.status.approved],
    [REJECTED, labels.status.rejected],
  ])('shows the state of the sign-up', (shift, text) => {
    render(wrap(<SignUpBadge shift={shift} />));
    expect(screen.getByText(text)).toBeInTheDocument();
  });

  it('shows nothing without a sign-up, or after a withdrawal', () => {
    const { container, rerender } = render(wrap(<SignUpBadge shift={OPEN} />));
    expect(container).toBeEmptyDOMElement();
    rerender(wrap(<SignUpBadge shift={WITHDRAWN} />));
    expect(container).toBeEmptyDOMElement();
  });
});

describe('OpenShiftMenuItems', () => {
  const renderItems = (shift: HrSelfOpenShift, withdrawing = false) => {
    const onSignUp = vi.fn();
    const onWithdraw = vi.fn();
    const view = render(wrap(<OpenShiftMenuItems shift={shift} onSignUp={onSignUp} onWithdraw={onWithdraw} withdrawing={withdrawing} />));
    return { onSignUp, onWithdraw, ...view };
  };

  it('offers signing up while there is room', async () => {
    const { onSignUp } = renderItems(OPEN);
    await userEvent.setup({ advanceTimers: vi.advanceTimersByTime }).click(screen.getByRole('menuitem', { name: labels.signUp }));
    expect(onSignUp).toHaveBeenCalled();
  });

  it('offers withdrawing a pending sign-up, with its id', async () => {
    const { onWithdraw } = renderItems(PENDING);
    const item = screen.getByRole('menuitem', { name: labels.withdraw });
    expect(item).toHaveAttribute('data-variant', 'destructive');
    await userEvent.setup({ advanceTimers: vi.advanceTimersByTime }).click(item);
    expect(onWithdraw).toHaveBeenCalledWith('req_p');
  });

  it('disables withdrawing while one is running', () => {
    renderItems(PENDING, true);
    expect(screen.getByRole('menuitem', { name: labels.withdraw })).toBeDisabled();
  });

  it.each([[FULL], [APPROVED], [REJECTED]])('offers nothing when the shift is full or the sign-up is decided', (shift) => {
    const { container } = renderItems(shift);
    expect(container).toBeEmptyDOMElement();
  });

  it('offers signing up again after a withdrawal', () => {
    renderItems(WITHDRAWN);
    expect(screen.getByRole('menuitem', { name: labels.signUp })).toBeInTheDocument();
  });
});

describe('SignUpDialog', () => {
  const renderDialog = (shift: HrSelfOpenShift = OPEN) => {
    const onClose = vi.fn();
    render(wrap(<SignUpDialog shift={shift} onClose={onClose} />));
    return onClose;
  };

  it('describes the shift', () => {
    renderDialog();
    expect(screen.getByRole('dialog')).toHaveTextContent(labels.signUpTitle);
    expect(screen.getByRole('dialog')).toHaveTextContent('17:00 · Cashier');
  });

  it('leaves the type of work out when the shift has none', () => {
    renderDialog(LAST_SPOT);
    expect(screen.getByRole('dialog')).not.toHaveTextContent('·');
  });

  it('signs up with the trimmed note, confirms and closes', async () => {
    const onClose = renderDialog();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await user.type(screen.getByLabelText(labels.noteLabel), '  Happy to help  ');
    await user.click(screen.getByRole('button', { name: labels.submit }));
    expect(mocks.signUp).toHaveBeenCalledWith({ id: 'open', note: 'Happy to help' });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(mocks.toastSuccess).toHaveBeenCalledWith(labels.signedUpToast);
  });

  it('sends no note when it is left empty', async () => {
    renderDialog();
    await userEvent.setup({ advanceTimers: vi.advanceTimersByTime }).click(screen.getByRole('button', { name: labels.submit }));
    expect(mocks.signUp).toHaveBeenCalledWith({ id: 'open', note: null });
  });

  it('keeps the dialog open and shows the error when signing up fails', async () => {
    mocks.signUp.mockRejectedValue(new Error('Shift is full'));
    const onClose = renderDialog();
    await userEvent.setup({ advanceTimers: vi.advanceTimersByTime }).click(screen.getByRole('button', { name: labels.submit }));
    expect(await screen.findByText('Shift is full')).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('shows the standard message for an error without one', async () => {
    mocks.signUp.mockRejectedValue('nope');
    renderDialog();
    await userEvent.setup({ advanceTimers: vi.advanceTimersByTime }).click(screen.getByRole('button', { name: labels.submit }));
    expect(await screen.findByText(labels.signUpFailed)).toBeInTheDocument();
  });

  it('closes on Cancel and on Escape', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const onClose = renderDialog();
    await user.click(screen.getByRole('button', { name: en.weldhr.common.cancel }));
    expect(onClose).toHaveBeenCalledTimes(1);
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('cannot be dismissed while signing up', async () => {
    mocks.signUpPending = true;
    const onClose = renderDialog();
    expect(screen.getByRole('button', { name: en.weldhr.common.cancel })).toBeDisabled();
    expect(screen.getByRole('button', { name: labels.submit })).toBeDisabled();
    await userEvent.setup({ advanceTimers: vi.advanceTimersByTime }).keyboard('{Escape}');
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('MyOpenShiftsList', () => {
  const renderList = () => render(wrap(<MyOpenShiftsList />));
  const user = () => userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

  it('lists your sign-ups first, then the shifts still open, soonest first', () => {
    renderList();
    expect(rowIds(groups.mine)).toEqual(['pending', 'approved', 'rejected']);
    expect(rowIds(groups.open)).toEqual(['last', 'open', 'full', 'withdrawn']);
  });

  it('shows the date, time, type of work, client, spots and sign-up of a shift', () => {
    renderList();
    expect(screen.getByTestId('open-date')).toHaveTextContent(formatWeekdayDate(at(25, 9)));
    expect(screen.getByTestId('open-date')).toHaveTextContent('09:00 – 17:00 · Cashier · 2 spots left');
    expect(screen.getByTestId('open-time')).toHaveTextContent('09:00 – 17:00');
    expect(screen.getByTestId('open-workType')).toHaveTextContent('Cashier');
    expect(screen.getByTestId('open-client')).toHaveTextContent('Acme');
    expect(screen.getByTestId('open-spots')).toHaveTextContent('2 spots left');
    expect(screen.getByTestId('pending-signUp')).toHaveTextContent(labels.status.pending);
  });

  it('shows dashes for a missing type of work and client, and mutes a full shift', () => {
    renderList();
    expect(screen.getByTestId('full-workType')).toHaveTextContent('—');
    expect(screen.getByTestId('full-client')).toHaveTextContent('—');
    expect(screen.getByTestId('full-spots')).toHaveTextContent('Full');
    expect(screen.getByTestId('full-spots').firstElementChild).toHaveClass('text-muted-foreground');
    expect(screen.getByTestId('open-spots').firstElementChild).not.toHaveClass('text-muted-foreground');
  });

  it('opens a shift in its panel', async () => {
    renderList();
    await user().click(screen.getByRole('button', { name: 'open open' }));
    expect(mocks.open).toHaveBeenCalledWith({ type: MY_OPEN_SHIFT_PANEL_TYPE, id: 'open' });
  });

  it('has a row menu only where there is something to do', () => {
    renderList();
    expect(within(screen.getByTestId('open-menu')).getByRole('menuitem', { name: labels.signUp })).toBeInTheDocument();
    expect(within(screen.getByTestId('withdrawn-menu')).getByRole('menuitem', { name: labels.signUp })).toBeInTheDocument();
    expect(within(screen.getByTestId('pending-menu')).getByRole('menuitem', { name: labels.withdraw })).toBeInTheDocument();
    for (const id of ['full', 'approved', 'rejected']) expect(within(screen.getByTestId(`${id}-menu`)).queryByRole('menuitem')).not.toBeInTheDocument();
  });

  it('opens the sign-up dialog for the shift and closes it again', async () => {
    renderList();
    await user().click(within(screen.getByTestId('last-menu')).getByRole('menuitem', { name: labels.signUp }));
    expect(screen.getByRole('dialog')).toHaveTextContent(labels.signUpTitle);

    await user().click(screen.getByRole('button', { name: en.weldhr.common.cancel }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('withdraws a pending sign-up from the row menu', async () => {
    renderList();
    await user().click(within(screen.getByTestId('pending-menu')).getByRole('menuitem', { name: labels.withdraw }));
    expect(mocks.cancel).toHaveBeenCalledWith('req_p');
  });

  it('disables withdrawing while a withdrawal runs', () => {
    mocks.cancelPending = true;
    renderList();
    expect(within(screen.getByTestId('pending-menu')).getByRole('menuitem', { name: labels.withdraw })).toBeDisabled();
  });

  it('narrows the rows by state, and by client', async () => {
    renderList();
    await user().click(screen.getByRole('button', { name: `filter state: ${t.schedule.filters.full}` }));
    expect(rowIds(groups.open)).toEqual(['full']);
    expect(rowIds(groups.mine)).toEqual([]);

    await user().click(screen.getByRole('button', { name: `filter state: ${t.schedule.filters.signedUp}` }));
    expect(rowIds(groups.mine)).toEqual(['pending', 'approved', 'rejected']);
    expect(rowIds(groups.open)).toEqual([]);

    await user().click(screen.getByRole('button', { name: `filter state: ${t.schedule.filters.available}` }));
    expect(rowIds(groups.open)).toEqual(['last', 'open', 'withdrawn']);

    await user().click(screen.getByRole('button', { name: 'filter client: Beta' }));
    expect(rowIds(groups.open)).toEqual(['last']);
  });

  it('leaves every shift in when a filter has no value or an unknown field', async () => {
    renderList();
    await user().click(screen.getByRole('button', { name: 'filter without value' }));
    expect(rowIds(groups.open)).toHaveLength(4);
    await user().click(screen.getByRole('button', { name: 'filter unknown field' }));
    expect(rowIds(groups.mine)).toHaveLength(3);
  });

  it('searches the type of work, client, department and notes', async () => {
    renderList();
    await user().type(screen.getByPlaceholderText(t.schedule.search.openShifts), 'warehouse');
    expect(rowIds(groups.open)).toEqual(['last']);
    expect(rowIds(groups.mine)).toEqual([]);
  });

  it('offers no client filter when no shift has a client', () => {
    mocks.data = [FULL];
    renderList();
    expect(screen.queryByRole('button', { name: /^filter client:/ })).not.toBeInTheDocument();
  });

  it('shows the loading state', () => {
    mocks.data = undefined;
    mocks.isLoading = true;
    renderList();
    expect(screen.getByText('loading')).toBeInTheDocument();
  });

  it('shows the error when the open shifts could not load', () => {
    mocks.data = undefined;
    mocks.error = new Error('Boom');
    renderList();
    expect(screen.getByText('Boom')).toBeInTheDocument();
  });

  it('shows the empty state when no shift needs people', () => {
    mocks.data = undefined;
    renderList();
    expect(screen.getByText(t.schedule.empty.openShifts.title)).toBeInTheDocument();
  });
});
