import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nProvider } from '@weldsuite/i18n/provider';
import type { HrLeaveBalance, HrSelfLeave } from '@weldsuite/app-api-client/domains/weldhr';
import { MyLeaveBalancesList } from './leave-balances';

type Row = HrLeaveBalance & { id: string };
interface StubProps {
  items: Row[];
  isLoading: boolean;
  error: Error | null;
  columns: Array<{ id: string; render: (row: Row) => ReactNode }>;
  filters: Array<{ field: string; options: Array<{ value: string; label: string }> }>;
  applyFilters: (rows: Row[], active: Array<{ field: string; value: string }>) => Row[];
  onRowClick: (row: Row) => void;
  emptyState: { title: string; description: string };
}

const mocks = vi.hoisted(() => ({ open: vi.fn() }));
let data: HrSelfLeave | undefined;
let loading = false;
let failure: Error | null = null;

vi.mock('@/components/object-panel', () => ({ useObjectPanel: () => ({ open: mocks.open }) }));
vi.mock('@/hooks/queries/use-weldhr-queries', () => ({
  useMyHrLeave: () => ({ data, isLoading: loading, error: failure }),
}));
vi.mock('@/components/panel-entity-list', async () => {
  const { useState } = await import('react');
  return {
    PanelEntityList: (props: StubProps) => {
      const [shown, setShown] = useState<Row[] | null>(null);
      const rows = shown ?? props.items;
      if (props.isLoading) return <p>stub loading</p>;
      if (props.error) return <p>stub error: {props.error.message}</p>;
      return (
        <div>
          {props.filters.map((filter) =>
            filter.options.map((option) => (
              <button
                key={`${filter.field}-${option.value}`}
                type="button"
                onClick={() => setShown(props.applyFilters(props.items, [{ field: filter.field, value: option.value }]))}
              >
                filter {filter.field} {option.label}
              </button>
            )),
          )}
          <button type="button" onClick={() => setShown(props.applyFilters(props.items, [{ field: 'pay', value: '' }, { field: 'x', value: 'y' }]))}>
            filter ignored
          </button>
          {rows.length === 0 && (
            <div data-testid="empty">
              <p>{props.emptyState.title}</p>
              <p>{props.emptyState.description}</p>
            </div>
          )}
          <ul>
            {rows.map((row) => (
              <li key={row.id} data-testid={`row-${row.id}`}>
                {props.columns.map((column) => (
                  <span key={column.id} data-testid={`${row.id}-${column.id}`}>
                    {column.render(row)}
                  </span>
                ))}
                <button type="button" onClick={() => props.onRowClick(row)}>
                  open {row.id}
                </button>
              </li>
            ))}
          </ul>
        </div>
      );
    },
  };
});

function balance(extra: Partial<HrLeaveBalance> & { leaveTypeId: string; name: string }): HrLeaveBalance {
  return {
    color: '#22aa55',
    isPaid: true,
    overAllowance: 'allow',
    allowance: 25,
    fullAllowance: 25,
    prorated: false,
    used: 5,
    pending: 2,
    remaining: 18,
    ...extra,
  };
}

function renderList() {
  return render(
    <I18nProvider initialLanguage="en">
      <MyLeaveBalancesList />
    </I18nProvider>,
  );
}

beforeEach(() => {
  mocks.open.mockReset();
  loading = false;
  failure = null;
  data = {
    types: [],
    requests: [],
    balances: [
      balance({ leaveTypeId: 'lt_annual', name: 'Annual leave' }),
      balance({ leaveTypeId: 'lt_unpaid', name: 'Unpaid leave', isPaid: false, color: null, allowance: null, remaining: null, pending: 0, used: 0 }),
    ],
  };
});

describe('MyLeaveBalancesList', () => {
  it('shows loading, and the error only when there is no data', () => {
    loading = true;
    const { unmount } = renderList();
    expect(screen.getByText('stub loading')).toBeInTheDocument();
    unmount();

    loading = false;
    data = undefined;
    failure = new Error('Server down');
    renderList();
    expect(screen.getByText('stub error: Server down')).toBeInTheDocument();
  });

  it('shows a limited balance as numbers', () => {
    renderList();

    expect(screen.getByTestId('lt_annual-type')).toHaveTextContent('Annual leave');
    expect(screen.getByTestId('lt_annual-type')).toHaveTextContent('Remaining: 18');
    expect(screen.getByTestId('lt_annual-allowance')).toHaveTextContent('25');
    expect(screen.getByTestId('lt_annual-used')).toHaveTextContent('5');
    expect(screen.getByTestId('lt_annual-pending')).toHaveTextContent('2');
    expect(screen.getByTestId('lt_annual-pending').firstElementChild).not.toHaveClass('text-muted-foreground');
    expect(screen.getByTestId('lt_annual-remaining')).toHaveTextContent('18');
  });

  it('shows an unlimited balance as Unlimited, with a muted zero pending', () => {
    renderList();

    expect(screen.getByTestId('lt_unpaid-type')).toHaveTextContent('Remaining: Unlimited');
    expect(screen.getByTestId('lt_unpaid-allowance')).toHaveTextContent('Unlimited');
    expect(screen.getByTestId('lt_unpaid-remaining')).toHaveTextContent('Unlimited');
    expect(screen.getByTestId('lt_unpaid-pending').firstElementChild).toHaveClass('text-muted-foreground');
  });

  it('narrows the rows to paid or unpaid leave', async () => {
    const user = userEvent.setup();
    renderList();

    await user.click(screen.getByRole('button', { name: 'filter pay Paid' }));
    expect(screen.getAllByTestId(/^row-/).map((row) => row.dataset.testid)).toEqual(['row-lt_annual']);

    await user.click(screen.getByRole('button', { name: 'filter pay Unpaid' }));
    expect(screen.getAllByTestId(/^row-/).map((row) => row.dataset.testid)).toEqual(['row-lt_unpaid']);

    await user.click(screen.getByRole('button', { name: 'filter ignored' }));
    expect(screen.getAllByTestId(/^row-/)).toHaveLength(2);
  });

  it('opens the balance panel from a row, keyed by the leave type', async () => {
    const user = userEvent.setup();
    renderList();

    await user.click(screen.getByRole('button', { name: 'open lt_annual' }));
    expect(mocks.open).toHaveBeenCalledWith(expect.objectContaining({ id: 'lt_annual' }));
  });

  it('shows the empty state without balances, and while there is no data', () => {
    data = { types: [], requests: [], balances: [] };
    const { unmount } = renderList();
    expect(screen.getByTestId('empty')).toHaveTextContent('No leave balances yet.');
    expect(screen.getByTestId('empty')).toHaveTextContent('Your HR team sets your allowance per leave type.');
    unmount();

    data = undefined;
    renderList();
    expect(screen.getByTestId('empty')).toBeInTheDocument();
  });
});
