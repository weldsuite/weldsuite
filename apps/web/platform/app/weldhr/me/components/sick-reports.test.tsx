import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nProvider } from '@weldsuite/i18n/provider';
import type { HrSelfAbsence, HrSelfAbsences } from '@weldsuite/app-api-client/domains/weldhr';
import { MySickReportsList } from './sick-reports';

type Row = HrSelfAbsence;
interface StubProps {
  items: Row[];
  isLoading: boolean;
  error: Error | null;
  columns: Array<{ id: string; render: (row: Row) => ReactNode }>;
  filters: Array<{ field: string; options: Array<{ value: string; label: string }> }>;
  groups: Array<{ id: string; filter: (row: Row) => boolean }>;
  applyFilters: (rows: Row[], active: Array<{ field: string; value: string }>) => Row[];
  onRowClick: (row: Row) => void;
  rowMenu: (row: Row) => ReactNode;
  createButton: { label: string; onClick: () => void };
  emptyState: { title: string; description: string; action: { label: string } };
}

const mocks = vi.hoisted(() => ({ open: vi.fn() }));
let data: HrSelfAbsences | undefined;
let loading = false;
let failure: Error | null = null;

vi.mock('@weldsuite/ui/components/dropdown-menu', () => ({
  DropdownMenuItem: ({ children, onClick }: { children: ReactNode; onClick?: () => void }) => (
    <button type="button" onClick={onClick}>
      {children}
    </button>
  ),
}));
vi.mock('@/components/object-panel', () => ({ useObjectPanel: () => ({ open: mocks.open }) }));
vi.mock('@/hooks/queries/use-weldhr-queries', () => ({
  useMyHrAbsences: () => ({ data, isLoading: loading, error: failure }),
}));
vi.mock('../../absenteeism/components/absence-dialog', () => ({
  AbsenceDialog: ({ mode, onClose }: { mode: { kind: string }; onClose: () => void }) => (
    <div role="dialog" aria-label="absence dialog">
      mode {mode.kind}
      <button type="button" onClick={onClose}>
        close absence dialog
      </button>
    </div>
  ),
}));
vi.mock('../../absenteeism/components/recover-dialog', () => ({
  RecoverDialog: ({ absence, self, onClose }: { absence: Row; self?: boolean; onClose: () => void }) => (
    <div role="dialog" aria-label="recover dialog">
      recover {absence.id} self {String(self)}
      <button type="button" onClick={onClose}>
        close recover dialog
      </button>
    </div>
  ),
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
          <button type="button" onClick={() => setShown(props.applyFilters(props.items, [{ field: 'status', value: '' }, { field: 'x', value: 'y' }]))}>
            filter ignored
          </button>
          {props.groups.map((group) => (
            <p key={group.id} data-testid={`group-${group.id}`}>
              {props.items
                .filter(group.filter)
                .map((row) => row.id)
                .join(',')}
            </p>
          ))}
          <button type="button" onClick={props.createButton.onClick}>
            {props.createButton.label}
          </button>
          {rows.length === 0 && (
            <div data-testid="empty">
              <p>{props.emptyState.title}</p>
              <p>{props.emptyState.description}</p>
              <span>empty action {props.emptyState.action.label}</span>
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
                <span data-testid={`${row.id}-menu`}>{props.rowMenu(row)}</span>
              </li>
            ))}
          </ul>
        </div>
      );
    },
  };
});

function absence(extra: Partial<Row> & { id: string }): Row {
  return {
    startDate: '2026-11-02',
    endDate: '2026-11-05',
    firstDay: 'full',
    note: null,
    status: 'completed',
    days: 4,
    createdAt: '2026-11-02T08:00:00.000Z',
    ...extra,
  };
}

function renderList() {
  return render(
    <I18nProvider initialLanguage="en">
      <MySickReportsList />
    </I18nProvider>,
  );
}

beforeEach(() => {
  mocks.open.mockReset();
  loading = false;
  failure = null;
  data = {
    current: absence({ id: 'abs_open', status: 'ongoing', endDate: null, firstDay: 'half', days: 2.5, startDate: '2026-11-20' }),
    history: [absence({ id: 'abs_old' }), absence({ id: 'abs_open', status: 'ongoing', endDate: null })],
  };
});

