import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const navigate = vi.fn();
const openPanel = vi.fn();
const permissions = new Set(['banking:read', 'banking:create']);

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
vi.mock('@/lib/weldbooks/use-jurisdiction', () => ({
  useCurrentJurisdiction: () => ({ code: 'US', isError: false }),
}));
vi.mock('@/lib/weldbooks/use-weldbooks-format', () => ({
  useWeldbooksFormat: () => ({
    formatMoney: (value: number | string) => `$${Number(value).toFixed(2)}`,
    formatDate: (value: string) => value,
    entityCurrency: 'USD',
  }),
}));
vi.mock('./../banking/components/undeposited-funds-callout', () => ({ UndepositedFundsCallout: () => null }));
// Stable results: a fresh object per render would loop the list's paging state.
const queries = vi.hoisted(() => ({
  accounts: { data: { data: [{ id: 'ba_1', name: 'Operating' }] } },
  deposits: {
    isError: false,
    isPlaceholderData: false,
    data: {
      data: [
        {
          id: 'dep_1',
          bankAccountId: 'ba_1',
          date: '2026-01-06',
          amount: '1550.50',
          currency: 'USD',
          memo: 'January checks',
          status: 'posted',
          journalEntryId: 'je_1',
          bankTransactionId: null,
          createdBy: null,
          createdAt: '2026-01-06T10:00:00Z',
        },
      ],
      pagination: { totalCount: 1, hasMore: false, cursor: null },
    },
  },
}));
vi.mock('@/hooks/queries/use-weldbooks-banking-queries', () => ({
  useBankAccounts: () => queries.accounts,
  useBankDeposits: () => queries.deposits,
}));

import DepositsPage from './page';
import { renderWithProviders } from '../fixed-assets/test-utils';

describe('DepositsPage', () => {
  beforeEach(() => {
    navigate.mockReset();
    openPanel.mockReset();
  });

  it('opens a deposit in the deposit record panel by clicking its row', async () => {
    const user = userEvent.setup();
    renderWithProviders(<DepositsPage />);

    await user.click(await screen.findByRole('button', { name: 'January checks' }));
    expect(openPanel).toHaveBeenCalledWith({ type: 'deposit', id: 'dep_1' });
    expect(navigate).not.toHaveBeenCalled();
  });
});
