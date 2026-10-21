import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { EntityGridActions, EntityGridConfig, GridColumnDef } from '../types';
import { GridProvider, useGridContext } from '../context';
import { GridTable } from './grid-table';

vi.mock('@weldsuite/i18n/client', () => ({
  useTranslations: () => (key: string) => key,
}));
vi.mock('@/lib/api/use-app-api', () => {
  const client = { put: () => Promise.resolve({}) };
  const getClient = () => Promise.resolve(client);
  return { useAppApiClient: () => ({ getClient }) };
});
vi.mock('@/hooks/queries/use-settings-queries', () => ({
  gridViewQueryKey: (gridName: string) => ['settings', 'grid-view', gridName],
}));

beforeAll(() => {
  class RO {
    observe() { /* no-op */ }
    unobserve() { /* no-op */ }
    disconnect() { /* no-op */ }
  }
  (globalThis as unknown as { ResizeObserver: typeof RO }).ResizeObserver = RO;
});

interface Row {
  id: string;
  name: string;
}

/** "<row id>:<column id>" for every cell render of the spied columns. */
let renders: string[] = [];

const spiedColumn = (id: string, extra: Partial<GridColumnDef<Row>> = {}): GridColumnDef<Row> => ({
  id,
  name: id,
  type: 'text',
  width: 150,
  visible: true,
  getValue: (r) => r.id,
  render: (r) => {
    renders.push(`${r.id}:${id}`);
    return r.id;
  },
  ...extra,
});

const nameColumn: GridColumnDef<Row> = {
  id: 'name',
  name: 'Name',
  type: 'company',
  width: 200,
  visible: true,
  getValue: (r) => r.name,
};
const cityColumn = spiedColumn('city');
const tierColumn = spiedColumn('tier');

const config: EntityGridConfig<Row> = {
  entityName: 'Company',
  entityNamePlural: 'Companies',
  columns: [nameColumn, cityColumn, tierColumn],
  getEntityId: (r) => r.id,
  getEntityName: (r) => r.name,
};

const actions: EntityGridActions<Row> = {
  onUpdateEntity: () => Promise.resolve({ success: true }),
  onDeleteEntity: () => Promise.resolve({ success: true }),
};

const makeRows = (from: number, count: number): Row[] =>
  Array.from({ length: count }, (_, i) => ({ id: `r${from + i}`, name: `Company ${from + i}` }));

/** Changes grid state the way the header and the select/status cells do. */
function Probe() {
  const { handleColumnResize, setOpenPopover } = useGridContext<Row>();
  return (
    <>
      <button type="button" onClick={() => handleColumnResize('city', 300)}>
        resize
      </button>
      <button type="button" onClick={() => setOpenPopover({ rowId: 'r3', fieldId: 'tier' })}>
        open popover
      </button>
    </>
  );
}

const queryClient = new QueryClient();

function Tree({ rows, gridConfig = config }: Readonly<{ rows: Row[]; gridConfig?: EntityGridConfig<Row> }>) {
  return (
    <QueryClientProvider client={queryClient}>
      <GridProvider config={gridConfig} actions={actions} entities={rows}>
        <Probe />
        <GridTable />
      </GridProvider>
    </QueryClientProvider>
  );
}

const renderedRows = () => [...new Set(renders.map((r) => r.split(':')[0]))];

beforeEach(() => {
  renders = [];
});

describe('GridTable re-renders only what changed', () => {
  const rows = makeRows(1, 30);

  it('renders every cell once on mount', () => {
    render(<Tree rows={rows} />);
    expect(renders).toHaveLength(rows.length * 2);
  });

  it('ticking a row re-renders none of the data cells', () => {
    render(<Tree rows={rows} />);
    renders = [];

    const row = document.querySelector('[data-entity-id="r5"]') as HTMLElement;
    fireEvent.click(within(row).getByRole('checkbox'));

    expect(within(row).getByRole('checkbox')).toHaveAttribute('data-state', 'checked');
    expect(renders).toEqual([]);
  });

  it('resizing a column re-renders no cells', () => {
    render(<Tree rows={rows} />);
    renders = [];

    fireEvent.click(screen.getByText('resize'));

    expect(renders).toEqual([]);
  });

  it('opening a popover re-renders that cell only', () => {
    render(<Tree rows={rows} />);
    renders = [];

    fireEvent.click(screen.getByText('open popover'));

    expect(renders).toEqual(['r3:tier']);
  });

  it('loading the next page renders the new rows only', () => {
    const { rerender } = render(<Tree rows={rows} />);
    renders = [];

    const nextPage = makeRows(31, 10);
    rerender(<Tree rows={[...rows, ...nextPage]} />);

    expect(renderedRows()).toEqual(nextPage.map((r) => r.id));
  });

  it('a config rebuilt around one changed column re-renders that column only', () => {
    const { rerender } = render(<Tree rows={rows} />);
    renders = [];

    // What the CRM grids do when a new page brings new tag options.
    const rebuilt = { ...config, columns: [nameColumn, cityColumn, { ...tierColumn, options: ['gold'] }] };
    rerender(<Tree rows={rows} gridConfig={rebuilt} />);

    expect(renders.every((r) => r.endsWith(':tier'))).toBe(true);
    expect(renders).toHaveLength(rows.length);
  });
});
