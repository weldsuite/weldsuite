import type { ReactNode } from 'react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { FixedAssetDetail } from '@/lib/api/domains/weldbooks-assets';

const deleteAsync = vi.fn();
const openPanel = vi.fn();
const onClose = vi.fn();
const permissions = new Set(['accounts:read', 'accounts:update', 'accounts:delete', 'journal:create']);
let asset: FixedAssetDetail | undefined;
let requestedId: string | undefined;

vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, children, ...rest }: { to: string; children: ReactNode; 'aria-label'?: string }) => (
    <a href={to} aria-label={rest['aria-label']}>
      {children}
    </a>
  ),
}));
vi.mock('@weldsuite/permissions/react', () => ({
  usePermissions: () => ({ can: (permission: string) => permissions.has(permission) }),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/hooks/use-workspace-url', () => ({ useWorkspaceUrl: () => (path: string) => `https://app.test${path}` }));
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
  useFixedAsset: (id: string | undefined) => {
    requestedId = id;
    return { data: asset, isLoading: false, isError: false, refetch: vi.fn() };
  },
  useDeleteFixedAsset: () => ({ mutateAsync: deleteAsync, isPending: false }),
  useDisposeFixedAsset: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock('@weldsuite/ui/components/drawer-field-settings', () => ({ DrawerFieldSettings: () => null }));
vi.mock('@weldsuite/ui/components/entity-detail-view', () => ({
  EntityDetailView: ({
    title,
    actions,
    tabs,
    children,
  }: {
    title: ReactNode;
    actions: ReactNode;
    tabs: ReactNode;
    children: ReactNode;
  }) => (
    <div>
      <header>
        <div data-testid="title">{title}</div>
        {actions}
      </header>
      {tabs}
      <main>{children}</main>
    </div>
  ),
}));
vi.mock('@/components/object-panel', () => ({
  useObjectPanel: () => ({ open: openPanel }),
  useObjectPanelShell: () => ({ mode: 'fullscreen', setMode: vi.fn(), entityDetailViewProps: {} }),
  useObjectPanelTabConfig: () => ({
    visibility: {},
    isVisible: () => true,
    toggle: vi.fn(),
    resetToDefaults: vi.fn(),
  }),
  ObjectPanelTabs: ({
    tabs,
    activeTab,
    onChange,
  }: {
    tabs: { id: string; label: string }[];
    activeTab: string;
    onChange: (id: string) => void;
  }) => (
    <div role="tablist" aria-label="panel tabs">
      {tabs.map((tab) => (
        <button key={tab.id} role="tab" aria-selected={tab.id === activeTab} onClick={() => onChange(tab.id)}>
          {tab.label}
        </button>
      ))}
    </div>
  ),
}));
vi.mock('@/components/entity-audit-panel', () => ({
  EntityAuditPanel: ({ entityType, entityId }: { entityType: string; entityId: string }) => (
    <div data-testid="audit" data-entity-type={entityType} data-entity-id={entityId} />
  ),
}));

import { FixedAssetPanel } from './fixed-asset-panel';
import { polyfillRadixSelect, renderWithProviders } from '@/app/weldbooks/fixed-assets/test-utils';

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

const panelProps = { id: 'fa_1', isOpen: true, onClose };

async function openDepreciation(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('tab', { name: /Depreciation/ }));
}

async function openMenu(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: 'Copy link' }));
}

