import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ApiError } from '@weldsuite/api-client';

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  changePlan: vi.fn(),
  updateSeats: vi.fn(),
  saveSettings: vi.fn(),
  invoiceLinkClick: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  toastInfo: vi.fn(),
  provider: vi.fn(),
}));

vi.mock('sonner', () => ({
  toast: { success: mocks.toastSuccess, error: mocks.toastError, info: mocks.toastInfo },
}));
vi.mock('@/lib/edition', () => ({ billingProvider: () => mocks.provider() }));
vi.mock('@/lib/api/use-app-api', () => ({
  useAppApiClient: () => ({ getClient: async () => ({ get: mocks.get, post: mocks.post }) }),
}));
vi.mock('@/hooks/queries/use-billing-queries', () => ({
  usePlanLimits: () => ({ data: { data: { maxMembers: 5, currentUsage: { memberCount: 2 } } } }),
  useInvoices: () => ({ data: { data: [] } }),
  useSeatPrice: () => ({ data: undefined }),
  useChangePlan: () => ({ mutateAsync: mocks.changePlan }),
  useUpdateSeats: () => ({ mutateAsync: mocks.updateSeats }),
}));
vi.mock('@/hooks/queries/use-settings-queries', () => ({
  useAvailableApps: () => ({ data: [] }),
  useWorkspaceSettings: () => ({
    data: {
      data: {
        email: 'billing@acme.nl',
        legalName: 'Acme B.V.',
        addressLine1: 'Keizersgracht 100',
        country: 'NL',
        city: 'Amsterdam',
        postalCode: '1015 AA',
      },
    },
  }),
  useUpdateWorkspaceSettings: () => ({ mutateAsync: mocks.saveSettings, isPending: false }),
}));
vi.mock('@/hooks/use-invoice-document', () => ({ useInvoiceLinkClick: () => mocks.invoiceLinkClick }));
vi.mock('@/components/billing/enterprise-contact-form', () => ({
  EnterpriseContactForm: ({ trigger }: { trigger: ReactNode }) => <>{trigger}</>,
}));
vi.mock('@/components/partner/partner-contact', () => ({
  PartnerContactLinks: () => null,
  PartnerLogo: () => null,
}));
vi.mock('@/components/partner/territory-screen', () => ({ TerritoryDialog: () => null }));
vi.mock('@/components/app-icon', () => ({ AppIcon: () => null }));
vi.mock('@number-flow/react', () => ({
  default: ({ value }: { value: number }) => <span>{value}</span>,
}));
vi.mock('@weldsuite/i18n/client', () => ({ useTranslations: () => (key: string) => key }));
vi.mock('@/lib/i18n/provider', async () => {
  const { en } = await import('@weldsuite/i18n/locales/en');
  const { interpolate } = await import('@weldsuite/i18n/provider');
  return { useI18n: () => ({ t: en, language: 'en', format: interpolate }) };
});

import { en } from '@weldsuite/i18n/locales/en';
import { BillingSettingsSection } from './billing-settings-section';

const mollie = en.settings.billing.mollie;

const plan = (over: Record<string, unknown>) => ({
  id: 'plan_x',
  name: 'Plan',
  slug: 'plan',
  monthlyPrice: 0,
  currency: 'EUR',
  maxMembers: 10,
  isPerSeatPricing: true,
  emailsPerMonth: 1000,
  aiCreditsPerMonth: 100,
  isActive: true,
  displayOrder: 0,
  highlighted: false,
  requiresContact: false,
  hasApiAccess: true,
  ...over,
});

const PLANS = [
  plan({ id: 'plan_free', name: 'Free', slug: 'free', displayOrder: 0 }),
  plan({ id: 'plan_business', name: 'Business', slug: 'business', displayOrder: 1, monthlyPrice: 2900, yearlyPrice: 29000 }),
];

const SUBSCRIPTION = {
  id: 'sub_1',
  planId: 'plan_free',
  planName: 'Free',
  status: 'active',
  cycle: 'monthly',
  pricePerCycle: 0,
  purchasedSeats: 2,
  usedSeats: 2,
};

const UPGRADE = 'sweep.settings.billing.upgrade';
const CONTINUE = 'sweep.settings.billing.checkout.continueToCheckout';

async function openCheckout() {
  const user = userEvent.setup();
  render(<BillingSettingsSection />);
  const [upgrade] = await screen.findAllByRole('button', { name: UPGRADE });
  await user.click(upgrade);
  const confirm = await screen.findByRole('button', { name: CONTINUE });
  return { user, confirm };
}

