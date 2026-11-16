import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ApiError } from '@weldsuite/api-client';

const mocks = vi.hoisted(() => ({
  mutateAsync: vi.fn(),
  updateSettings: vi.fn(),
  get: vi.fn(),
  invoiceClick: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  toastInfo: vi.fn(),
}));

// Stable references: the page memoizes on them and the details dialog resets on change.
const fixtures = vi.hoisted(() => ({
  subscription: {
    id: 'sub_1',
    status: 'active',
    planSlug: 'pro',
    planName: 'Pro',
    cycle: 'monthly',
    cancelAtPeriodEnd: false,
    currentPeriodEnd: '2027-01-15T00:00:00.000Z',
  },
  invoices: {
    data: [
      {
        id: 'inv_1',
        number: 'INV-001',
        amount: 1210,
        currency: 'eur',
        status: 'paid',
        createdAt: '2026-10-01T00:00:00.000Z',
        pdfUrl: '/api/billing/invoices/inv_1/document',
      },
    ],
  },
  limits: { data: { planName: 'Pro', currentUsage: { memberCount: 2, creditsBalance: 40 }, maxMembers: 5 } },
  packages: { data: [{ id: 'pkg_small', name: 'Small', credits: 1000, price: 10, currency: 'EUR', isPopular: true }] },
  balance: { data: { currentBalance: 40, isLow: false } },
  settings: {
    data: {
      email: 'billing@acme.nl',
      legalName: 'Acme B.V.',
      addressLine1: 'Keizersgracht 100',
      country: 'NL',
      city: 'Amsterdam',
      postalCode: '1015 AA',
    },
  },
}));

vi.mock('@/lib/edition', () => ({
  isFeatureAvailable: () => true,
  billingProvider: () => 'mollie',
}));
vi.mock('sonner', () => ({
  toast: { success: mocks.toastSuccess, error: mocks.toastError, info: mocks.toastInfo },
}));
vi.mock('@/hooks/queries/use-billing-queries', () => ({
  useSubscription: () => ({ data: fixtures.subscription, isLoading: false }),
  useInvoices: () => ({ data: fixtures.invoices, isLoading: false }),
  usePlanLimits: () => ({ data: fixtures.limits, isLoading: false }),
  usePhoneSubscription: () => ({ data: undefined }),
  useCancelSubscription: () => ({ mutateAsync: vi.fn() }),
  useReactivateSubscription: () => ({ mutateAsync: vi.fn() }),
  useCreditsBalance: () => ({ data: fixtures.balance, isLoading: false }),
  useCreditPackages: () => ({ data: fixtures.packages }),
  useBuyCredits: () => ({ mutateAsync: mocks.mutateAsync, isPending: false }),
}));
vi.mock('@/hooks/queries/use-settings-queries', () => ({
  useWorkspaceSettings: () => ({ data: fixtures.settings }),
  useUpdateWorkspaceSettings: () => ({ mutateAsync: mocks.updateSettings, isPending: false }),
}));
vi.mock('@/hooks/queries/use-partner-queries', () => ({
  useManagedBilling: () => ({ data: null, isLoading: false }),
}));
vi.mock('@/hooks/use-invoice-document', () => ({ useInvoiceLinkClick: () => mocks.invoiceClick }));
vi.mock('@/lib/api/use-app-api', () => ({
  useAppApiClient: () => ({ getClient: async () => ({ get: mocks.get }) }),
}));
vi.mock('@weldsuite/permissions/react', () => ({ usePermissions: () => ({ can: () => true }) }));
vi.mock('@/lib/router', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('./payment-methods-section', () => ({ PaymentMethodsSection: () => <div>payment methods</div> }));
vi.mock('@/components/access-denied-empty-state', () => ({ AccessDeniedEmptyState: () => <p>access denied</p> }));
vi.mock('@weldsuite/i18n/client', () => ({ useTranslations: () => (key: string) => key }));
vi.mock('@/lib/i18n/provider', async () => {
  const { en } = await import('@weldsuite/i18n/locales/en');
  const { interpolate } = await import('@weldsuite/i18n/provider');
  return { useI18n: () => ({ t: en, language: 'en', format: interpolate }) };
});

import { en } from '@weldsuite/i18n/locales/en';
import BillingSettingsPage from './page';

const ts = en.settings.billing;

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <BillingSettingsPage />
    </QueryClientProvider>,
  );
}

