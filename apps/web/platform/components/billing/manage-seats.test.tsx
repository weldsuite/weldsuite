import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const mocks = vi.hoisted(() => ({
  updateSeats: vi.fn(),
  seatPrice: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('sonner', () => ({ toast: { success: mocks.toastSuccess, error: mocks.toastError } }));
vi.mock('@/hooks/queries/use-billing-queries', () => ({
  useSeatPrice: () => ({ data: mocks.seatPrice() }),
  useUpdateSeats: () => ({ mutateAsync: mocks.updateSeats, isPending: false }),
}));
vi.mock('@weldsuite/i18n/client', () => ({ useTranslations: () => (key: string) => key }));
vi.mock('@/lib/i18n/provider', async () => {
  const { en } = await import('@weldsuite/i18n/locales/en');
  const { interpolate } = await import('@weldsuite/i18n/provider');
  return { useI18n: () => ({ t: en, language: 'en', format: interpolate }) };
});

import { ManageSeatsAction } from './manage-seats';

const SUBSCRIPTION = { planName: 'Starter', purchasedSeats: 2, cycle: 'yearly' };
const LIMITS = {
  planId: 'plan_starter',
  planName: 'Starter',
  maxMembers: 10,
  purchasedSeats: 2,
  emailsPerMonth: 0,
  aiCreditsPerMonth: 0,
  monthlyCredits: 0,
  currentUsage: { memberCount: 2, emailsSentThisMonth: 0, aiCreditsUsedThisMonth: 0, creditsBalance: 0, creditsMonthlyAllocation: 0 },
};

async function addOneSeat() {
  const user = userEvent.setup();
  render(<ManageSeatsAction subscription={SUBSCRIPTION} planLimits={LIMITS} />);
  await user.click(screen.getByRole('button', { name: 'sweep.settings.billing.manageSeatsButton' }));
  const dialog = await screen.findByRole('dialog');
  const [, plus] = within(dialog).getAllByRole('button').filter((b) => b.textContent === '');
  await user.click(plus);
  await user.click(within(dialog).getByRole('button', { name: 'sweep.settings.billing.updateSeats' }));
  return dialog;
}

describe('ManageSeatsAction', () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockReset();
    vi.stubGlobal('location', { href: 'https://app.test/settings/billing' });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends the customer to pay for added seats when the mandate cannot be charged', async () => {
    mocks.updateSeats.mockResolvedValue({ success: true, purchasedSeats: 2, paymentUrl: 'https://www.mollie.com/checkout/seats' });
    await addOneSeat();

    await waitFor(() => expect(window.location.href).toBe('https://www.mollie.com/checkout/seats'));
    expect(mocks.updateSeats).toHaveBeenCalledWith({ seats: 3 });
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
  });

  it('shows why a seat change was refused', async () => {
    mocks.updateSeats.mockRejectedValue(new Error('No active subscription'));
    await addOneSeat();

    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith('No active subscription'));
  });

  it('prices a yearly seat as its monthly equivalent', async () => {
    mocks.seatPrice.mockReturnValue({ amount: 12000, currency: 'EUR', interval: 'year' });
    const user = userEvent.setup();
    render(<ManageSeatsAction subscription={SUBSCRIPTION} planLimits={LIMITS} />);
    await user.click(screen.getByRole('button', { name: 'sweep.settings.billing.manageSeatsButton' }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('€10', { exact: false })).toBeInTheDocument();
    expect(within(dialog).getByText('€20/sweep.settings.billing.monthBilledAnnually')).toBeInTheDocument();
  });

  it('stops at the plan’s maximum', async () => {
    const user = userEvent.setup();
    render(<ManageSeatsAction subscription={{ ...SUBSCRIPTION, purchasedSeats: 10 }} planLimits={LIMITS} />);
    await user.click(screen.getByRole('button', { name: 'sweep.settings.billing.manageSeatsButton' }));

    const dialog = await screen.findByRole('dialog');
    const [, plus] = within(dialog).getAllByRole('button').filter((b) => b.textContent === '');
    expect(plus).toBeDisabled();
  });
});