describe('Fixed asset panel', () => {
  beforeAll(polyfillRadixSelect);
  beforeEach(() => {
    deleteAsync.mockReset().mockResolvedValue(undefined);
    openPanel.mockReset();
    onClose.mockReset();
    requestedId = undefined;
    permissions.clear();
    ['accounts:read', 'accounts:update', 'accounts:delete', 'journal:create'].forEach((permission) => permissions.add(permission));
    asset = detail();
  });

  it('shows the cost, what is posted and the net book value', () => {
    renderWithProviders(<FixedAssetPanel {...panelProps} />);
    expect(requestedId).toBe('fa_1');
    const title = screen.getByTestId('title');
    expect(title).toHaveTextContent('Forklift');
    expect(title).toHaveTextContent('Active');
    expect(screen.getByText('FA-1')).toBeInTheDocument();
    expect(screen.getByText('Net book value (posted)').parentElement?.nextElementSibling).toHaveTextContent('$12000.00');
    expect(screen.getByText('Cost').parentElement?.nextElementSibling).toHaveTextContent('$12000.00');
    expect(screen.getByText('1500 — Equipment')).toBeInTheDocument();
    expect(screen.getByText('7-year property (furniture, machinery)')).toBeInTheDocument();
    expect(screen.getByText('Warehouse forklift')).toBeInTheDocument();
  });

  it('opens on the ledger book with its yearly schedule and its monthly postings', async () => {
    const user = userEvent.setup();
    renderWithProviders(<FixedAssetPanel {...panelProps} />);
    await openDepreciation(user);

    const annual = screen.getByTestId('annual-schedule');
    expect(annual).toHaveTextContent('2026');
    expect(annual).toHaveTextContent('$1714.29');
    // No section 179 or bonus figure on a book that takes none.
    expect(within(annual).queryByText(/Section 179/)).not.toBeInTheDocument();
    expect(within(annual).queryByText(/Bonus/)).not.toBeInTheDocument();

    const ledger = screen.getByTestId('ledger-postings');
    expect(ledger).toHaveTextContent('0 of 2 periods posted');
    expect(within(ledger).getAllByText('Scheduled')).toHaveLength(2);
  });

  it('shows the section 179 and bonus of the federal book on its own tab', async () => {
    const user = userEvent.setup();
    renderWithProviders(<FixedAssetPanel {...panelProps} />);
    await openDepreciation(user);
    await user.click(screen.getByRole('tab', { name: 'Federal tax' }));

    const annual = await screen.findByTestId('annual-schedule');
    expect(within(annual).getByText('Section 179 $2500.00')).toBeInTheDocument();
    expect(within(annual).getByText('Bonus $9500.00')).toBeInTheDocument();
    expect(screen.getByText('Computed for the tax return, posts nothing')).toBeInTheDocument();
    // Tax books post nothing, so no ledger postings are listed.
    expect(screen.queryByTestId('ledger-postings')).not.toBeInTheDocument();
  });

  it('opens the journal entry of a posted period and locks the asset', async () => {
    const user = userEvent.setup();
    asset = detail({
      accumulatedPosted: '142.86',
      netBookValuePosted: '11857.14',
      ledgerRows: [
        { id: 'fad_1', assetId: 'fa_1', bookId: 'fab_1', periodStart: '2026-01-01', periodEnd: '2026-01-31', amount: '142.86', accumulated: '142.86', journalEntryId: 'je_1' },
        { id: 'fad_2', assetId: 'fa_1', bookId: 'fab_1', periodStart: '2026-02-01', periodEnd: '2026-02-28', amount: '142.86', accumulated: '285.72', journalEntryId: null },
      ],
    });
    renderWithProviders(<FixedAssetPanel {...panelProps} />);
    expect(screen.getByTestId('asset-locked')).toBeInTheDocument();

    await openDepreciation(user);
    const ledger = screen.getByTestId('ledger-postings');
    expect(ledger).toHaveTextContent('1 of 2 periods posted');
    expect(within(ledger).getByText('Posted')).toBeInTheDocument();
    // Only the posted period has an entry to open.
    expect(within(ledger).getAllByRole('button')).toHaveLength(1);
    await user.click(within(ledger).getByRole('button', { name: '2026-01-01 – 2026-01-31' }));
    expect(openPanel).toHaveBeenCalledWith({ type: 'journal_entry', id: 'je_1', stack: true });

    // A posted asset cannot be deleted; it is disposed of instead.
    await openMenu(user);
    expect(await screen.findByRole('menuitem', { name: 'Delete' })).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByText(/so the asset cannot be deleted/)).toBeInTheDocument();
  });

  it('deletes an asset nothing is posted for, after confirming', async () => {
    const user = userEvent.setup();
    renderWithProviders(<FixedAssetPanel {...panelProps} />);

    await openMenu(user);
    await user.click(await screen.findByRole('menuitem', { name: 'Delete' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Delete Forklift?')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Delete asset' }));

    await vi.waitFor(() => expect(deleteAsync).toHaveBeenCalledWith('fa_1'));
    await vi.waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('opens the disposal dialog', async () => {
    const user = userEvent.setup();
    renderWithProviders(<FixedAssetPanel {...panelProps} />);
    await user.click(screen.getByTestId('dispose-open'));
    expect(await screen.findByText('Dispose of Forklift')).toBeInTheDocument();
    expect(screen.getByTestId('dispose-preview')).toBeInTheDocument();
  });

  it('links to the edit page', () => {
    renderWithProviders(<FixedAssetPanel {...panelProps} />);
    expect(screen.getByRole('link', { name: 'Edit' })).toHaveAttribute('href', '/weldbooks/fixed-assets/$id/edit');
  });

  it('opens the source bill in its own panel on top of the asset', async () => {
    const user = userEvent.setup();
    asset = detail({ billId: 'bill_1' });
    renderWithProviders(<FixedAssetPanel {...panelProps} />);
    await user.click(screen.getByRole('button', { name: 'View bill' }));
    expect(openPanel).toHaveBeenCalledWith({ type: 'bill', id: 'bill_1', stack: true });
  });

  it('shows the disposal of a disposed asset and offers no more changes to it', async () => {
    const user = userEvent.setup();
    asset = detail({ status: 'disposed', disposalDate: '2026-04-15', disposalProceeds: '9000.00', disposalJournalEntryId: 'je_9' });
    renderWithProviders(<FixedAssetPanel {...panelProps} />);

    const disposal = screen.getByTestId('disposal-card');
    expect(disposal).toHaveTextContent('2026-04-15');
    expect(disposal).toHaveTextContent('$9000.00');
    await user.click(within(disposal).getByRole('button', { name: 'View journal entry' }));
    expect(openPanel).toHaveBeenCalledWith({ type: 'journal_entry', id: 'je_9', stack: true });
    expect(screen.queryByTestId('dispose-open')).not.toBeInTheDocument();
    await openMenu(user);
    expect(screen.queryByRole('menuitem', { name: 'Delete' })).not.toBeInTheDocument();
  });

  it('explains the notes the rules left on the depreciation in plain language', () => {
    asset = detail({ issues: [{ book: 'federal', stateCode: null, severity: 'warning', code: 'ads_required', message: 'English from the server' }] });
    renderWithProviders(<FixedAssetPanel {...panelProps} />);
    expect(screen.getByTestId('asset-issues')).toHaveTextContent('Federal tax: Listed property used 50% or less for business must use ADS');
  });

  it('hides edit, dispose and delete without the permissions', async () => {
    const user = userEvent.setup();
    permissions.clear();
    permissions.add('accounts:read');
    renderWithProviders(<FixedAssetPanel {...panelProps} />);
    expect(screen.queryByRole('link', { name: 'Edit' })).not.toBeInTheDocument();
    expect(screen.queryByTestId('dispose-open')).not.toBeInTheDocument();
    await openMenu(user);
    expect(screen.queryByRole('menuitem', { name: 'Delete' })).not.toBeInTheDocument();
  });

  it('reads the audit trail of the asset on the history tab', async () => {
    const user = userEvent.setup();
    renderWithProviders(<FixedAssetPanel {...panelProps} />);
    await user.click(screen.getByRole('tab', { name: 'Audit Log' }));
    expect(screen.getByTestId('audit')).toHaveAttribute('data-entity-type', 'fixed_asset');
    expect(screen.getByTestId('audit')).toHaveAttribute('data-entity-id', 'fa_1');
  });

  it('says so when the asset does not exist', () => {
    asset = undefined;
    renderWithProviders(<FixedAssetPanel {...panelProps} />);
    expect(screen.getByText('This asset does not exist or was deleted.')).toBeInTheDocument();
  });
});
