import { describe, it, expect, vi, beforeAll } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { EntityGridActions, EntityGridConfig, GridColumnDef } from '../types';
import { GridProvider, useGridContext } from '../context';
import { AddColumnMenu } from './add-column-menu';

vi.mock('@weldsuite/i18n/client', () => ({
  useTranslations: () => (key: string) => key,
}));
vi.mock('@/lib/api/use-app-api', () => {
  const getClient = () => Promise.resolve({ put: vi.fn().mockResolvedValue({}) });
  return { useAppApiClient: () => ({ getClient }) };
});
vi.mock('@/hooks/queries/use-settings-queries', () => ({
  gridViewQueryKey: (gridName: string) => ['settings', 'grid-view', gridName],
}));

beforeAll(() => {
  // cmdk needs these; jsdom has neither.
  class RO {
    observe() { /* no-op */ }
    unobserve() { /* no-op */ }
    disconnect() { /* no-op */ }
  }
  (globalThis as unknown as { ResizeObserver: typeof RO }).ResizeObserver = RO;
  Element.prototype.scrollIntoView = () => {};
});

interface Row {
  id: string;
}

const col = (id: string, extra: Partial<GridColumnDef<Row>> = {}): GridColumnDef<Row> => ({
  id,
  name: id,
  type: 'text',
  width: 150,
  visible: false,
  getValue: () => '',
  ...extra,
});

function Visible() {
  const { getVisibleColumns } = useGridContext<Row>();
  return <span data-testid="visible">{getVisibleColumns().map((c) => c.id).join(',')}</span>;
}

function setup(overrides: Partial<EntityGridConfig<Row>> = {}) {
  const onClose = vi.fn();
  const config: EntityGridConfig<Row> = {
    entityName: 'Company',
    entityNamePlural: 'Companies',
    columns: [
      col('name', { visible: true }),
      col('team', { name: 'Team' }),
      col('team.email', { name: 'Team email addresses', menuParentId: 'team' }),
      col('team.phone', { name: 'Team phone numbers', menuParentId: 'team' }),
      col('location', { name: 'Primary location', visible: true }),
      col('location.city', { name: 'City', menuParentId: 'location' }),
      col('createdAt', { name: 'Created at' }),
    ],
    getEntityId: (r) => r.id,
    getEntityName: (r) => r.id,
    ...overrides,
  };
  const actions: EntityGridActions<Row> = {
    onUpdateEntity: () => Promise.resolve({ success: true }),
    onDeleteEntity: () => Promise.resolve({ success: true }),
  };
  render(
    <QueryClientProvider client={new QueryClient()}>
      <GridProvider config={config} actions={actions} entities={[]}>
        <AddColumnMenu onClose={onClose} />
        <Visible />
      </GridProvider>
    </QueryClientProvider>,
  );
  return { onClose };
}

const options = () => screen.getAllByRole('option').map((o) => o.textContent);

describe('AddColumnMenu', () => {
  it('lists hidden columns and parents with addable sub-attributes, with their count, but not the sub-attributes', () => {
    setup();
    // Primary location is showing, but its City can still be added.
    expect(options()).toEqual(['Team2', 'Primary location1', 'Created at']);
  });

  it('adds a column when its row is picked', () => {
    const { onClose } = setup();
    fireEvent.click(screen.getByText('Created at'));
    expect(screen.getByTestId('visible').textContent).toBe('name,location,createdAt');
    expect(onClose).toHaveBeenCalled();
  });

  it('drills into the sub-attributes from the count, and back', () => {
    setup();
    const team = screen.getAllByRole('option').find((o) => o.textContent?.startsWith('Team'))!;
    fireEvent.click(within(team).getByText('2'));
    expect(options()).toEqual(['Team', 'Team email addresses', 'Team phone numbers']);

    fireEvent.click(screen.getByText('Team email addresses'));
    expect(screen.getByTestId('visible').textContent).toBe('name,team.email,location');
  });

  it('drills in on picking a parent that is already showing', () => {
    setup();
    fireEvent.click(screen.getByText('Primary location'));
    expect(options()).toEqual(['Primary location', 'City']);
    fireEvent.click(screen.getAllByRole('option')[0]); // back
    expect(options()).toEqual(['Team2', 'Primary location1', 'Created at']);
  });

  it('pins "Create new attribute" below the list; it asks the page to open its create dialog', () => {
    const onCreateAttribute = vi.fn();
    const { onClose } = setup({ onCreateAttribute });
    const create = screen.getByRole('button', { name: /createNewAttribute/ });
    expect(screen.getByRole('listbox').contains(create)).toBe(false);

    fireEvent.click(create);
    expect(onCreateAttribute).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalled();
  });
});
