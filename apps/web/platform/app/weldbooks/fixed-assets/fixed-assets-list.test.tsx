import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AssetFilters, FixedAssetListItem } from '@/lib/api/domains/weldbooks-assets';

const navigate = vi.fn();
const openPanel = vi.fn();
const permissions = new Set(['accounts:read', 'accounts:create', 'journal:create']);
let jurisdiction = 'US';
let assets: FixedAssetListItem[] = [];
let listState: { isLoading: boolean; isError: boolean } = { isLoading: false, isError: false };
const listFilters: AssetFilters[] = [];

vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, children }: { to: string; children: React.ReactNode }) => <a href={to}>{children}</a>,
  useNavigate: () => navigate,
}));
vi.mock('@/components/object-panel', () => ({
  useObjectPanel: () => ({ open: openPanel }),
  useObjectPanelUrlSync: vi.fn(),
}));
vi.mock('@weldsuite/permissions/react', () => ({
  usePermissions: () => ({ can: (permission: string) => permissions.has(permission) }),
}));
vi.mock('@/hooks/use-debounce', () => ({ useDebounce: <T,>(value: T) => value }));
vi.mock('@/lib/weldbooks/use-jurisdiction', () => ({
  useCurrentJurisdiction: () => ({ code: jurisdiction, isResolved: true, isError: false }),
}));
vi.mock('@/lib/weldbooks/use-weldbooks-format', () => ({
  useWeldbooksFormat: () => ({
    formatMoney: (value: number | string) => `$${Number(value).toFixed(2)}`,
    formatDate: (value: string) => value,
    today: () => '2026-03-10',
  }),
}));
vi.mock('@/hooks/queries/use-weldbooks-assets-queries', () => ({
  useFixedAssets: (filters: AssetFilters) => {
    listFilters.push(filters);
    return {
      data: listState.isLoading || listState.isError ? undefined : { data: assets, pagination: { totalCount: assets.length, hasMore: false, cursor: null } },
      isLoading: listState.isLoading,
      isError: listState.isError,
      refetch: vi.fn(),
    };
  },
}));

import FixedAssetsPage from './page';
import { polyfillRadixSelect, renderWithProviders } from './test-utils';

/** The list row (a `group` div of the standard list) of an asset, found by its click target. */
function rowOf(name: string): HTMLElement {
  const row = screen.getByRole('button', { name }).closest<HTMLElement>('div.group');
  if (!row) throw new Error(`No list row for ${name}`);
  return row;
}

/**
 * Adds a finished `is` filter pill through the toolbar: "Filter" > field > "is" > value.
 * The pill opens its value picker on a timer, and the focus returning to the operator
 * button can dismiss it again: when the options are not there, open the picker by hand.
 */
async function addIsFilter(user: ReturnType<typeof userEvent.setup>, field: string, value: string): Promise<void> {
  await user.click(screen.getByRole('button', { name: 'Filter' }));
  await user.click(await screen.findByRole('button', { name: field }));
  await user.click(await screen.findByRole('button', { name: 'is' }));
  const option = await screen.findByRole('button', { name: value }, { timeout: 400 }).catch(async () => {
    await user.click(screen.getByRole('button', { name: `Select ${field.toLowerCase()}` }));
    return screen.findByRole('button', { name: value });
  });
  await user.click(option);
}

const asset = (id: string, extra: Partial<FixedAssetListItem> = {}): FixedAssetListItem =>
  ({
    id,
    assetNumber: `FA-${id}`,
    name: `Asset ${id}`,
    assetClass: '5',
    placedInServiceDate: '2026-01-01',
    cost: '12000.00',
    status: 'active',
    books: [],
    accumulatedPosted: '2000.00',
    netBookValuePosted: '10000.00',
    ...extra,
  }) as FixedAssetListItem;

