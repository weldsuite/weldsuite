import { useState, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nProvider } from '@weldsuite/i18n/provider';
import type { HrSelfPerformance } from '@weldsuite/app-api-client/domains/weldhr';
import type { ActiveFilter, ColumnDef, FilterConfig, GroupConfig } from '@/components/panel-entity-list';

/** The row handlers the real list hands each column; these columns use none of them. */
const ROW_HANDLERS = { onEdit: () => {}, onDelete: () => {}, onDuplicate: () => {}, onUpdate: () => {} };

interface StubProps {
  items: Array<{ id: string }>;
  isLoading: boolean;
  error?: Error | null;
  columns: ColumnDef<{ id: string }>[];
  onRowClick: (row: { id: string }) => void;
  groups: GroupConfig<{ id: string }>[];
  filters: FilterConfig[];
  applyFilters: (rows: Array<{ id: string }>, active: ActiveFilter[]) => Array<{ id: string }>;
  searchFields: string[];
  searchPlaceholder: string;
  emptyState: { title: string; description: string };
}

interface Query {
  data: HrSelfPerformance | undefined;
  isLoading: boolean;
  error: Error | null;
}

const mocks = vi.hoisted(() => ({ open: vi.fn() }));

let query: Query;

vi.mock('@/components/object-panel', () => ({ useObjectPanel: () => ({ open: mocks.open }) }));
vi.mock('@/hooks/queries/use-weldhr-queries', () => ({ useMyHrPerformance: () => query }));
// A plain stand-in for the list: its groups, filter options and columns, as the list would use them.
vi.mock('@/components/panel-entity-list', () => ({
  PanelEntityList: (props: StubProps) => <ListStub {...props} />,
}));

function ListStub(props: StubProps) {
  const [active, setActive] = useState<ActiveFilter[]>([]);
  if (props.isLoading) return <p>loading</p>;
  if (props.error) return <p role="alert">{props.error.message}</p>;
  if (props.items.length === 0) {
    return (
      <div>
        <p>{props.emptyState.title}</p>
        <p>{props.emptyState.description}</p>
      </div>
    );
  }
  const rows = props.applyFilters(props.items, active);
  return (
    <div>
      <input aria-label="search" placeholder={props.searchPlaceholder} data-fields={props.searchFields.join(',')} readOnly />
      <button type="button" onClick={() => setActive([{ id: 'blank', field: 'result', operator: 'is', value: '' }])}>
        blank filter
      </button>
      <button type="button" onClick={() => setActive([{ id: 'x', field: 'unknown', operator: 'is', value: 'x' }])}>
        unknown filter
      </button>
      {props.filters.map((filter) => (
        <div key={filter.field} role="group" aria-label={`filter ${filter.field}`}>
          {filter.options?.map((option) => (
            <button
              key={option.value}
              type="button"
              onClick={() => setActive([{ id: `${filter.field}-${option.value}`, field: filter.field, operator: 'is', value: option.value }])}
            >
              {`${filter.field}: ${option.label}`}
            </button>
          ))}
        </div>
      ))}
      {[...props.groups]
        .sort((a, b) => a.sortOrder - b.sortOrder)
        .map((group) => {
          const inGroup = rows.filter(group.filter);
          if (inGroup.length === 0) return null;
          return (
            <section key={group.id} aria-label={`group ${group.id}`}>
              <h4>{group.label}</h4>
              {inGroup.map((row) => (
                <div key={row.id} data-testid={`row-${row.id}`}>
                  {props.columns.map((column) => (
                    <div key={column.id} data-column={column.id}>
                      {column.render(row, ROW_HANDLERS)}
                    </div>
                  ))}
                  <button type="button" onClick={() => props.onRowClick(row)}>{`open ${row.id}`}</button>
                </div>
              ))}
            </section>
          );
        })}
    </div>
  );
}

import { KpiResultBadge, MyKpisList, MyMilestonesList } from './goals-tab';

type KpiResult = HrSelfPerformance['kpis'][number];
type Milestone = HrSelfPerformance['milestones'][number];

function kpi(extra: Partial<KpiResult> = {}): KpiResult {
  return {
    id: 'res_1',
    kpiId: 'kpi_1',
    kpiName: 'Tickets closed',
    unit: 'number',
    direction: 'higher_better',
    target: 50,
    value: 60,
    onTarget: true,
    periodStart: '2026-09-01',
    periodEnd: '2026-09-30',
    ...extra,
  };
}

function milestone(extra: Partial<Milestone> = {}): Milestone {
  return {
    id: 'ms_1',
    title: 'AWS certified',
    description: null,
    type: 'certification',
    status: 'in_progress',
    dueDate: '2026-12-15',
    achievedAt: null,
    companyName: 'Globex',
    ...extra,
  };
}

function loaded(data: HrSelfPerformance): Query {
  return { data, isLoading: false, error: null };
}

function renderWithI18n(ui: ReactNode) {
  return render(<I18nProvider initialLanguage="en">{ui}</I18nProvider>);
}

const rowIds = () => screen.getAllByTestId(/^row-/).map((r) => r.dataset.testid);

