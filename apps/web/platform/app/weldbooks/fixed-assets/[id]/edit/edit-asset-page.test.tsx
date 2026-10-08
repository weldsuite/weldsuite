import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { FixedAssetDetail } from '@/lib/api/domains/weldbooks-assets';

const navigate = vi.fn();
const updateAsync = vi.fn();
const permissions = new Set(['accounts:update']);
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
vi.mock('@/lib/weldbooks/use-jurisdiction', () => ({
  useCurrentJurisdiction: () => ({ code: 'US', isResolved: true, isError: false }),
}));
vi.mock('@/lib/weldbooks/use-weldbooks-format', () => ({
  useWeldbooksFormat: () => ({ formatMoney: (value: number | string) => `$${Number(value).toFixed(2)}`, formatDate: (value: string) => value, today: () => '2026-04-15' }),
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
  useDimensionValues: () => ({ data: [] }),
}));
vi.mock('@/hooks/queries/use-weldbooks-assets-queries', () => ({
  useFixedAsset: () => ({ data: asset, isLoading: false, isError: false }),
  useUpdateFixedAsset: () => ({ mutateAsync: updateAsync, isPending: false }),
  useDeMinimisAdvice: () => ({ data: undefined, isLoading: false, isError: false }),
}));

import EditFixedAssetPage from './page';
import { polyfillRadixSelect, renderWithProviders } from '../../test-utils';

const book = (kind: 'book' | 'federal', extra: Record<string, unknown> = {}) => ({
  id: `fab_${kind}`,
  assetId: 'fa_1',
  book: kind,
  stateCode: null,
  method: kind === 'book' ? 'straight_line' : 'macrs_gds',
  convention: kind === 'book' ? 'full_month' : 'half_year',
  recoveryYears: '7.0',
  section179Amount: '0.00',
  bonusPercent: kind === 'federal' ? '100.0000' : '0.0000',
  depreciableBasis: '0.00',
  postsToLedger: kind === 'book',
  schedule: { method: 'straight_line', convention: 'full_month', recoveryYears: 7, basis: {}, annual: [], issues: [] },
  ...extra,
});

const detail = (overrides: Partial<FixedAssetDetail> = {}): FixedAssetDetail =>
  ({
    id: 'fa_1',
    assetNumber: 'FA-1',
    name: 'Forklift',
    description: null,
    assetClass: '7',
    assetAccountId: 'acc_fa',
    accumulatedDepreciationAccountId: 'acc_ad',
    depreciationExpenseAccountId: 'acc_de',
    acquisitionDate: '2026-01-01',
    placedInServiceDate: '2026-01-01',
    cost: '12000.00',
    salvageValue: '0.00',
    businessUsePercent: '100.0000',
    status: 'active',
    classId: null,
    locationId: null,
    notes: null,
    books: [book('book'), book('federal')],
    ledgerRows: [],
    accumulatedPosted: '0.00',
    netBookValuePosted: '12000.00',
    issues: [],
    ...overrides,
  }) as unknown as FixedAssetDetail;

describe('Edit fixed asset page', () => {
  beforeAll(polyfillRadixSelect);
  beforeEach(() => {
    navigate.mockReset();
    updateAsync.mockReset().mockResolvedValue({});
    permissions.clear();
    permissions.add('accounts:update');
    asset = detail();
  });

  it('is filled from the stored asset and sends only what changed', async () => {
    const user = userEvent.setup();
    renderWithProviders(<EditFixedAssetPage />);

    expect(screen.getByLabelText('Name')).toHaveValue('Forklift');
    expect(screen.getByLabelText('Cost')).toHaveValue('12000');
    await user.clear(screen.getByLabelText('Cost'));
    await user.type(screen.getByLabelText('Cost'), '12500');
    await user.type(screen.getByLabelText('Notes'), 'New mast');
    await user.click(screen.getByTestId('asset-submit'));

    await waitFor(() => expect(updateAsync).toHaveBeenCalledTimes(1));
    expect(updateAsync).toHaveBeenCalledWith({ id: 'fa_1', input: { cost: 12500, notes: 'New mast' } });
    expect(navigate).toHaveBeenCalledWith({ to: '/weldbooks/fixed-assets/$id', params: { id: 'fa_1' } });
  });

  it('sends nothing when nothing changed', async () => {
    const user = userEvent.setup();
    renderWithProviders(<EditFixedAssetPage />);
    await user.click(screen.getByTestId('asset-submit'));
    await waitFor(() => expect(navigate).toHaveBeenCalled());
    expect(updateAsync).not.toHaveBeenCalled();
  });

  it('freezes the cost, dates, accounts and books once depreciation is posted, but still renames', async () => {
    asset = detail({
      accumulatedPosted: '142.86',
      ledgerRows: [{ id: 'fad_1', assetId: 'fa_1', bookId: 'fab_book', periodStart: '2026-01-01', periodEnd: '2026-01-31', amount: '142.86', accumulated: '142.86', journalEntryId: 'je_1' }],
    } as Partial<FixedAssetDetail>);
    const user = userEvent.setup();
    renderWithProviders(<EditFixedAssetPage />);

    expect(screen.getByTestId('edit-locked')).toHaveTextContent('Depreciation has been posted');
    expect(screen.getByLabelText('Cost')).toBeDisabled();
    expect(screen.getByLabelText('Acquisition date')).toBeDisabled();
    expect(screen.getByLabelText('Name')).toBeEnabled();
    expect(screen.getByLabelText('Notes')).toBeEnabled();

    await user.type(screen.getByLabelText('Name'), ' II');
    await user.click(screen.getByTestId('asset-submit'));
    await waitFor(() => expect(updateAsync).toHaveBeenCalledWith({ id: 'fa_1', input: { name: 'Forklift II' } }));
  });

  it('shows the server’s refusal and stays on the form', async () => {
    updateAsync.mockRejectedValueOnce(new Error('Depreciation has been posted for this asset'));
    const user = userEvent.setup();
    renderWithProviders(<EditFixedAssetPage />);
    await user.clear(screen.getByLabelText('Cost'));
    await user.type(screen.getByLabelText('Cost'), '1');
    await user.click(screen.getByTestId('asset-submit'));
    expect(await screen.findByTestId('asset-submit-error')).toHaveTextContent('Depreciation has been posted for this asset');
    expect(navigate).not.toHaveBeenCalled();
  });

  it('lists the books being edited, with the federal bonus as stored', () => {
    renderWithProviders(<EditFixedAssetPage />);
    const editor = screen.getByTestId('books-editor');
    expect(editor).toHaveTextContent('Book (GAAP)');
    expect(editor).toHaveTextContent('Federal tax');
    expect(screen.getByLabelText('Bonus %')).toHaveValue('100');
  });

  it('is closed without accounts:update', () => {
    permissions.clear();
    renderWithProviders(<EditFixedAssetPage />);
    expect(screen.getByText('You do not have access to this screen.')).toBeInTheDocument();
  });

  it('says so when the asset does not exist', () => {
    asset = undefined;
    renderWithProviders(<EditFixedAssetPage />);
    expect(screen.getByText('This asset does not exist or was deleted.')).toBeInTheDocument();
  });
});