describe('Fixed assets register', () => {
  beforeAll(polyfillRadixSelect);
  beforeEach(() => {
    navigate.mockReset();
    openPanel.mockReset();
    listFilters.length = 0;
    jurisdiction = 'US';
    listState = { isLoading: false, isError: false };
    assets = [asset('1'), asset('2', { name: 'Old press', assetClass: null, status: 'disposed', cost: '3000.00', accumulatedPosted: '3000.00', netBookValuePosted: '0.00' })];
    permissions.clear();
    ['accounts:read', 'accounts:create', 'journal:create'].forEach((permission) => permissions.add(permission));
  });

  it('lists each asset with its cost, what is posted and its net book value', () => {
    renderWithProviders(<FixedAssetsPage />);

    const row = rowOf('Asset 1');
    expect(row).toHaveTextContent('FA-1');
    expect(row).toHaveTextContent('Asset 1');
    expect(row).toHaveTextContent('5-year property (vehicles, computers)');
    expect(row).toHaveTextContent('$12000.00');
    expect(row).toHaveTextContent('$2000.00');
    expect(row).toHaveTextContent('$10000.00');
    expect(row).toHaveTextContent('Active');
    expect(rowOf('Old press')).toHaveTextContent('Disposed');
  });

  it('opens an asset in the fixed asset record panel by clicking its row', async () => {
    const user = userEvent.setup();
    renderWithProviders(<FixedAssetsPage />);
    await user.click(screen.getByRole('button', { name: 'Asset 1' }));
    expect(openPanel).toHaveBeenCalledWith({ type: 'fixed_asset', id: '1' });
    expect(navigate).not.toHaveBeenCalled();
  });

  it('filters by status and passes it to the list', async () => {
    const user = userEvent.setup();
    renderWithProviders(<FixedAssetsPage />);
    await addIsFilter(user, 'Status', 'Disposed');
    expect(listFilters.at(-1)).toMatchObject({ status: 'disposed', limit: 25 });
  });

  it('filters by property class in the US', async () => {
    const user = userEvent.setup();
    renderWithProviders(<FixedAssetsPage />);
    await addIsFilter(user, 'Property class', '5-year property (vehicles, computers)');
    expect(listFilters.at(-1)).toMatchObject({ assetClass: '5' });
  });

  it('searches by name or number', async () => {
    const user = userEvent.setup();
    renderWithProviders(<FixedAssetsPage />);
    await user.type(screen.getAllByPlaceholderText('Search by name or number')[0], 'press');
    expect(listFilters.at(-1)).toMatchObject({ search: 'press' });
  });

  it('hides the property class and the tax report outside the US', async () => {
    const user = userEvent.setup();
    jurisdiction = 'NL';
    renderWithProviders(<FixedAssetsPage />);
    expect(screen.queryByText('Class')).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Tax depreciation' })).not.toBeInTheDocument();
    expect(rowOf('Asset 1')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Filter' }));
    expect(await screen.findByRole('button', { name: 'Status' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Property class' })).not.toBeInTheDocument();
  });

  it('offers the actions the user may take', async () => {
    const user = userEvent.setup();
    renderWithProviders(<FixedAssetsPage />);
    await user.click(screen.getByRole('button', { name: 'Add asset' }));
    expect(navigate).toHaveBeenCalledWith({ to: '/weldbooks/fixed-assets/new' });
    expect(screen.getByRole('link', { name: 'Run depreciation' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Tax depreciation' })).toBeInTheDocument();
  });

  it('hides add and run without the permissions', () => {
    permissions.delete('accounts:create');
    permissions.delete('journal:create');
    renderWithProviders(<FixedAssetsPage />);
    expect(screen.queryByRole('button', { name: 'Add asset' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Run depreciation' })).not.toBeInTheDocument();
  });

  it('invites the first asset when there are none', () => {
    assets = [];
    renderWithProviders(<FixedAssetsPage />);
    expect(screen.getByText('No fixed assets yet')).toBeInTheDocument();
    // One in the toolbar and one inviting the first asset.
    expect(screen.getAllByRole('button', { name: 'Add asset' })).toHaveLength(2);
  });

  it('says nothing matches when filters leave no assets', async () => {
    assets = [];
    const user = userEvent.setup();
    renderWithProviders(<FixedAssetsPage />);
    await user.type(screen.getAllByPlaceholderText('Search by name or number')[0], 'zzz');
    expect(screen.getByText('No assets match these filters.')).toBeInTheDocument();
  });

  it('shows an error with a retry when the list cannot be loaded', () => {
    listState = { isLoading: false, isError: true };
    renderWithProviders(<FixedAssetsPage />);
    expect(screen.getByRole('alert')).toHaveTextContent('The fixed assets could not be loaded.');
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });
});