beforeEach(() => {
  mocks.open.mockReset();
  query = loaded({ kpis: [], milestones: [] });
});

describe('KpiResultBadge', () => {
  it('shows on target, off target and no target', () => {
    renderWithI18n(
      <>
        <KpiResultBadge kpi={kpi({ onTarget: true })} />
        <KpiResultBadge kpi={kpi({ onTarget: false })} />
        <KpiResultBadge kpi={kpi({ onTarget: null })} />
      </>,
    );

    expect(screen.getByText('On target')).toHaveClass('text-emerald-700');
    expect(screen.getByText('Off target')).toHaveClass('text-red-600');
    expect(screen.getByText('No target set')).toHaveClass('text-muted-foreground');
  });
});

describe('MyKpisList', () => {
  beforeEach(() => {
    query = loaded({
      milestones: [],
      kpis: [
        // Two results of the same KPI: the latest counts.
        kpi({ id: 'r_old', periodStart: '2026-08-01', periodEnd: '2026-08-31', value: 10, onTarget: false }),
        kpi({ id: 'r_new', value: 60 }),
        kpi({ id: 'r_back', periodStart: '2026-07-01', periodEnd: '2026-07-31', value: 5, onTarget: false }),
        kpi({ id: 'r_b', kpiId: 'kpi_2', kpiName: 'Response time', unit: 'minutes', target: 30, value: 45, onTarget: false }),
        kpi({ id: 'r_c', kpiId: 'kpi_3', kpiName: 'Satisfaction', unit: 'percent', target: null, value: 93.14, onTarget: null }),
      ],
    });
  });

  it('shows the latest result of each KPI, grouped off target first', () => {
    renderWithI18n(<MyKpisList />);

    expect(rowIds()).toEqual(['row-kpi_2', 'row-kpi_1', 'row-kpi_3']);
    expect(within(screen.getByRole('region', { name: 'group off' })).getByText('Off target', { selector: 'h4' })).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'group on' })).getByTestId('row-kpi_1')).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'group none' })).getByTestId('row-kpi_3')).toBeInTheDocument();
    expect(screen.getByLabelText('search')).toHaveAttribute('data-fields', 'kpiName');
  });

  it('shows the value, target, result and period of a KPI', () => {
    renderWithI18n(<MyKpisList />);

    const row = screen.getByTestId('row-kpi_1');
    const cell = (id: string) => row.querySelector(`[data-column="${id}"]`) as HTMLElement;
    expect(within(cell('kpi')).getByText('Tickets closed')).toBeInTheDocument();
    expect(within(cell('kpi')).getByText('60 / 50')).toBeInTheDocument();
    expect(cell('value')).toHaveTextContent('60');
    expect(cell('target')).toHaveTextContent('50');
    expect(cell('result')).toHaveTextContent('On target');
    expect(cell('period')).toHaveTextContent(/1 Sep\w* 2026 – 30 Sep\w* 2026/);
  });

  it('formats by unit, and shows a dash for a missing target', () => {
    renderWithI18n(<MyKpisList />);

    const minutes = screen.getByTestId('row-kpi_2');
    expect(minutes.querySelector('[data-column="value"]')).toHaveTextContent('0h 45m');
    expect(minutes.querySelector('[data-column="target"]')).toHaveTextContent('0h 30m');

    const percent = screen.getByTestId('row-kpi_3');
    expect(percent.querySelector('[data-column="value"]')).toHaveTextContent('93.1%');
    expect(percent.querySelector('[data-column="target"]')).toHaveTextContent('—');
    expect(within(percent.querySelector('[data-column="kpi"]') as HTMLElement).getByText('93.1% / —')).toBeInTheDocument();
    expect(percent.querySelector('[data-column="result"]')).toHaveTextContent('No target set');
  });

  it('opens the panel of the KPI, not of its latest result', async () => {
    const user = userEvent.setup();
    renderWithI18n(<MyKpisList />);

    await user.click(screen.getByRole('button', { name: 'open kpi_1' }));
    expect(mocks.open).toHaveBeenCalledWith({ type: 'hr_my_kpi', id: 'kpi_1' });
  });

  it('filters by result, and ignores a blank or unknown filter', async () => {
    const user = userEvent.setup();
    renderWithI18n(<MyKpisList />);

    const options = within(screen.getByRole('group', { name: 'filter result' })).getAllByRole('button');
    expect(options.map((b) => b.textContent)).toEqual(['result: Off target', 'result: On target', 'result: No target set']);

    await user.click(screen.getByRole('button', { name: 'result: On target' }));
    expect(rowIds()).toEqual(['row-kpi_1']);
    await user.click(screen.getByRole('button', { name: 'result: No target set' }));
    expect(rowIds()).toEqual(['row-kpi_3']);
    await user.click(screen.getByRole('button', { name: 'blank filter' }));
    expect(rowIds()).toHaveLength(3);
    await user.click(screen.getByRole('button', { name: 'unknown filter' }));
    expect(rowIds()).toHaveLength(3);
  });

  it('says so when there are none, while loading and when loading failed', () => {
    query = loaded({ kpis: [], milestones: [] });
    const first = renderWithI18n(<MyKpisList />);
    expect(screen.getByText('No KPI results yet')).toBeInTheDocument();
    first.unmount();

    query = { data: undefined, isLoading: true, error: null };
    const second = renderWithI18n(<MyKpisList />);
    expect(screen.getByText('loading')).toBeInTheDocument();
    second.unmount();

    query = { data: undefined, isLoading: false, error: new Error('Down') };
    renderWithI18n(<MyKpisList />);
    expect(screen.getByRole('alert')).toHaveTextContent('Down');
  });
});

