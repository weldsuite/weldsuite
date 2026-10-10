import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { EntityGridActions, EntityGridConfig, GridColumnDef } from './types';
import { GridProvider, useGridContext } from './context';
import { GRID_VIEW_SAVE_DEBOUNCE_MS } from './use-grid-view-persistence';

const { put } = vi.hoisted(() => ({ put: vi.fn() }));

vi.mock('@weldsuite/i18n/client', () => ({
  useTranslations: () => (key: string) => key,
}));
vi.mock('@/lib/api/use-app-api', () => {
  const client = { put };
  const getClient = () => Promise.resolve(client);
  return { useAppApiClient: () => ({ getClient }) };
});
vi.mock('@/hooks/queries/use-settings-queries', () => ({
  gridViewQueryKey: (gridName: string) => ['settings', 'grid-view', gridName],
}));

interface Row {
  id: string;
}

const col = (id: string, visible = true, width = 150): GridColumnDef<Row> => ({
  id,
  name: id,
  type: 'text',
  width,
  visible,
  getValue: () => '',
});

// Companies-like defaults: Owner and the custom Tier column start hidden.
const baseColumns = () => [col('name'), col('website'), col('ownerId', false)];

function makeConfig(
  overrides: Partial<EntityGridConfig<Row>> = {},
): EntityGridConfig<Row> {
  return {
    entityName: 'Company',
    entityNamePlural: 'Companies',
    columns: baseColumns(),
    getEntityId: (row) => row.id,
    getEntityName: (row) => row.id,
    ...overrides,
  };
}

const actions: EntityGridActions<Row> = {
  onUpdateEntity: () => Promise.resolve({ success: true }),
  onDeleteEntity: () => Promise.resolve({ success: true }),
};

/** Shows the visible column ids, with a button that hides "website" the way the toolbar does. */
function Probe() {
  const { state, getVisibleColumns, setColumns } = useGridContext<Row>();
  return (
    <>
      <span data-testid="visible">{getVisibleColumns().map((c) => c.id).join(',')}</span>
      <button
        type="button"
        onClick={() => setColumns(state.columns.map((c) => (c.id === 'website' ? { ...c, visible: false } : c)))}
      >
        hide website
      </button>
    </>
  );
}

const queryClient = new QueryClient();

function Tree({ config }: Readonly<{ config: EntityGridConfig<Row> }>) {
  return (
    <QueryClientProvider client={queryClient}>
      <GridProvider config={config} actions={actions} entities={[]}>
        <Probe />
      </GridProvider>
    </QueryClientProvider>
  );
}

const visible = () => screen.getByTestId('visible').textContent;

beforeEach(() => {
  vi.useFakeTimers();
  put.mockReset();
  put.mockResolvedValue({});
});
afterEach(() => vi.useRealTimers());

const settle = () =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(GRID_VIEW_SAVE_DEBOUNCE_MS * 2);
  });

describe('GridProvider saved view', () => {
  it('starts from the saved view when it is there at first render', () => {
    render(<Tree config={makeConfig({ initialVisibility: { ownerId: true, website: false } })} />);
    expect(visible()).toBe('name,ownerId');
  });

  it('applies a saved view that arrives after the grid mounted on the defaults (reload while the query cache restores)', () => {
    const { rerender } = render(<Tree config={makeConfig({ initialVisibility: null })} />);
    expect(visible()).toBe('name,website');

    rerender(<Tree config={makeConfig({ initialVisibility: { ownerId: true, website: true } })} />);
    expect(visible()).toBe('name,website,ownerId');
  });

  it('applies a saved view that changes after mount, in both directions', () => {
    const { rerender } = render(
      <Tree config={makeConfig({ initialVisibility: { name: true, website: true, ownerId: false } })} />,
    );
    expect(visible()).toBe('name,website');

    rerender(<Tree config={makeConfig({ initialVisibility: { name: true, website: false, ownerId: true } })} />);
    expect(visible()).toBe('name,ownerId');
  });

  it('shows a custom column that loads after the saved view says it is visible', () => {
    const view = { 'custom:tier': true, ownerId: true };
    const { rerender } = render(<Tree config={makeConfig({ initialVisibility: view })} />);
    expect(visible()).toBe('name,website,ownerId');

    rerender(
      <Tree config={makeConfig({ initialVisibility: view, columns: [...baseColumns(), col('custom:tier', false)] })} />,
    );
    expect(visible()).toBe('name,website,ownerId,custom:tier');
  });

  it('keeps a column the user hid before the saved view arrived', () => {
    const { rerender } = render(<Tree config={makeConfig({ initialVisibility: null })} />);
    fireEvent.click(screen.getByText('hide website'));
    expect(visible()).toBe('name');

    rerender(<Tree config={makeConfig({ initialVisibility: { website: true, ownerId: true } })} />);
    // Owner follows the view; Website stays hidden because the user chose that.
    expect(visible()).toBe('name,ownerId');
  });

  it('never saves when the view arrives late, and a later change merges into the saved view', async () => {
    const { rerender } = render(<Tree config={makeConfig({ initialVisibility: null })} />);
    await settle();
    rerender(<Tree config={makeConfig({ initialVisibility: { name: true, website: true, ownerId: true } })} />);
    await settle();
    expect(put).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText('hide website'));
    await settle();
    expect(put).toHaveBeenCalledTimes(1);
    expect(put.mock.calls[0]![0]).toBe('/grid-views/company');
    // The owner column the saved view shows stays visible in what is saved,
    // instead of being overwritten by the config default.
    expect(put.mock.calls[0]![1].columnVisibility).toMatchObject({ website: false, ownerId: true });
  });
});
