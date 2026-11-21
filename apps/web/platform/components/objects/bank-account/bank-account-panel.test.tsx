import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';

const env = vi.hoisted(() => ({
  account: null as Record<string, unknown> | null,
  ledgerAccounts: [] as Array<{ id: string; code: string; name: string }>,
}));

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@weldsuite/permissions/react', () => ({ usePermissions: () => ({ can: () => true }) }));
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
  useBankLines: () => ({ data: { data: [], pagination: { totalCount: 0 } }, isLoading: false }),
}));
vi.mock('@/lib/weldbooks/use-jurisdiction', () => ({ useCurrentJurisdiction: () => ({ code: 'NL' }) }));
vi.mock('@/lib/weldbooks/use-weldbooks-format', () => ({
  useWeldbooksFormat: () => ({
    currency: 'EUR',
    formatMoney: (value: unknown) => `€${Number(value ?? 0).toFixed(2)}`,
    formatDateTime: (_value: unknown, fallback: string) => fallback,
  }),
}));

import { BankAccountPanel } from './bank-account-panel';
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