describe('MySickReportsList', () => {
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

  it('lists the open report first, once, and groups ongoing apart from completed', () => {
    renderList();

    expect(screen.getAllByTestId(/^row-/).map((row) => row.dataset.testid)).toEqual(['row-abs_open', 'row-abs_old']);
    expect(screen.getByTestId('group-ongoing')).toHaveTextContent('abs_open');
    expect(screen.getByTestId('group-completed')).toHaveTextContent('abs_old');
  });

  it('shows the first day with a half-day note, the last day or Still absent, days and status', () => {
    renderList();

    expect(screen.getByTestId('abs_open-firstDay')).toHaveTextContent('half day');
    expect(screen.getByTestId('abs_open-firstDay')).toHaveTextContent('Still absent');
    expect(screen.getByTestId('abs_open-firstDay')).toHaveTextContent(/2[.,]5/);
    expect(screen.getByTestId('abs_open-lastDay')).toHaveTextContent('Still absent');
    expect(screen.getByTestId('abs_open-status')).toHaveTextContent('Sick');
    expect(screen.getByTestId('abs_old-firstDay')).not.toHaveTextContent('half day');
    expect(screen.getByTestId('abs_old-lastDay')).not.toHaveTextContent('Still absent');
    expect(screen.getByTestId('abs_old-lastDay')).toHaveTextContent('2026');
    expect(screen.getByTestId('abs_old-days')).toHaveTextContent('4');
    expect(screen.getByTestId('abs_old-status')).toHaveTextContent('Recovered');
  });

  it('narrows the rows by status', async () => {
    const user = userEvent.setup();
    renderList();

    await user.click(screen.getByRole('button', { name: 'filter status Recovered' }));
    expect(screen.getAllByTestId(/^row-/).map((row) => row.dataset.testid)).toEqual(['row-abs_old']);

    await user.click(screen.getByRole('button', { name: 'filter status Sick' }));
    expect(screen.getAllByTestId(/^row-/).map((row) => row.dataset.testid)).toEqual(['row-abs_open']);

    await user.click(screen.getByRole('button', { name: 'filter ignored' }));
    expect(screen.getAllByTestId(/^row-/)).toHaveLength(2);
  });

  it('opens the sick report panel from a row', async () => {
    const user = userEvent.setup();
    renderList();

    await user.click(screen.getByRole('button', { name: 'open abs_old' }));
    expect(mocks.open).toHaveBeenCalledWith(expect.objectContaining({ id: 'abs_old' }));
  });

  it('reports recovered from the row menu of the open report only, and closes the dialog', async () => {
    const user = userEvent.setup();
    renderList();

    expect(within(screen.getByTestId('abs_old-menu')).queryByRole('button')).not.toBeInTheDocument();
    await user.click(within(screen.getByTestId('abs_open-menu')).getByRole('button', { name: 'Report recovered' }));
    expect(screen.getByRole('dialog', { name: 'recover dialog' })).toHaveTextContent('recover abs_open self true');

    await user.click(screen.getByRole('button', { name: 'close recover dialog' }));
    expect(screen.queryByRole('dialog', { name: 'recover dialog' })).not.toBeInTheDocument();
  });

  it('while reported sick, the top button reports recovered', async () => {
    const user = userEvent.setup();
    renderList();

    const buttons = screen.getAllByRole('button', { name: 'Report recovered' });
    await user.click(buttons[0]);
    expect(screen.getByRole('dialog', { name: 'recover dialog' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Report sick' })).not.toBeInTheDocument();
  });

  it('when not sick, the button reports sick and opens the self-report dialog', async () => {
    data = { current: null, history: [absence({ id: 'abs_old' })] };
    const user = userEvent.setup();
    renderList();

    await user.click(screen.getByRole('button', { name: 'Report sick' }));
    expect(screen.getByRole('dialog', { name: 'absence dialog' })).toHaveTextContent('mode self');

    await user.click(screen.getByRole('button', { name: 'close absence dialog' }));
    expect(screen.queryByRole('dialog', { name: 'absence dialog' })).not.toBeInTheDocument();
  });

  it('shows the empty state without any report', () => {
    data = { current: null, history: [] };
    renderList();

    expect(screen.getByTestId('empty')).toHaveTextContent('You are not reported sick');
    expect(screen.getByTestId('empty')).toHaveTextContent('No earlier sick reports.');
    expect(screen.getByText('empty action Report sick')).toBeInTheDocument();
  });
});
