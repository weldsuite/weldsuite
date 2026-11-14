import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ApiError } from '@weldsuite/api-client';

const mocks = vi.hoisted(() => ({
  createSetupIntent: vi.fn(),
  removeMethod: vi.fn(),
  setDefault: vi.fn(),
  refetch: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  toastWarning: vi.fn(),
  loadStripe: vi.fn(),
}));

const methods = vi.hoisted(() => [
  { id: 'pm_1', type: 'creditcard', brand: 'visa', label: '•••• 4242 (Visa)', last4: '4242', isDefault: true, createdAt: '2026-09-01T00:00:00.000Z' },
  { id: 'pm_2', type: 'card', brand: 'mastercard', last4: '5555', isDefault: false, createdAt: '2026-09-02T00:00:00.000Z' },
]);

vi.mock('@/lib/edition', () => ({ billingProvider: () => 'mollie' }));
vi.mock('@/lib/runtime-config', () => ({ publicEnv: () => 'pk_test_123' }));
vi.mock('@stripe/stripe-js', () => ({ loadStripe: mocks.loadStripe }));
vi.mock('@stripe/react-stripe-js', () => ({
  Elements: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  PaymentElement: () => <div />,
  useStripe: () => null,
  useElements: () => null,
}));
vi.mock('sonner', () => ({
  toast: { success: mocks.toastSuccess, error: mocks.toastError, warning: mocks.toastWarning },
}));
vi.mock('@/hooks/queries/use-billing-queries', () => ({
  usePaymentMethods: () => ({ data: methods, isLoading: false, refetch: mocks.refetch }),
  useCreateSetupIntent: () => ({ mutateAsync: mocks.createSetupIntent, isPending: false }),
  useSetDefaultPaymentMethod: () => ({ mutateAsync: mocks.setDefault }),
  useRemovePaymentMethod: () => ({ mutateAsync: mocks.removeMethod }),
}));
vi.mock('@/hooks/use-theme', () => ({ useTheme: () => ({ resolvedTheme: 'light' }) }));
vi.mock('@/hooks/use-workspace-url', () => ({ useWorkspaceUrl: () => (path: string) => path }));
vi.mock('@/lib/i18n/provider', async () => {
  const { en } = await import('@weldsuite/i18n/locales/en');
  const { interpolate } = await import('@weldsuite/i18n/provider');
  return { useI18n: () => ({ t: en, language: 'en', format: interpolate }) };
});

import { en } from '@weldsuite/i18n/locales/en';
import { PaymentMethodsSection } from './payment-methods-section';

const ts = en.settings.billing.paymentMethods;

describe('PaymentMethodsSection (Mollie edition)', () => {
  const location = { href: 'http://localhost/settings/billing', search: '', pathname: '/settings/billing' };

  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockReset();
    location.href = 'http://localhost/settings/billing';
    vi.stubGlobal('location', location);
    vi.stubGlobal('confirm', () => true);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('adds the Mollie description and shows a masked label, else brand and last4', () => {
    render(<PaymentMethodsSection canManage />);

    expect(screen.getByText(new RegExp(ts.addDescriptionMollie.slice(0, 30)))).toBeInTheDocument();
    expect(screen.getByText('•••• 4242 (Visa)')).toBeInTheDocument();
    expect(screen.getByText('•••• 5555')).toBeInTheDocument();
    expect(screen.getByText('Mastercard')).toBeInTheDocument();
  });

  it('never loads Stripe.js under Mollie', () => {
    render(<PaymentMethodsSection canManage />);
    expect(mocks.loadStripe).not.toHaveBeenCalled();
  });

  it('goes to the hosted checkout to add a method', async () => {
    mocks.createSetupIntent.mockResolvedValue({ url: 'https://pay.mollie.test/mandate' });
    const user = userEvent.setup();
    render(<PaymentMethodsSection canManage />);

    await user.click(screen.getByRole('button', { name: ts.addMethod }));

    await waitFor(() => expect(location.href).toBe('https://pay.mollie.test/mandate'));
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it('reports a failure when the setup comes back without an address', async () => {
    mocks.createSetupIntent.mockResolvedValue({});
    const user = userEvent.setup();
    render(<PaymentMethodsSection canManage />);

    await user.click(screen.getByRole('button', { name: ts.addMethod }));

    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith(ts.addFailed));
  });

  it('reports a failure when the setup is rejected', async () => {
    mocks.createSetupIntent.mockRejectedValue(new Error('boom'));
    const user = userEvent.setup();
    render(<PaymentMethodsSection canManage />);

    await user.click(screen.getByRole('button', { name: ts.addMethod }));

    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith(ts.addFailed));
  });

  it("shows the server's message when the only mandate of a running plan is removed", async () => {
    mocks.removeMethod.mockRejectedValue(
      new ApiError('In use by the subscription', 409, {
        error: { code: 'MANDATE_IN_USE', message: 'In use by the subscription' },
      }),
    );
    const user = userEvent.setup();
    render(<PaymentMethodsSection canManage />);

    const triggers = screen.getAllByRole('button', { name: ts.rowActions });
    await user.click(triggers[0]);
    await user.click(await screen.findByRole('menuitem', { name: en.common.actions.remove }));

    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith('In use by the subscription'));
    expect(mocks.removeMethod).toHaveBeenCalledWith('pm_1');
  });
});
