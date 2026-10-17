import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/app/weldbooks/sales-tax/setup/test-support';

const accounts = vi.hoisted(() => ({
  data: {
    data: [{ id: 'acc_1', code: '6100', name: 'Office supplies', type: 'expense', currentBalance: '125.50', currency: 'EUR' }],
  },
  isLoading: false,
}));
vi.mock('@/hooks/queries/use-accounting-queries', () => ({
  useAccountingAccounts: () => accounts,
  useTaxLineCatalog: () => ({ data: undefined }),
}));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, children }: { to: string; children: React.ReactNode }) => <a href={to}>{children}</a>,
  useNavigate: () => vi.fn(),
}));
vi.mock('@/hooks/use-current-entity-currency', () => ({
  useCurrentEntityCurrency: () => ({ formatMoney: (value: string | null) => `$${value ?? '0'}` }),
}));
vi.mock('@/lib/weldbooks/use-jurisdiction', () => ({ useCurrentJurisdiction: () => ({ code: 'NL' }) }));
const panel = vi.hoisted(() => ({ open: vi.fn(), sync: vi.fn() }));
vi.mock('@/components/object-panel', () => ({
  useObjectPanel: () => ({ open: panel.open }),
  useObjectPanelUrlSync: panel.sync,
}));

import ChartOfAccountsPage from './page';

beforeEach(() => {
  panel.open.mockReset();
  panel.sync.mockReset();
});

describe('ChartOfAccountsPage', () => {
  it('opens an account in the ledger account panel, synced to the chart of accounts URL', async () => {
    renderWithProviders(<ChartOfAccountsPage />);

    expect(panel.sync).toHaveBeenCalledWith('/weldbooks/accounts');
    await userEvent.click(await screen.findByRole('button', { name: '6100 Office supplies' }));
    expect(panel.open).toHaveBeenCalledWith({ type: 'ledger_account', id: 'acc_1' });
  });
});
