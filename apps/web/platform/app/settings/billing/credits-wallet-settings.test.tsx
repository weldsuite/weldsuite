import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const mocks = vi.hoisted(() => ({
  mutateAsync: vi.fn(),
  get: vi.fn(),
  can: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  toastInfo: vi.fn(),
}));

vi.mock('sonner', () => ({
  toast: { success: mocks.toastSuccess, error: mocks.toastError, info: mocks.toastInfo },
}));
vi.mock('@/hooks/queries/use-billing-queries', () => ({
  useCreditsBalance: () => ({ data: { data: { currentBalance: 40, isLow: true } }, isLoading: false }),
  useCreditPackages: () => ({
    data: { data: [{ id: 'pkg_small', name: 'Small', credits: 1000, price: 10, currency: 'EUR', isPopular: true }] },
  }),
  useBuyCredits: () => ({ mutateAsync: mocks.mutateAsync, isPending: false }),
}));
vi.mock('@/lib/api/use-app-api', () => ({
  useAppApiClient: () => ({ getClient: async () => ({ get: mocks.get }) }),
}));
vi.mock('@weldsuite/permissions/react', () => ({ usePermissions: () => ({ can: mocks.can }) }));
vi.mock('@/components/access-denied-empty-state', () => ({
  AccessDeniedEmptyState: () => <p>access denied</p>,
}));
vi.mock('@weldsuite/i18n/client', () => ({ useTranslations: () => (key: string) => key }));
vi.mock('@/lib/i18n/provider', async () => {
  const { en } = await import('@weldsuite/i18n/locales/en');
  const { interpolate } = await import('@weldsuite/i18n/provider');
  return { useI18n: () => ({ t: en, language: 'en', format: interpolate }) };
});

import { en } from '@weldsuite/i18n/locales/en';
import { CreditsWalletSettings } from './credits-wallet-settings';

const ts = en.settings.billing.creditsWallet;

function renderPage() {
  const client = new QueryClient();
  return render(
    <QueryClientProvider client={client}>
      <CreditsWalletSettings />
    </QueryClientProvider>,
  );
}

describe('CreditsWalletSettings', () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockReset();
    mocks.can.mockReturnValue(true);
    window.history.replaceState({}, '', '/settings/billing');
  });

  it('shows the balance and starts a checkout for a package', async () => {
    mocks.mutateAsync.mockResolvedValue({ url: '' });
    const user = userEvent.setup();
    renderPage();

    expect(screen.getByText(ts.title)).toBeInTheDocument();
    expect(screen.getByText('40')).toBeInTheDocument();
    expect(screen.getByText(ts.lowBalance)).toBeInTheDocument();
    expect(screen.getByText(ts.paidThroughMollie)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: ts.topUp }));
    expect(await screen.findByText(ts.choosePackage)).toBeInTheDocument();
    expect(screen.getByText('€10.00')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /€10\.00/ }));

    expect(mocks.mutateAsync).toHaveBeenCalledWith('pkg_small');
    // No checkout address came back: nothing to go to.
    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith(ts.purchaseFailed));
  });

  it('hides the top-up from members who cannot manage billing', () => {
    mocks.can.mockImplementation((permission: string) => permission === 'billing:read');
    renderPage();
    expect(screen.getByText('40')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: ts.topUp })).not.toBeInTheDocument();
  });

  it("asks how a Mollie checkout ended when it comes back, and doesn't trust the URL", async () => {
    window.history.replaceState({}, '', '/settings/billing?credits=success&checkout=ctp_abc');
    mocks.get.mockResolvedValue({ data: { id: 'ctp_abc', status: 'failed', credits: 1000 } });
    renderPage();

    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith(ts.purchaseNotCompleted));
    expect(mocks.get).toHaveBeenCalledWith('/credits/checkout/ctp_abc');
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
    expect(window.location.search).toBe('');
  });

  it('confirms a paid checkout', async () => {
    window.history.replaceState({}, '', '/settings/billing?credits=success&checkout=ctp_paid');
    mocks.get.mockResolvedValue({ data: { id: 'ctp_paid', status: 'paid', credits: 1000 } });
    renderPage();
    await waitFor(() => expect(mocks.toastSuccess).toHaveBeenCalledWith(ts.purchaseSuccess));
  });
});
