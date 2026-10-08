import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AssetFilters, FixedAssetListItem } from '@/lib/api/domains/weldbooks-assets';

const navigate = vi.fn();
const permissions = new Set(['accounts:read', 'accounts:create', 'journal:create']);
let jurisdiction = 'US';
let assets: FixedAssetListItem[] = [];
let listState: { isLoading: boolean; isError: boolean } = { isLoading: false, isError: false };
const listFilters: AssetFilters[] = [];

vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, children }: { to: string; children: React.ReactNode }) => <a href={to}>{children}</a>,
  useNavigate: () => navigate,
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
  useFixedAssetRegister: () => ({
    data: {
      asOf: '2026-03-10',
      totals: { cost: 15000, accumulatedDepreciation: 2500, netBookValue: 12500 },
      lines: [{ disposed: false }, { disposed: false }, { disposed: true }],
    },
  }),
}));

import FixedAssetsPage from './page';
import { polyfillRadixSelect, renderWithProviders } from './test-utils';

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
    listFilters.length = 0;
    jurisdiction = 'US';
    listState = { isLoading: false, isError: false };
    assets = [asset('1'), asset('2', { name: 'Old press', assetClass: null, status: 'disposed', cost: '3000.00', accumulatedPosted: '3000.00', netBookValuePosted: '0.00' })];
    permissions.clear();
    ['accounts:read', 'accounts:create', 'journal:create'].forEach((permission) => permissions.add(permission));
  });

  it('lists each asset with its cost, what is posted and its net book value', () => {
    renderWithProviders(<FixedAssetsPage />);

    const row = screen.getByTestId('asset-row-1');
    expect(row).toHaveTextContent('Asset 1');
    expect(row).toHaveTextContent('5-year property (vehicles, computers)');
    expect(row).toHaveTextContent('$12000.00');
    expect(row).toHaveTextContent('$2000.00');
    expect(row).toHaveTextContent('$10000.00');
    expect(row).toHaveTextContent('Active');
    expect(screen.getByTestId('asset-row-2')).toHaveTextContent('Disposed');
    expect(screen.getByText('2 assets')).toBeInTheDocument();
  });

  it('shows the register totals as of today, without the disposed assets', () => {
    renderWithProviders(<FixedAssetsPage />);
    const summary = screen.getByTestId('register-summary');
    expect(summary).toHaveTextContent('Register as of 2026-03-10');
    expect(summary).toHaveTextContent('$15000.00');
    expect(summary).toHaveTextContent('$12500.00');
    expect(within(summary).getByText('Assets').nextElementSibling).toHaveTextContent('2');
  });

  it('opens an asset by clicking its row', async () => {
    const user = userEvent.setup();
    renderWithProviders(<FixedAssetsPage />);
    await user.click(screen.getByTestId('asset-row-1'));
    expect(navigate).toHaveBeenCalledWith({ to: '/weldbooks/fixed-assets/$id', params: { id: '1' } });
  });

  it('filters by status and passes it to the list', async () => {
    const user = userEvent.setup();
    renderWithProviders(<FixedAssetsPage />);
    await user.click(screen.getByRole('combobox', { name: 'Status' }));
    await user.click(await screen.findByRole('option', { name: 'Disposed' }));
    expect(listFilters.at(-1)).toMatchObject({ status: 'disposed', limit: 25 });
  });

  it('searches by name or number', async () => {
    const user = userEvent.setup();
    renderWithProviders(<FixedAssetsPage />);
    await user.type(screen.getByLabelText('Search assets'), 'press');
    expect(listFilters.at(-1)).toMatchObject({ search: 'press' });
  });

  it('hides the property class and the tax report outside the US', () => {
    jurisdiction = 'NL';
    renderWithProviders(<FixedAssetsPage />);
    expect(screen.queryByRole('columnheader', { name: 'Class' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Tax depreciation' })).not.toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'Property class' })).not.toBeInTheDocument();
    expect(screen.getByTestId('asset-row-1')).toBeInTheDocument();
  });

  it('offers the actions the user may take', () => {
    renderWithProviders(<FixedAssetsPage />);
    expect(screen.getByRole('link', { name: 'Add asset' })).toHaveAttribute('href', '/weldbooks/fixed-assets/new');
    expect(screen.getByRole('link', { name: 'Run depreciation' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Tax depreciation' })).toBeInTheDocument();
  });

  it('hides add and run without the permissions', () => {
    permissions.delete('accounts:create');
    permissions.delete('journal:create');
    renderWithProviders(<FixedAssetsPage />);
    expect(screen.queryByRole('link', { name: 'Add asset' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Run depreciation' })).not.toBeInTheDocument();
  });

  it('invites the first asset when there are none', () => {
    assets = [];
    renderWithProviders(<FixedAssetsPage />);
    expect(screen.getByText('No fixed assets yet')).toBeInTheDocument();
    // One in the header and one inviting the first asset.
    expect(screen.getAllByRole('link', { name: 'Add asset' })).toHaveLength(2);
  });

  it('says nothing matches when filters leave no assets', async () => {
    assets = [];
    const user = userEvent.setup();
    renderWithProviders(<FixedAssetsPage />);
    await user.type(screen.getByLabelText('Search assets'), 'zzz');
    expect(screen.getByText('No assets match these filters.')).toBeInTheDocument();
  });

  it('shows an error with a retry when the list cannot be loaded', () => {
    listState = { isLoading: false, isError: true };
    renderWithProviders(<FixedAssetsPage />);
    expect(screen.getByRole('alert')).toHaveTextContent('The fixed assets could not be loaded.');
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });
});
