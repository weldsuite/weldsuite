import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nProvider } from '@weldsuite/i18n/provider';
import type { ReachBillingSummary } from '@weldsuite/app-api-client/schemas/reach';

const billing = vi.hoisted(() => ({ data: undefined as ReachBillingSummary | null | undefined }));
const navigate = vi.hoisted(() => vi.fn());
vi.mock('@/hooks/queries/use-reach-queries', () => ({
  useReachBilling: () => ({ data: billing.data, isPending: false, isError: false, refetch: vi.fn() }),
}));
vi.mock('@weldsuite/permissions/react', () => ({ usePermissions: () => ({ can: () => true }) }));
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => navigate, useSearch: () => ({}) }));
vi.mock('../components/use-payment-method-setup', () => ({
  REACH_SETTINGS_PATH: '/settings/apps/weldreach',
  usePaymentMethodSetup: () => ({ start: vi.fn(), isPending: false }),
}));

import { setRuntimeConfig } from '@/lib/runtime-config';
import { BillingSection } from './billing-section';

const summary = (over: Partial<ReachBillingSummary>): ReachBillingSummary => ({
  status: 'active',
  hasPaymentMethod: true,
  inboxCount: 2,
  unitAmountCents: 800,
  currency: 'eur',
  currentPeriodEnd: '2026-12-14T10:00:00.000Z',
  ...over,
});

function renderSection() {
  render(
    <I18nProvider initialLanguage="en">
      <BillingSection />
    </I18nProvider>,
  );
}

beforeEach(() => navigate.mockReset());
afterEach(() => {
  cleanup();
  setRuntimeConfig(null);
});

describe('WeldReach billing section', () => {
  it('says inboxes are on the plan where plans are billed through Mollie', () => {
    setRuntimeConfig({ backend: 'rust', billingProvider: 'mollie', unavailableFeatures: [] });
    billing.data = summary({});
    renderSection();
    expect(screen.getByText("Mailboxes are added to your plan's monthly charge. Amounts exclude VAT.")).toBeInTheDocument();
    expect(screen.queryByText('Your mailboxes are paused')).not.toBeInTheDocument();
  });

  it('says the mailboxes are paused once the plan ended, with the way to the plans', async () => {
    setRuntimeConfig({ backend: 'rust', billingProvider: 'mollie', unavailableFeatures: [] });
    billing.data = summary({ status: 'canceled', hasPaymentMethod: false, currentPeriodEnd: null });
    renderSection();
    expect(screen.getByText('Your mailboxes are paused')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'See plans' }));
    expect(navigate).toHaveBeenCalledWith({ to: '/settings/plans' });
  });

  it('keeps the Stripe wording on Global, and no paused banner there', () => {
    billing.data = summary({ status: 'canceled', currency: 'usd' });
    renderSection();
    expect(screen.getByText('Mailboxes are billed monthly to your payment method.')).toBeInTheDocument();
    expect(screen.queryByText('Your mailboxes are paused')).not.toBeInTheDocument();
  });

  it('shows nothing where billing is off', () => {
    billing.data = null;
    renderSection();
    expect(screen.queryByText('Billing')).not.toBeInTheDocument();
  });
});
