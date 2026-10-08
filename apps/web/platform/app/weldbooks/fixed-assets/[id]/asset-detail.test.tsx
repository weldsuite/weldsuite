import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { FixedAssetDetail } from '@/lib/api/domains/weldbooks-assets';

const navigate = vi.fn();
const deleteAsync = vi.fn();
const permissions = new Set(['accounts:read', 'accounts:update', 'accounts:delete', 'journal:create']);
let asset: FixedAssetDetail | undefined;

vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, children }: { to: string; children: React.ReactNode }) => <a href={to}>{children}</a>,
  useNavigate: () => navigate,
  useParams: () => ({ id: 'fa_1' }),
}));
vi.mock('@weldsuite/permissions/react', () => ({
  usePermissions: () => ({ can: (permission: string) => permissions.has(permission) }),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/weldbooks/use-weldbooks-format', () => ({
  useWeldbooksFormat: () => ({
    formatMoney: (value: number | string) => `$${Number(value).toFixed(2)}`,
    formatDate: (value: string | null) => value ?? '',
    formatDateTime: (value: string) => value,
    today: () => '2026-04-15',
  }),
}));
vi.mock('@/hooks/queries/use-accounting-queries', () => ({
  useAccountingAccounts: () => ({
    data: {
      data: [
        { id: 'acc_fa', code: '1500', name: 'Equipment', type: 'asset', isActive: true },
        { id: 'acc_ad', code: '1590', name: 'Accumulated depreciation', type: 'asset', isActive: true },
        { id: 'acc_de', code: '6500', name: 'Depreciation expense', type: 'expense', isActive: true },
      ],
    },
  }),
}));
vi.mock('@/hooks/queries/use-weldbooks-assets-queries', () => ({
  useFixedAsset: () => ({ data: asset, isLoading: false, isError: false, refetch: vi.fn() }),
  useDeleteFixedAsset: () => ({ mutateAsync: deleteAsync, isPending: false }),
  useDisposeFixedAsset: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

import FixedAssetDetailPage from './page';
import { polyfillRadixSelect, renderWithProviders } from '../test-utils';

const basis = { cost: 12000, businessUsePercent: 100, baseCost: 12000, salvage: 0, section179: 0, bonus: 0, depreciableBasis: 12000, totalDepreciable: 12000 };

const detail = (overrides: Partial<FixedAssetDetail> = {}): FixedAssetDetail =>
  ({
    id: 'fa_1',
    entityId: 'ent_1',
    assetNumber: 'FA-1',
    name: 'Forklift',
    description: 'Warehouse forklift',
    assetClass: '7',
    assetAccountId: 'acc_fa',
    accumulatedDepreciationAccountId: 'acc_ad',
    depreciationExpenseAccountId: 'acc_de',
    acquisitionDate: '2026-01-01',
    placedInServiceDate: '2026-01-01',
    cost: '12000.00',
    salvageValue: '0.00',
    businessUsePercent: '100.0000',
    billId: null,
    billItemId: null,
    status: 'active',
    disposalDate: null,
    disposalProceeds: null,
    disposalJournalEntryId: null,
    classId: null,
    locationId: null,
    notes: null,
    books: [
      {
        id: 'fab_1',
        assetId: 'fa_1',
        book: 'book',
        stateCode: null,
        method: 'straight_line',
        convention: 'full_month',
        recoveryYears: '7.0',
        section179Amount: '0.00',
        bonusPercent: '0.0000',
        depreciableBasis: '12000.00',
        postsToLedger: true,
        schedule: {
          method: 'straight_line',
          convention: 'full_month',
          recoveryYears: 7,
          basis,
          annual: [
            { label: '2026', periodStart: '2026-01-01', periodEnd: '2026-12-31', amount: 1714.29, regular: 1714.29, section179: 0, bonus: 0, accumulated: 1714.29, remaining: 10285.71 },
          ],
          issues: [],
        },
      },
      {
        id: 'fab_2',
        assetId: 'fa_1',
        book: 'federal',
        stateCode: null,
        method: 'macrs_gds',
        convention: 'half_year',
        recoveryYears: '7.0',
        section179Amount: '2500.00',
        bonusPercent: '100.0000',
        depreciableBasis: '0.00',
        postsToLedger: false,
        schedule: {
          method: 'macrs_gds',
          convention: 'half_year',
          recoveryYears: 7,
          basis: { ...basis, section179: 2500, bonus: 9500, depreciableBasis: 0, totalDepreciable: 12000 },
          annual: [
            { label: '2026', periodStart: '2026-01-01', periodEnd: '2026-12-31', amount: 12000, regular: 0, section179: 2500, bonus: 9500, accumulated: 12000, remaining: 0 },
          ],
          issues: [],
        },
      },
    ],
    ledgerRows: [
      { id: 'fad_1', assetId: 'fa_1', bookId: 'fab_1', periodStart: '2026-01-01', periodEnd: '2026-01-31', amount: '142.86', accumulated: '142.86', journalEntryId: null },
      { id: 'fad_2', assetId: 'fa_1', bookId: 'fab_1', periodStart: '2026-02-01', periodEnd: '2026-02-28', amount: '142.86', accumulated: '285.72', journalEntryId: null },
    ],
    accumulatedPosted: '0.00',
    netBookValuePosted: '12000.00',
    issues: [],
    ...overrides,
  }) as FixedAssetDetail;

describe('Fixed asset detail page', () => {
  beforeAll(polyfillRadixSelect);
  beforeEach(() => {
    navigate.mockReset();
    deleteAsync.mockReset().mockResolvedValue(undefined);
    permissions.clear();
    ['accounts:read', 'accounts:update', 'accounts:delete', 'journal:create'].forEach((permission) => permissions.add(permission));
    asset = detail();
  });

  it('shows the cost, what is posted and the net book value', () => {
    renderWithProviders(<FixedAssetDetailPage />);
    expect(screen.getByRole('heading', { name: 'Forklift' })).toBeInTheDocument();
    expect(screen.getByText('No. FA-1')).toBeInTheDocument();
    expect(screen.getByText('Net book value (posted)').nextElementSibling).toHaveTextContent('$12000.00');
    expect(screen.getByText('Cost').nextElementSibling).toHaveTextContent('$12000.00');
    expect(screen.getByText('1500 — Equipment')).toBeInTheDocument();
    expect(screen.getByText('7-year property (furniture, machinery)')).toBeInTheDocument();
  });

  it('opens on the ledger book with its yearly schedule and its monthly postings', () => {
    renderWithProviders(<FixedAssetDetailPage />);
    const annual = screen.getByTestId('annual-schedule');
    expect(annual).toHaveTextContent('2026');
    expect(annual).toHaveTextContent('$1714.29');
    // No section 179 or bonus column on a book that takes none.
    expect(within(annual).queryByRole('columnheader', { name: 'Bonus' })).not.toBeInTheDocument();

    const ledger = screen.getByTestId('ledger-postings');
    expect(ledger).toHaveTextContent('0 of 2 periods posted');
    expect(within(ledger).getAllByText('Scheduled')).toHaveLength(2);
  });

  it('shows the section 179 and bonus of the federal book on its own tab', async () => {
    const user = userEvent.setup();
    renderWithProviders(<FixedAssetDetailPage />);
    await user.click(screen.getByRole('tab', { name: 'Federal tax' }));

    const annual = await screen.findByTestId('annual-schedule');
    expect(within(annual).getByRole('columnheader', { name: 'Section 179' })).toBeInTheDocument();
    expect(within(annual).getByRole('columnheader', { name: 'Bonus' })).toBeInTheDocument();
    expect(annual).toHaveTextContent('$9500.00');
    expect(screen.getByText('Computed for the tax return, posts nothing')).toBeInTheDocument();
    // Tax books post nothing, so no ledger postings are listed.
    expect(screen.queryByTestId('ledger-postings')).not.toBeInTheDocument();
  });

  it('links posted periods to their journal entry and locks the asset', () => {
    asset = detail({
      accumulatedPosted: '142.86',
      netBookValuePosted: '11857.14',
      ledgerRows: [
        { id: 'fad_1', assetId: 'fa_1', bookId: 'fab_1', periodStart: '2026-01-01', periodEnd: '2026-01-31', amount: '142.86', accumulated: '142.86', journalEntryId: 'je_1' },
        { id: 'fad_2', assetId: 'fa_1', bookId: 'fab_1', periodStart: '2026-02-01', periodEnd: '2026-02-28', amount: '142.86', accumulated: '285.72', journalEntryId: null },
      ],
    });
    renderWithProviders(<FixedAssetDetailPage />);

    const ledger = screen.getByTestId('ledger-postings');
    expect(ledger).toHaveTextContent('1 of 2 periods posted');
    expect(within(ledger).getByText('Posted')).toBeInTheDocument();
    expect(within(ledger).getByRole('link', { name: 'View' })).toHaveAttribute('href', '/weldbooks/journal/$id');
    expect(screen.getByTestId('asset-locked')).toBeInTheDocument();
    // A posted asset cannot be deleted; it is disposed of instead.
    expect(screen.getByRole('button', { name: 'Delete' })).toBeDisabled();
  });

  it('deletes an asset nothing is posted for, after confirming', async () => {
    const user = userEvent.setup();
    renderWithProviders(<FixedAssetDetailPage />);

    await user.click(screen.getByRole('button', { name: 'Delete' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Delete Forklift?')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Delete asset' }));

    await vi.waitFor(() => expect(deleteAsync).toHaveBeenCalledWith('fa_1'));
    await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith({ to: '/weldbooks/fixed-assets' }));
  });

  it('opens the disposal dialog', async () => {
    const user = userEvent.setup();
    renderWithProviders(<FixedAssetDetailPage />);
    await user.click(screen.getByTestId('dispose-open'));
    expect(await screen.findByText('Dispose of Forklift')).toBeInTheDocument();
    expect(screen.getByTestId('dispose-preview')).toBeInTheDocument();
  });

  it('shows the disposal of a disposed asset and offers no more changes to it', () => {
    asset = detail({ status: 'disposed', disposalDate: '2026-04-15', disposalProceeds: '9000.00', disposalJournalEntryId: 'je_9' });
    renderWithProviders(<FixedAssetDetailPage />);

    const disposal = screen.getByTestId('disposal-card');
    expect(disposal).toHaveTextContent('2026-04-15');
    expect(disposal).toHaveTextContent('$9000.00');
    expect(within(disposal).getByRole('link', { name: 'View journal entry' })).toBeInTheDocument();
    expect(screen.queryByTestId('dispose-open')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();
  });

  it('explains the notes the rules left on the depreciation in plain language', () => {
    asset = detail({ issues: [{ book: 'federal', stateCode: null, severity: 'warning', code: 'ads_required', message: 'English from the server' }] });
    renderWithProviders(<FixedAssetDetailPage />);
    expect(screen.getByTestId('asset-issues')).toHaveTextContent('Federal tax: Listed property used 50% or less for business must use ADS');
  });

  it('hides edit, dispose and delete without the permissions', () => {
    permissions.clear();
    permissions.add('accounts:read');
    renderWithProviders(<FixedAssetDetailPage />);
    expect(screen.queryByRole('link', { name: 'Edit' })).not.toBeInTheDocument();
    expect(screen.queryByTestId('dispose-open')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();
  });

  it('says so when the asset does not exist', () => {
    asset = undefined;
    renderWithProviders(<FixedAssetDetailPage />);
    expect(screen.getByText('This asset does not exist or was deleted.')).toBeInTheDocument();
  });
});
