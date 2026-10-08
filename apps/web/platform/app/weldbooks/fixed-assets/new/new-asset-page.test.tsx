import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const createAsset = vi.fn();
const createFromBill = vi.fn();
const navigate = vi.fn();
const permissions = new Set(['accounts:create']);
let search: Record<string, string> = {};
let jurisdiction = 'US';

vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, children }: { to: string; children: React.ReactNode }) => <a href={to}>{children}</a>,
  useNavigate: () => navigate,
  useSearch: () => search,
}));
vi.mock('@weldsuite/permissions/react', () => ({
  usePermissions: () => ({ can: (permission: string) => permissions.has(permission) }),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), warning: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/weldbooks/use-jurisdiction', () => ({
  useCurrentJurisdiction: () => ({ code: jurisdiction, isResolved: true, isError: false }),
}));
vi.mock('@/lib/weldbooks/use-weldbooks-format', () => ({
  useWeldbooksFormat: () => ({
    formatMoney: (value: number | string) => `$${Number(value).toFixed(2)}`,
    formatDate: (value: string) => value,
    today: () => '2026-01-20',
  }),
}));
vi.mock('@/hooks/use-debounce', () => ({ useDebounce: <T,>(value: T) => value }));
vi.mock('@/hooks/queries/use-accounting-queries', () => ({
  useAccountingAccounts: () => ({
    data: {
      data: [
        { id: 'acc_fa', code: '1500', name: 'Equipment', type: 'asset', subtype: 'fixed_asset', isActive: true },
        { id: 'acc_ad', code: '1590', name: 'Accumulated depreciation', type: 'asset', subtype: null, isActive: true },
        { id: 'acc_de', code: '6500', name: 'Depreciation expense', type: 'expense', subtype: null, isActive: true },
        { id: 'acc_exp', code: '6100', name: 'Equipment expense', type: 'expense', subtype: null, isActive: true },
      ],
    },
  }),
  useDimensionValues: () => ({ data: [] }),
  useAccountingBill: () => ({
    data: {
      data: {
        id: 'bill_1',
        billNumber: 'B-100',
        currency: 'USD',
        issueDate: '2026-01-05',
        items: [{ id: 'bi_1', description: 'Forklift', lineTotal: '12000.00', lineTotalWithTax: '12500.00', accountId: 'acc_exp' }],
      },
    },
  }),
}));
vi.mock('@/hooks/queries/use-weldbooks-assets-queries', () => ({
  useCreateFixedAsset: () => ({ mutateAsync: createAsset, isPending: false }),
  useCreateFixedAssetFromBillLine: () => ({ mutateAsync: createFromBill, isPending: false }),
  useDeMinimisAdvice: () => ({
    data: { amount: 12500, date: '2026-01-20', hasAfs: false, threshold: 2500, applies: false, advice: 'capitalize', explanation: 'English' },
    isLoading: false,
    isError: false,
  }),
}));

import NewFixedAssetPage from './page';
import { polyfillRadixSelect, renderWithProviders } from '../test-utils';

const result = (id: string) => ({ id, issues: [], books: [] });

