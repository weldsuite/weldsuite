import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { setRuntimeConfig } from '@/lib/runtime-config';
import userEvent from '@testing-library/user-event';

const env = vi.hoisted(() => ({
  account: null as Record<string, unknown> | null,
  ledgerAccounts: [] as Array<{ id: string; code: string; name: string }>,
  unreconciled: 0,
  jurisdiction: 'NL' as string,
  paymentsApi: { getConnection: vi.fn(), syncSettlements: vi.fn() },
}));

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@weldsuite/permissions/react', () => ({ usePermissions: () => ({ can: () => true }), useCan: () => true }));
vi.mock('@/lib/api/domains/weldbooks-payments', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/domains/weldbooks-payments')>()),
  paymentsApi: env.paymentsApi,
}));
vi.mock('@/hooks/use-workspace-url', () => ({ useWorkspaceUrl: () => (path: string) => `https://app.test${path}` }));
vi.mock('@weldsuite/ui/components/drawer-field-settings', () => ({ DrawerFieldSettings: () => null }));
vi.mock('@weldsuite/ui/components/entity-detail-view', () => ({
  EntityDetailView: ({ title, tabs, children }: { title: ReactNode; tabs: ReactNode; children: ReactNode }) => (
    <div>
      <header>{title}</header>
      {tabs}
      <main>{children}</main>
    </div>
  ),
}));
vi.mock('@/components/object-panel', () => import('@/components/objects/_shared/object-panel-test-mock'));
vi.mock('@/components/entity-audit-panel', () => ({ EntityAuditPanel: () => null }));
vi.mock('@/components/accounting/bank-transaction-form-dialog', () => ({ BankTransactionFormDialog: () => null }));
vi.mock('@/app/weldbooks/banking/feeds/bank-feeds-panel', () => ({ BankFeedsPanel: () => null }));
vi.mock('@/app/weldbooks/banking/components/bank-account-form-dialog', () => ({ BankAccountFormDialog: () => null }));
vi.mock('@/app/weldbooks/banking/components/reveal-account-number', () => ({ RevealAccountNumber: () => null }));
vi.mock('@tanstack/react-router', async () => {
  const { RouteLink } = await import('@/app/weldbooks/invoices/components/test-utils');
  return { Link: RouteLink };
});
vi.mock('@/hooks/queries/use-accounting-queries', () => ({
  useAccountingAccounts: () => ({ data: { data: env.ledgerAccounts } }),
  useAutoReconcile: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteBankAccount: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock('@/hooks/queries/use-weldbooks-banking-queries', () => ({
  useBankAccount: () => ({ data: env.account ? { data: env.account } : undefined, isLoading: false, isError: false }),
  useBankLines: (filters?: { status?: string }) => ({
    data: { data: [], pagination: { totalCount: filters?.status === 'unreconciled' ? env.unreconciled : 0 } },
    isLoading: false,
  }),
}));
vi.mock('@/lib/weldbooks/use-jurisdiction', () => ({ useCurrentJurisdiction: () => ({ code: env.jurisdiction }) }));
vi.mock('@/lib/weldbooks/use-weldbooks-format', () => ({
  useWeldbooksFormat: () => ({
    currency: 'EUR',
    formatMoney: (value: unknown) => `€${Number(value ?? 0).toFixed(2)}`,
    formatDateTime: (_value: unknown, fallback: string) => fallback,
  }),
}));

import { BankAccountPanel } from './bank-account-panel';
import { getBankAccountTabs } from './bank-account-tabs';
import { panelOpen } from '@/components/objects/_shared/object-panel-test-mock';
import { renderWithProviders } from '@/app/weldbooks/invoices/components/test-utils';

function account(overrides: Record<string, unknown> = {}) {
  return {
    id: 'ba_1',
    name: 'Business account',
    iban: 'NL91ABNA0417164300',
    bic: 'ABNANL2A',
    currency: 'EUR',
    currentBalance: '1250.00',
    isActive: true,
    isDefault: true,
    ledgerAccountId: 'acc_1100',
    ...overrides,
  };
}

function renderPanel() {
  return renderWithProviders(<BankAccountPanel id="ba_1" isOpen onClose={vi.fn()} />);
}

describe('BankAccountPanel ledger account', () => {
  beforeEach(() => {
    env.account = account();
    env.unreconciled = 0;
    env.jurisdiction = 'NL';
    panelOpen.mockReset();
    env.ledgerAccounts = [
      { id: 'acc_1100', code: '1100', name: 'Bank' },
      { id: 'acc_1200', code: '1200', name: 'Savings' },
    ];
  });

  it('shows the ledger account the bank account books to, as code and name', () => {
    renderPanel();
    expect(screen.getByText('Ledger account')).toBeInTheDocument();
    expect(screen.getByText('1100 — Bank')).toBeInTheDocument();
  });

  it('shows the ledger account as a chip that stacks its panel', async () => {
    renderPanel();
    await userEvent.click(screen.getByRole('link', { name: '1100 — Bank' }));
    expect(panelOpen).toHaveBeenCalledWith({ type: 'ledger_account', id: 'acc_1100', stack: true });
  });

  it('says so when the bank account is not linked to a ledger account', () => {
    env.account = account({ ledgerAccountId: null });
    renderPanel();
    expect(screen.getByText('Ledger account')).toBeInTheDocument();
    expect(screen.getByText('Not linked')).toBeInTheDocument();
  });

  it('shows no name for a linked account until the chart of accounts has loaded it', () => {
    env.ledgerAccounts = [];
    renderPanel();
    expect(screen.queryByText('Not linked')).not.toBeInTheDocument();
    expect(screen.queryByText('1100 — Bank')).not.toBeInTheDocument();
  });
});

describe('BankAccountPanel reconciling', () => {
  beforeEach(() => {
    env.account = account();
    env.unreconciled = 0;
    env.jurisdiction = 'NL';
    env.ledgerAccounts = [{ id: 'acc_1100', code: '1100', name: 'Bank' }];
  });

  it('links the unreconciled count to the reconcile screen of this account', () => {
    env.unreconciled = 7;
    renderPanel();
    const link = screen.getByTestId('unreconciled-link');
    expect(link).toHaveTextContent('7');
    expect(link.getAttribute('href')).toBe('/weldbooks/banking/reconciliation');
  });

  it('shows no link when nothing is left to reconcile', () => {
    renderPanel();
    expect(screen.queryByTestId('unreconciled-link')).not.toBeInTheDocument();
  });

  it.each(['NL', 'US', 'DE'])('offers Reconcile on the Transactions tab for a %s entity', async (code) => {
    env.jurisdiction = code;
    const user = userEvent.setup();
    renderPanel();
    await user.click(screen.getByRole('tab', { name: /Transactions/ }));
    const reconcile = screen.getByTestId('reconcile-account');
    expect(reconcile).toHaveTextContent('Reconcile');
    expect(reconcile.getAttribute('href')).toBe('/weldbooks/banking/reconciliation');
  });
});

describe('getBankAccountTabs', () => {
  it('shows History in the side panel as well as fullscreen', () => {
    const history = getBankAccountTabs({ details: 'Details', transactions: 'Transactions', feeds: 'Feed', history: 'History' }).find(
      (tab) => tab.id === 'history',
    );
    expect(history?.defaultVisibleInPanel).toBe(true);
    expect(history?.defaultVisibleInFullscreen).toBe(true);
  });
});

describe('BankAccountPanel of a payment provider (Mollie)', () => {
  const RUST = { backend: 'rust', modules: ['core', 'books'], unavailableFeatures: [] as string[] };
  const connection = (overrides: Record<string, unknown> = {}) => ({
    id: 'pc_1',
    status: 'active',
    settlementsAvailable: true,
    bankAccountId: 'ba_1',
    ...overrides,
  });

  beforeEach(() => {
    env.account = account({ name: 'Mollie', iban: null, bic: null, accountType: 'payment_provider' });
    env.jurisdiction = 'NL';
    env.paymentsApi.getConnection.mockReset();
    env.paymentsApi.syncSettlements.mockReset();
    env.paymentsApi.getConnection.mockResolvedValue({ data: connection() });
    env.ledgerAccounts = [];
    setRuntimeConfig(RUST);
  });
  afterEach(() => setRuntimeConfig(null));

  it('labels the account a payment provider, in the title and the details, and shows no bank numbers', async () => {
    renderPanel();
    expect(screen.getAllByText('Payment provider').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByTestId('payment-provider-section')).toHaveTextContent('Online payments land here first.');
    expect(screen.queryByText('IBAN')).not.toBeInTheDocument();
  });

  it('syncs payouts from the panel and says what came of it', async () => {
    const user = userEvent.setup();
    env.paymentsApi.syncSettlements.mockResolvedValue({
      data: { imported: 4, skipped: 0, lines: 4, booked: 3, toProcess: 1, fees: 1, payouts: 1 },
    });
    renderPanel();
    await user.click(await screen.findByTestId('sync-payouts'));
    await waitFor(() => expect(env.paymentsApi.syncSettlements).toHaveBeenCalledWith('pc_1'));
    expect(await screen.findByText(/3 of 4 lines booked automatically, 1 waiting in To process/)).toBeInTheDocument();
  });

  it('offers no sync for an API-key connection, or for another connection\'s account', async () => {
    env.paymentsApi.getConnection.mockResolvedValue({ data: connection({ settlementsAvailable: false }) });
    const first = renderPanel();
    await waitFor(() => expect(env.paymentsApi.getConnection).toHaveBeenCalled());
    expect(screen.queryByTestId('sync-payouts')).not.toBeInTheDocument();
    first.unmount();

    env.paymentsApi.getConnection.mockResolvedValue({ data: connection({ bankAccountId: 'ba_other' }) });
    renderPanel();
    await waitFor(() => expect(env.paymentsApi.getConnection).toHaveBeenCalledTimes(2));
    expect(screen.queryByTestId('sync-payouts')).not.toBeInTheDocument();
  });

  it('shows a regular account without the provider section', async () => {
    env.account = account();
    renderPanel();
    expect(screen.queryByTestId('payment-provider-section')).not.toBeInTheDocument();
    expect(screen.queryByText('Payment provider')).not.toBeInTheDocument();
  });
});
