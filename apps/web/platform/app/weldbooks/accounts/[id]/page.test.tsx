import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { en } from '@weldsuite/i18n/locales/en';

const mocks = vi.hoisted(() => ({
  account: { data: undefined as unknown, isLoading: false },
  update: vi.fn(),
  can: new Set<string>(),
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, children }: { to: string; children: React.ReactNode }) => <a href={to}>{children}</a>,
  useParams: () => ({ id: 'acc_1' }),
}));
vi.mock('sonner', () => ({ toast: mocks.toast }));
vi.mock('@weldsuite/permissions/react', () => ({ useCan: (permission: string) => mocks.can.has(permission) }));
vi.mock('@/hooks/queries/use-accounting-queries', () => ({
  useAccountingAccount: () => mocks.account,
  useTaxLineCatalog: () => ({ data: undefined }),
  useUpdateAccount: () => ({
    isPending: false,
    mutate: (vars: unknown, options: { onSuccess?: () => void; onError?: (err: Error) => void }) => mocks.update(vars, options),
  }),
}));
vi.mock('@/hooks/use-current-entity-currency', () => ({
  useCurrentEntityCurrency: () => ({ formatMoney: (value: string | null) => `$${value ?? '0'}`, entityCurrency: 'USD' }),
}));
vi.mock('@/lib/weldbooks/use-jurisdiction', () => ({
  useCurrentJurisdiction: () => ({ code: 'NL', features: { form1099: false } }),
}));
vi.mock('@/components/page-loader', () => ({ PageLoader: () => <div>loading</div> }));

import AccountDetailPage from './page';
import { renderWithProviders } from '@/app/weldbooks/sales-tax/setup/test-support';

const ta = en.accounting.accounts;

const account = {
  id: 'acc_1',
  code: '6100',
  name: 'Office supplies',
  type: 'expense',
  normalSide: 'debit',
  isActive: true,
  isSystemAccount: false,
  openingBalance: '0',
  currentBalance: '0',
  currency: 'EUR',
};

function show(overrides: Record<string, unknown> = {}) {
  mocks.account = { data: { data: { ...account, ...overrides } }, isLoading: false };
}

beforeEach(() => {
  mocks.update.mockReset();
  mocks.toast.success.mockReset();
  mocks.toast.error.mockReset();
  mocks.can = new Set(['accounts:update']);
  show();
});

describe('account detail page: deactivate and reactivate', () => {
  it('deactivates after a confirmation', async () => {
    const user = userEvent.setup();
    mocks.update.mockImplementation((_vars, options) => options.onSuccess?.());
    renderWithProviders(<AccountDetailPage />);

    await user.click(screen.getByTestId('account-toggle-active'));
    expect(screen.getByText(ta.deactivateTitle)).toBeInTheDocument();
    expect(mocks.update).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: ta.deactivate, hidden: false }));
    expect(mocks.update).toHaveBeenCalledWith({ id: 'acc_1', data: { isActive: false } }, expect.any(Object));
    expect(mocks.toast.success).toHaveBeenCalledWith(ta.deactivated);
  });

  it('shows the server\'s reason when the account still has a balance', async () => {
    const user = userEvent.setup();
    mocks.update.mockImplementation((_vars, options) =>
      options.onError?.(new Error('This account still has a balance of 125.50. Clear the balance before deactivating it.')),
    );
    renderWithProviders(<AccountDetailPage />);

    await user.click(screen.getByTestId('account-toggle-active'));
    await user.click(screen.getByRole('button', { name: ta.deactivate, hidden: false }));
    await waitFor(() =>
      expect(mocks.toast.error).toHaveBeenCalledWith(ta.deactivateFailed, {
        description: 'This account still has a balance of 125.50. Clear the balance before deactivating it.',
      }),
    );
  });

  it('reactivates an inactive account and marks it as inactive', async () => {
    const user = userEvent.setup();
    show({ isActive: false });
    renderWithProviders(<AccountDetailPage />);

    expect(screen.getByText(ta.inactive)).toBeInTheDocument();
    await user.click(screen.getByTestId('account-toggle-active'));
    expect(screen.getByText(ta.reactivateTitle)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: ta.reactivate, hidden: false }));
    expect(mocks.update).toHaveBeenCalledWith({ id: 'acc_1', data: { isActive: true } }, expect.any(Object));
  });

  it('does not offer deactivation for a system account, nor without accounts:update', () => {
    show({ isSystemAccount: true });
    const { unmount } = renderWithProviders(<AccountDetailPage />);
    expect(screen.queryByTestId('account-toggle-active')).not.toBeInTheDocument();
    unmount();

    show();
    mocks.can = new Set();
    renderWithProviders(<AccountDetailPage />);
    expect(screen.queryByTestId('account-toggle-active')).not.toBeInTheDocument();
  });
});