describe('New fixed asset page', () => {
  beforeAll(polyfillRadixSelect);
  beforeEach(() => {
    createAsset.mockReset().mockResolvedValue(result('fa_9'));
    createFromBill.mockReset().mockResolvedValue({ ...result('fa_10'), source: { reclassNeeded: false, reclassJournalEntryId: null } });
    navigate.mockReset();
    permissions.clear();
    permissions.add('accounts:create');
    search = {};
    jurisdiction = 'US';
  });

  it('posts only the required facts when everything else is left blank', async () => {
    const user = userEvent.setup();
    renderWithProviders(<NewFixedAssetPage />);

    await user.type(screen.getByLabelText('Name'), 'Forklift');
    await user.type(screen.getByLabelText('Cost'), '12500');
    await user.click(screen.getByTestId('asset-submit'));

    await waitFor(() => expect(createAsset).toHaveBeenCalledTimes(1));
    // The acquisition date starts on today; every default is left to the server.
    expect(createAsset).toHaveBeenCalledWith({ name: 'Forklift', acquisitionDate: '2026-01-20', cost: 12500 });
    expect(navigate).toHaveBeenCalledWith({ to: '/weldbooks/fixed-assets/$id', params: { id: 'fa_9' } });
  });

  it('posts the overrides that were typed', async () => {
    const user = userEvent.setup();
    renderWithProviders(<NewFixedAssetPage />);

    await user.type(screen.getByLabelText('Name'), 'Forklift');
    await user.type(screen.getByLabelText('Asset number'), 'FA-7');
    await user.type(screen.getByLabelText('Cost'), '12500');
    await user.type(screen.getByLabelText('Salvage value'), '500');
    await user.type(screen.getByLabelText('Useful life (years)'), '8');
    await user.type(screen.getByLabelText('Business use %'), '75');
    await user.type(screen.getByLabelText('Section 179 expense'), '2500');
    await user.click(screen.getByTestId('asset-submit'));

    await waitFor(() => expect(createAsset).toHaveBeenCalledTimes(1));
    expect(createAsset).toHaveBeenCalledWith({
      name: 'Forklift',
      assetNumber: 'FA-7',
      acquisitionDate: '2026-01-20',
      cost: 12500,
      salvageValue: 500,
      usefulLifeYears: 8,
      businessUsePercent: 75,
      section179Amount: 2500,
    });
  });

  it('explains what is missing and does not post an empty form', async () => {
    const user = userEvent.setup();
    renderWithProviders(<NewFixedAssetPage />);

    await user.click(screen.getByTestId('asset-submit'));

    expect(await screen.findByText('Enter a name for the asset.')).toBeInTheDocument();
    expect(createAsset).not.toHaveBeenCalled();
  });

  it('previews the books the server will create, following the property class', async () => {
    const user = userEvent.setup();
    renderWithProviders(<NewFixedAssetPage />);

    const preview = screen.getByTestId('book-defaults-preview');
    expect(within(preview).getByTestId('default-book-book')).toHaveTextContent('Straight line · Full month · 5 years');
    expect(within(preview).queryByTestId('default-book-federal')).not.toBeInTheDocument();

    await user.click(screen.getByRole('combobox', { name: 'Property class' }));
    await user.click(await screen.findByRole('option', { name: '7-year property (furniture, machinery)' }));

    const federal = await screen.findByTestId('default-book-federal');
    expect(federal).toHaveTextContent('MACRS (GDS) · Half-year · 7 years');
    expect(federal).toHaveTextContent('Bonus 100%');
    expect(screen.getByTestId('default-book-book')).toHaveTextContent('7 years');
  });

  it('advises whether to expense or capitalize once the cost is known', async () => {
    const user = userEvent.setup();
    renderWithProviders(<NewFixedAssetPage />);

    expect(screen.queryByTestId('de-minimis-advice')).not.toBeInTheDocument();
    await user.type(screen.getByLabelText('Cost'), '12500');
    expect(await screen.findByTestId('de-minimis-verdict')).toHaveTextContent('Capitalize and depreciate');
  });

  it('shows no tax fields for an entity outside the US', () => {
    jurisdiction = 'NL';
    renderWithProviders(<NewFixedAssetPage />);

    expect(screen.queryByLabelText('Property class')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Section 179 expense')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Business use %')).not.toBeInTheDocument();
    expect(screen.queryByTestId('de-minimis-advice')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Useful life (years)')).toBeInTheDocument();
  });

  it('shows the error the server answered with', async () => {
    createAsset.mockRejectedValueOnce(new Error('Asset number FA-7 is already in use'));
    const user = userEvent.setup();
    renderWithProviders(<NewFixedAssetPage />);

    await user.type(screen.getByLabelText('Name'), 'Forklift');
    await user.type(screen.getByLabelText('Cost'), '100');
    await user.click(screen.getByTestId('asset-submit'));

    expect(await screen.findByTestId('asset-submit-error')).toHaveTextContent('Asset number FA-7 is already in use');
    expect(navigate).not.toHaveBeenCalled();
  });

  it('is closed to someone without accounts:create', () => {
    permissions.clear();
    renderWithProviders(<NewFixedAssetPage />);
    expect(screen.getByText('You do not have access to this screen.')).toBeInTheDocument();
    expect(screen.queryByTestId('asset-form')).not.toBeInTheDocument();
  });

  describe('from a bill line', () => {
    beforeEach(() => {
      search = { billItemId: 'bi_1', billId: 'bill_1' };
    });

    it('creates the asset from the line with the cost and name left to it', async () => {
      const user = userEvent.setup();
      renderWithProviders(<NewFixedAssetPage />);

      expect(screen.getByTestId('bill-line-card')).toHaveTextContent('Forklift');
      await user.click(screen.getByRole('combobox', { name: 'Property class' }));
      await user.click(await screen.findByRole('option', { name: '7-year property (furniture, machinery)' }));
      await user.click(screen.getByTestId('asset-submit'));

      await waitFor(() => expect(createFromBill).toHaveBeenCalledTimes(1));
      expect(createFromBill).toHaveBeenCalledWith({ billItemId: 'bi_1', assetClass: '7' });
      expect(createAsset).not.toHaveBeenCalled();
      expect(navigate).toHaveBeenCalledWith({ to: '/weldbooks/fixed-assets/$id', params: { id: 'fa_10' } });
    });

    it('moves the cost off the expense account when asked to', async () => {
      const user = userEvent.setup();
      renderWithProviders(<NewFixedAssetPage />);

      // The line is booked to an expense account, so the reclass is offered.
      expect(screen.getByTestId('bill-line-card')).toHaveTextContent('6100 — Equipment expense');
      await user.click(screen.getByRole('checkbox', { name: 'Move the cost to the asset account' }));
      await user.type(screen.getByLabelText('Name'), 'Warehouse forklift');
      await user.click(screen.getByTestId('asset-submit'));

      await waitFor(() => expect(createFromBill).toHaveBeenCalledTimes(1));
      expect(createFromBill).toHaveBeenCalledWith({ billItemId: 'bi_1', name: 'Warehouse forklift', reclass: true });
    });
  });
});