describe('BillingSettingsSection (Mollie)', () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockReset();
    mocks.provider.mockReturnValue('mollie');
    mocks.get.mockResolvedValue({ data: { plans: PLANS, subscription: SUBSCRIPTION, partnerManaged: null } });
    mocks.saveSettings.mockResolvedValue({ data: {} });
    vi.stubGlobal('location', { href: 'https://app.test/settings/billing' });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('shows the excluding-VAT notes on the plans and in the checkout', async () => {
    const { user, confirm } = await openCheckout();

    // Plans view note, behind the dialog.
    expect(screen.getAllByText(mollie.excludingVat)).toHaveLength(1);
    expect(confirm).toBeEnabled();

    // Checkout dialog note, in the subtotal tooltip.
    const icon = document.querySelector('svg.lucide-info');
    expect(icon).not.toBeNull();
    await user.hover(icon as Element);
    await waitFor(() => expect(screen.getAllByText(mollie.excludingVat).length).toBeGreaterThan(1));
  });

  it('does not show the excluding-VAT note on Stripe', async () => {
    mocks.provider.mockReturnValue('stripe');
    render(<BillingSettingsSection />);
    await screen.findAllByRole('button', { name: UPGRADE });
    expect(screen.queryByText(mollie.excludingVat)).not.toBeInTheDocument();
  });

  it('goes to the hosted Mollie checkout', async () => {
    mocks.changePlan.mockResolvedValue({ success: true, url: 'https://www.mollie.com/checkout/x' });
    const { user, confirm } = await openCheckout();

    await user.click(confirm);

    await waitFor(() => expect(window.location.href).toBe('https://www.mollie.com/checkout/x'));
    expect(mocks.changePlan).toHaveBeenCalledWith({ planId: 'plan_business', seats: 2, cycle: 'yearly' });
  });

  it('announces a change that waits for the period end', async () => {
    mocks.changePlan.mockResolvedValue({ success: true, scheduled: true, effectiveAt: '2026-12-14T10:00:00Z' });
    const { user, confirm } = await openCheckout();

    await user.click(confirm);

    await waitFor(() =>
      expect(mocks.toastSuccess).toHaveBeenCalledWith(mollie.planScheduled.replace('{date}', '14th Dec 2026')),
    );
    // The page reloads the plans after a change.
    await waitFor(() => expect(mocks.get).toHaveBeenCalledTimes(2));
  });

  it('confirms a change that applies now', async () => {
    mocks.changePlan.mockResolvedValue({ success: true });
    const { user, confirm } = await openCheckout();

    await user.click(confirm);

    await waitFor(() =>
      expect(mocks.toastSuccess).toHaveBeenCalledWith('sweep.settings.billing.toasts.planChanged'),
    );
  });

  it('shows the error when the change is refused', async () => {
    mocks.changePlan.mockResolvedValue({ success: false });
    const { user, confirm } = await openCheckout();

    await user.click(confirm);

    expect(await screen.findByText('sweep.settings.billing.errors.changePlanFailed')).toBeInTheDocument();
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
  });

  it('shows the message of an unexpected failure', async () => {
    mocks.changePlan.mockRejectedValue(new Error('Mollie is down'));
    const { user, confirm } = await openCheckout();

    await user.click(confirm);

    expect(await screen.findByText('Mollie is down')).toBeInTheDocument();
  });

  it('asks for billing details first and retries the checkout once they are saved', async () => {
    mocks.changePlan
      .mockRejectedValueOnce(
        new ApiError('Billing details required', 400, {
          error: { code: 'BILLING_DETAILS_REQUIRED', message: 'Billing details required' },
        }),
      )
      .mockResolvedValueOnce({ success: true, url: 'https://www.mollie.com/checkout/retry' });
    const { user, confirm } = await openCheckout();

    await user.click(confirm);

    await waitFor(() => expect(mocks.toastInfo).toHaveBeenCalledWith(mollie.billingDetailsRequired));
    const save = await screen.findByRole('button', { name: en.settings.billing.updateBillingDetails });
    expect(mocks.changePlan).toHaveBeenCalledTimes(1);

    await user.click(save);

    await waitFor(() => expect(mocks.saveSettings).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(mocks.changePlan).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(window.location.href).toBe('https://www.mollie.com/checkout/retry'));
  });

  it('drops the checkout when the billing details dialog is closed unsaved', async () => {
    mocks.changePlan.mockRejectedValue(
      new ApiError('Billing details required', 400, { error: { code: 'BILLING_DETAILS_REQUIRED' } }),
    );
    const { user, confirm } = await openCheckout();

    await user.click(confirm);
    await screen.findByRole('button', { name: en.settings.billing.updateBillingDetails });
    await user.keyboard('{Escape}');

    await waitFor(() =>
      expect(screen.queryByRole('button', { name: en.settings.billing.updateBillingDetails })).not.toBeInTheDocument(),
    );
    expect(mocks.saveSettings).not.toHaveBeenCalled();
    expect(mocks.changePlan).toHaveBeenCalledTimes(1);
  });
});