async function openBuyDialog(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: ts.creditsWallet.topUp }));
  expect(await screen.findByText(ts.creditsWallet.choosePackage)).toBeInTheDocument();
}

const packageButton = () => screen.getByRole('button', { name: /€10\.00/ });

describe('BillingSettingsPage (Mollie edition)', () => {
  const location = { href: 'http://localhost/settings/billing', search: '', pathname: '/settings/billing' };

  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockReset();
    mocks.get.mockResolvedValue({ data: [] });
    mocks.updateSettings.mockResolvedValue({ data: {} });
    location.href = 'http://localhost/settings/billing';
    vi.stubGlobal('location', location);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders the Mollie subscription, invoices and credit balance', async () => {
    renderPage();

    expect(await screen.findByText(ts.title)).toBeInTheDocument();
    expect(screen.getByText('Pro')).toBeInTheDocument();
    expect(screen.getByText('INV-001')).toBeInTheDocument();
    expect(screen.getByText('payment methods')).toBeInTheDocument();
    await waitFor(() => expect(mocks.get).toHaveBeenCalledWith('/billing/phone-numbers'));
    expect(mocks.get).toHaveBeenCalledWith('/billing/domains');
  });

  it('hands an invoice link click to the invoice document handler', async () => {
    const user = userEvent.setup();
    renderPage();

    const row = (await screen.findByText('INV-001')).closest('tr') as HTMLElement;
    await user.click(within(row).getByRole('link'));

    expect(mocks.invoiceClick).toHaveBeenCalledTimes(1);
    expect(mocks.invoiceClick.mock.calls[0][1]).toBe('/api/billing/invoices/inv_1/document');
  });

  it('shows the excluding-VAT note in the buy dialog and goes to the checkout url', async () => {
    mocks.mutateAsync.mockResolvedValue({ url: 'https://pay.mollie.test/checkout' });
    const user = userEvent.setup();
    renderPage();

    await screen.findByText(ts.title);
    await openBuyDialog(user);
    expect(screen.getByText(ts.mollie.excludingVat)).toBeInTheDocument();

    await user.click(packageButton());

    expect(mocks.mutateAsync).toHaveBeenCalledWith('pkg_small');
    await waitFor(() => expect(location.href).toBe('https://pay.mollie.test/checkout'));
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it('reports a failed purchase when no checkout url comes back', async () => {
    mocks.mutateAsync.mockResolvedValue({});
    const user = userEvent.setup();
    renderPage();

    await screen.findByText(ts.title);
    await openBuyDialog(user);
    await user.click(packageButton());

    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith(ts.creditsWallet.purchaseFailed));
  });

  it('reports a failed purchase on any other error', async () => {
    mocks.mutateAsync.mockRejectedValue(new Error('boom'));
    const user = userEvent.setup();
    renderPage();

    await screen.findByText(ts.title);
    await openBuyDialog(user);
    await user.click(packageButton());

    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith(ts.creditsWallet.purchaseFailed));
    expect(mocks.toastInfo).not.toHaveBeenCalled();
  });

  it('opens the billing details dialog when they are required, then retries the purchase after saving', async () => {
    mocks.mutateAsync
      .mockRejectedValueOnce(
        new ApiError('Billing details required', 400, {
          error: { code: 'BILLING_DETAILS_REQUIRED', message: 'Billing details required' },
        }),
      )
      .mockResolvedValueOnce({ url: 'https://pay.mollie.test/after-details' });
    const user = userEvent.setup();
    renderPage();

    await screen.findByText(ts.title);
    await openBuyDialog(user);
    await user.click(packageButton());

    await waitFor(() => expect(mocks.toastInfo).toHaveBeenCalledWith(ts.mollie.billingDetailsRequired));
    await waitFor(() => expect(screen.queryByText(ts.creditsWallet.choosePackage)).not.toBeInTheDocument());
    const detailsDialog = await screen.findByRole('dialog', { name: ts.updateBillingDetails });
    expect(mocks.toastError).not.toHaveBeenCalled();
    expect(mocks.mutateAsync).toHaveBeenCalledTimes(1);

    await user.click(within(detailsDialog).getByRole('button', { name: ts.updateBillingDetails }));

    await waitFor(() => expect(mocks.updateSettings).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(mocks.mutateAsync).toHaveBeenCalledTimes(2));
    expect(mocks.mutateAsync).toHaveBeenLastCalledWith('pkg_small');
    await waitFor(() => expect(location.href).toBe('https://pay.mollie.test/after-details'));
  });
});
