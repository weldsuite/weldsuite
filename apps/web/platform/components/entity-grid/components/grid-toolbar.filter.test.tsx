import { describe, it, expect, vi, beforeAll } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { EntityGridActions, EntityGridConfig, GridColumnDef } from '../types';
import { GridProvider } from '../context';
import { GridToolbar } from './grid-toolbar';

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

interface Row {
  id: string;
  status: string;
}

const columns: GridColumnDef<Row>[] = [
  { id: 'name', name: 'Company', type: 'text', width: 200, visible: true, getValue: (r) => r.id },
  {
    id: 'status',
    name: 'Status',
    type: 'single-select',
    width: 130,
    visible: true,
    // Built-ins plus a workspace-defined custom status, as useCustomerStatusOptions() provides.
    options: ['active', 'prospect', 'custom_vip'],
    selectConfig: {
      active: { label: 'Active', color: '', bg: '' },
      prospect: { label: 'Prospect', color: '', bg: '' },
      custom_vip: { label: 'VIP', color: '', bg: '' },
    },
    getValue: (r) => r.status,
  },
];

const config: EntityGridConfig<Row> = {
  entityName: 'Company',
  entityNamePlural: 'Companies',
  columns,
  getEntityId: (r) => r.id,
  getEntityName: (r) => r.id,
};

const actions: EntityGridActions<Row> = {
  onUpdateEntity: () => Promise.resolve({ success: true }),
  onDeleteEntity: () => Promise.resolve({ success: true }),
};

const entities: Row[] = [
  { id: 'a', status: 'active' },
  { id: 'b', status: 'prospect' },
  { id: 'c', status: 'custom_vip' },
];

beforeAll(() => {
  // cmdk / Radix need these; jsdom has neither.
  class RO {
    observe() { /* no-op */ }
    unobserve() { /* no-op */ }
    disconnect() { /* no-op */ }
  }
  (globalThis as unknown as { ResizeObserver: typeof RO }).ResizeObserver = RO;
  Element.prototype.scrollIntoView = () => {};
});

const queryClient = new QueryClient();

function renderToolbar() {
  return render(
    <QueryClientProvider client={queryClient}>
      <GridProvider config={config} actions={actions} entities={entities}>
        <GridToolbar />
      </GridProvider>
    </QueryClientProvider>,
  );
}

async function addStatusFilter() {
  fireEvent.click(screen.getByRole('button', { name: 'sweep.entities.filter' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Status' }));
}

describe('GridToolbar filter on a select column', () => {
  it('goes straight to the configured statuses, including custom ones, instead of free text', async () => {
    renderToolbar();
    await addStatusFilter();

    // The value picker opens on its own, listing every configured status.
    const list = await screen.findByRole('listbox');
    expect(within(list).getByText('Active')).toBeInTheDocument();
    expect(within(list).getByText('Prospect')).toBeInTheDocument();
    expect(within(list).getByText('VIP')).toBeInTheDocument();
    expect(screen.queryByPlaceholderText('sweep.entities.enterValueEllipsis')).not.toBeInTheDocument();

    fireEvent.click(within(list).getByText('VIP'));
    // The pill reads "Status is VIP" (the label, not the stored key).
    expect(await screen.findByRole('button', { name: 'VIP' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'sweep.entities.operatorIs' })).toBeInTheDocument();
  });

  it('offers is / is not / is any of rather than contains / starts with', async () => {
    renderToolbar();
    await addStatusFilter();
    fireEvent.click(within(await screen.findByRole('listbox')).getByText('Active'));

    fireEvent.click(await screen.findByRole('button', { name: 'sweep.entities.operatorIs' }));
    expect(await screen.findByRole('button', { name: 'sweep.entities.operatorIsNot' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'sweep.entities.operatorIsAnyOf' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'sweep.entities.operatorContains' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'sweep.entities.operatorStartsWith' })).not.toBeInTheDocument();
  });

  it('lets several statuses be ticked with "is any of"', async () => {
    renderToolbar();
    await addStatusFilter();
    fireEvent.click(within(await screen.findByRole('listbox')).getByText('Active'));

    fireEvent.click(await screen.findByRole('button', { name: 'sweep.entities.operatorIs' }));
    fireEvent.click(await screen.findByRole('button', { name: 'sweep.entities.operatorIsAnyOf' }));

    // "Active" stays selected when the operator changes; add VIP too.
    const list = await screen.findByRole('listbox');
    fireEvent.click(within(list).getByText('VIP'));
    expect(await screen.findByRole('button', { name: 'Active, VIP' })).toBeInTheDocument();
  });
});