describe('MyMilestonesList', () => {
  beforeEach(() => {
    query = loaded({
      kpis: [],
      milestones: [
        milestone(),
        milestone({ id: 'ms_2', title: 'Ship the thing', type: 'goal', status: 'planned', dueDate: null, companyName: null }),
        milestone({ id: 'ms_3', title: 'Learn Rust', type: 'milestone', status: 'achieved', achievedAt: '2026-11-01' }),
        milestone({ id: 'ms_4', title: 'Missed one', type: 'goal', status: 'missed' }),
        // A status the list does not know goes into "other".
        milestone({ id: 'ms_5', title: 'Odd one', status: 'cancelled' as Milestone['status'] }),
      ],
    });
  });

  it('groups by status, what is being worked on first, and an unknown status last', () => {
    renderWithI18n(<MyMilestonesList />);

    expect(rowIds()).toEqual(['row-ms_1', 'row-ms_2', 'row-ms_3', 'row-ms_4', 'row-ms_5']);
    expect(within(screen.getByRole('region', { name: 'group other' })).getByTestId('row-ms_5')).toBeInTheDocument();
    expect(screen.getByLabelText('search')).toHaveAttribute('data-fields', 'title,description,companyName');
  });

  it('shows the type, dates, client and status of a milestone', () => {
    renderWithI18n(<MyMilestonesList />);

    const row = screen.getByTestId('row-ms_3');
    const cell = (id: string) => row.querySelector(`[data-column="${id}"]`) as HTMLElement;
    expect(within(cell('milestone')).getByText('Learn Rust')).toBeInTheDocument();
    expect(within(cell('milestone')).getByText('Milestone · 15 Dec 2026')).toBeInTheDocument();
    expect(cell('type')).toHaveTextContent('Milestone');
    expect(cell('due')).toHaveTextContent('15 Dec 2026');
    expect(cell('achieved')).toHaveTextContent('1 Nov 2026');
    expect(cell('client')).toHaveTextContent('Globex');
    expect(cell('status')).toHaveTextContent('Achieved');
  });

  it('shows dashes for what is not set', () => {
    renderWithI18n(<MyMilestonesList />);

    const row = screen.getByTestId('row-ms_2');
    const cell = (id: string) => row.querySelector(`[data-column="${id}"]`) as HTMLElement;
    expect(within(cell('milestone')).getByText('Goal')).toBeInTheDocument();
    expect(cell('due')).toHaveTextContent('—');
    expect(cell('achieved')).toHaveTextContent('—');
    expect(cell('client')).toHaveTextContent('—');
  });

  it('opens the panel of a milestone', async () => {
    const user = userEvent.setup();
    renderWithI18n(<MyMilestonesList />);

    await user.click(screen.getByRole('button', { name: 'open ms_4' }));
    expect(mocks.open).toHaveBeenCalledWith({ type: 'hr_my_milestone', id: 'ms_4' });
  });

  it('filters by status and by type, and ignores a blank or unknown filter', async () => {
    const user = userEvent.setup();
    renderWithI18n(<MyMilestonesList />);

    expect(within(screen.getByRole('group', { name: 'filter status' })).getAllByRole('button')).toHaveLength(4);
    expect(within(screen.getByRole('group', { name: 'filter type' })).getAllByRole('button')).toHaveLength(3);

    await user.click(screen.getByRole('button', { name: 'status: Planned' }));
    expect(rowIds()).toEqual(['row-ms_2']);
    await user.click(screen.getByRole('button', { name: 'type: Goal' }));
    expect(rowIds()).toEqual(['row-ms_2', 'row-ms_4']);
    await user.click(screen.getByRole('button', { name: 'blank filter' }));
    expect(rowIds()).toHaveLength(5);
    await user.click(screen.getByRole('button', { name: 'unknown filter' }));
    expect(rowIds()).toHaveLength(5);
  });

  it('says so when there are none, while loading and when loading failed', () => {
    query = loaded({ kpis: [], milestones: [] });
    const first = renderWithI18n(<MyMilestonesList />);
    expect(screen.getByText('No milestones yet')).toBeInTheDocument();
    first.unmount();

    query = { data: undefined, isLoading: true, error: null };
    const second = renderWithI18n(<MyMilestonesList />);
    expect(screen.getByText('loading')).toBeInTheDocument();
    second.unmount();

    query = { data: undefined, isLoading: false, error: new Error('Down') };
    renderWithI18n(<MyMilestonesList />);
    expect(screen.getByRole('alert')).toHaveTextContent('Down');
  });
});
