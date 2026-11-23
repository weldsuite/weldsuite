import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const mocks = vi.hoisted(() => ({
  createSetupIntent: vi.fn(),
  toastError: vi.fn(),
  can: vi.fn((_permission: string) => true),
  provider: 'mollie' as 'mollie' | 'stripe',
  pathname: '/crm/companies',
  subscription: null as unknown,
}));

vi.mock('@/lib/edition', () => ({ billingProvider: () => mocks.provider }));
vi.mock('@/lib/router', () => ({ usePathname: () => mocks.pathname }));
vi.mock('@weldsuite/permissions/react', () => ({ usePermissions: () => ({ can: mocks.can }) }));
vi.mock('sonner', () => ({ toast: { error: mocks.toastError } }));
vi.mock('@/hooks/queries/use-billing-queries', () => ({
  useSubscription: () => ({ data: mocks.subscription }),
  useCreateSetupIntent: () => ({ mutateAsync: mocks.createSetupIntent, isPending: false }),
}));
vi.mock('@/lib/i18n/provider', async () => {
  const { en } = await import('@weldsuite/i18n/locales/en');
  const { interpolate } = await import('@weldsuite/i18n/provider');
  return { useI18n: () => ({ t: en, language: 'en', format: interpolate }) };
});

import { en } from '@weldsuite/i18n/locales/en';
import {
  formatDueDate,
  PaymentMethodNeededBanner,
  PaymentMethodNeededNotice,
} from './payment-method-needed-banner';

const ts = en.settings.billing.mollie;
const upcoming = { dueAt: '2026-12-14T10:00:00.000Z', pastDue: false };
const pastDue = { dueAt: '2026-12-28T10:30:00.000Z', pastDue: true };
const payUrl = 'https://app.weldsuite.eu/public/billing/pay/tok';

describe('PaymentMethodNeededBanner', () => {
  const location = { href: 'http://localhost/settings/billing' };

  beforeEach(() => {
    mocks.createSetupIntent.mockReset();
    mocks.toastError.mockReset();
    location.href = 'http://localhost/settings/billing';
    vi.stubGlobal('location', location);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('writes the date as the emails do, per language', () => {
    expect(formatDueDate(upcoming.dueAt, 'en')).toBe('14 December 2026');
    expect(formatDueDate(upcoming.dueAt, 'nl')).toBe('14 december 2026');
  });

  it('asks for a payment method before the renewal', () => {
    render(<PaymentMethodNeededBanner required={upcoming} planName="Business" payUrl={payUrl} />);
    const banner = screen.getByTestId('payment-method-needed-banner');
    expect(banner).toHaveTextContent('Add a payment method before 14 December 2026');
    expect(banner).toHaveTextContent('Your Business plan renews on 14 December 2026');
    expect(screen.getByRole('button', { name: ts.addPaymentMethod })).toBeInTheDocument();
    // Nothing is open yet, so there is nothing to pay.
    expect(screen.queryByRole('link', { name: ts.payNow })).not.toBeInTheDocument();
  });

  it('after a refused renewal, says until when the plan keeps working and offers paying too', () => {
    render(<PaymentMethodNeededBanner required={pastDue} planName="Business" payUrl={payUrl} />);
    const banner = screen.getByTestId('payment-method-needed-banner');
    expect(banner).toHaveTextContent(ts.methodNeededPastDueTitle);
    expect(banner).toHaveTextContent('Add one before 28 December 2026 to keep Business');
    expect(screen.getByRole('link', { name: ts.payNow })).toHaveAttribute('href', payUrl);
  });

  it('starts the Mollie checkout that saves a payment method', async () => {
    mocks.createSetupIntent.mockResolvedValue({ url: 'https://www.mollie.com/checkout/tr_1' });
    render(<PaymentMethodNeededBanner required={upcoming} planName="Business" />);
    await userEvent.click(screen.getByRole('button', { name: ts.addPaymentMethod }));
    await waitFor(() => expect(location.href).toBe('https://www.mollie.com/checkout/tr_1'));
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it('says so when the checkout could not start', async () => {
    mocks.createSetupIntent.mockRejectedValue(new Error('down'));
    render(<PaymentMethodNeededBanner required={upcoming} planName="Business" />);
    await userEvent.click(screen.getByRole('button', { name: ts.addPaymentMethod }));
    await waitFor(() =>
      expect(mocks.toastError).toHaveBeenCalledWith(en.settings.billing.paymentMethods.addFailed),
    );
    expect(location.href).toBe('http://localhost/settings/billing');
  });
});

describe('PaymentMethodNeededNotice (app shell)', () => {
  beforeEach(() => {
    mocks.provider = 'mollie';
    mocks.pathname = '/crm/companies';
    mocks.can.mockReset();
    mocks.can.mockReturnValue(true);
    mocks.subscription = { planName: 'Business', paymentMethodRequired: upcoming, outstanding: null };
    window.sessionStorage.clear();
  });

  it('shows billing managers what is needed and by when', () => {
    render(<PaymentMethodNeededNotice />);
    expect(screen.getByTestId('payment-method-needed-banner')).toHaveTextContent(
      'Add a payment method before 14 December 2026',
    );
    expect(mocks.can).toHaveBeenCalledWith('billing:manage');
  });

  it('shows nothing when no payment method is needed', () => {
    mocks.subscription = { planName: 'Business', paymentMethodRequired: null };
    render(<PaymentMethodNeededNotice />);
    expect(screen.queryByTestId('payment-method-needed-banner')).toBeNull();
  });

  it('shows nothing to members who cannot manage billing', () => {
    mocks.can.mockReturnValue(false);
    render(<PaymentMethodNeededNotice />);
    expect(screen.queryByTestId('payment-method-needed-banner')).toBeNull();
  });

  it('shows nothing on the Stripe edition', () => {
    mocks.provider = 'stripe';
    render(<PaymentMethodNeededNotice />);
    expect(screen.queryByTestId('payment-method-needed-banner')).toBeNull();
  });

  it('leaves the billing page to its own notice', () => {
    mocks.pathname = '/w/org_1/settings/billing';
    render(<PaymentMethodNeededNotice />);
    expect(screen.queryByTestId('payment-method-needed-banner')).toBeNull();
  });

  it('stays dismissed for the session until the renewal is refused', async () => {
    const { unmount } = render(<PaymentMethodNeededNotice />);
    await userEvent.click(screen.getByRole('button', { name: /dismiss/i }));
    expect(screen.queryByTestId('payment-method-needed-banner')).toBeNull();
    unmount();

    render(<PaymentMethodNeededNotice />);
    expect(screen.queryByTestId('payment-method-needed-banner')).toBeNull();

    mocks.subscription = {
      planName: 'Business',
      paymentMethodRequired: pastDue,
      outstanding: { amount: 9075, currency: 'EUR', payUrl, since: '2026-12-14T10:30:00.000Z' },
    };
    render(<PaymentMethodNeededNotice />);
    expect(screen.getByTestId('payment-method-needed-banner')).toHaveTextContent(ts.methodNeededPastDueTitle);
    expect(screen.getByRole('link', { name: ts.payNow })).toHaveAttribute('href', payUrl);
  });
});
