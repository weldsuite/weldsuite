import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const mocks = vi.hoisted(() => ({
  mutateAsync: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('sonner', () => ({ toast: { success: mocks.toastSuccess, error: mocks.toastError } }));
vi.mock('@/hooks/queries/use-settings-queries', () => ({
  useUpdateWorkspaceSettings: () => ({ mutateAsync: mocks.mutateAsync, isPending: false }),
}));
vi.mock('@weldsuite/i18n/client', () => ({ useTranslations: () => (key: string) => key }));
vi.mock('@/lib/i18n/provider', async () => {
  const { en } = await import('@weldsuite/i18n/locales/en');
  const { interpolate } = await import('@weldsuite/i18n/provider');
  return { useI18n: () => ({ t: en, language: 'en', format: interpolate }) };
});

import { BillingDetailsDialog } from './billing-details-dialog';
import { EMPTY_BILLING_DETAILS, type BillingDetails } from './billing-details';

const saved: BillingDetails = {
  email: 'billing@acme.nl',
  company: 'Acme B.V.',
  addressLine1: 'Keizersgracht 100',
  addressLine2: '',
  country: 'NL',
  city: 'Amsterdam',
  postalCode: '1015 AA',
  state: '',
  vatNumber: '',
};

function renderDialog(details: BillingDetails) {
  const onOpenChange = vi.fn();
  render(<BillingDetailsDialog open onOpenChange={onOpenChange} details={details} />);
  return { onOpenChange };
}

const submit = () => screen.getByRole('button', { name: 'Update billing details' });

describe('BillingDetailsDialog', () => {
  beforeEach(() => {
    mocks.mutateAsync.mockReset().mockResolvedValue({ data: {} });
    mocks.toastSuccess.mockReset();
    mocks.toastError.mockReset();
  });

  it('does not submit an empty form and names every required field', async () => {
    const user = userEvent.setup();
    renderDialog(EMPTY_BILLING_DETAILS);

    await user.click(submit());

    expect(await screen.findByText('Valid email is required')).toBeInTheDocument();
    expect(screen.getByText('Company name is required')).toBeInTheDocument();
    expect(screen.getByText('Address is required')).toBeInTheDocument();
    expect(screen.getByText('Country is required')).toBeInTheDocument();
    expect(screen.getByText('City is required')).toBeInTheDocument();
    expect(screen.getByText('Postal code is required')).toBeInTheDocument();
    expect(mocks.mutateAsync).not.toHaveBeenCalled();
  });

  it('rejects a malformed email and a VAT number that does not fit the country', async () => {
    const user = userEvent.setup();
    renderDialog({ ...saved, email: 'not-an-email', vatNumber: 'NOT A VAT!!' });

    await user.click(submit());

    expect(await screen.findByText('Valid email is required')).toBeInTheDocument();
    expect(screen.getByText('Not a valid VAT number for NL. Example: NL123456789B01')).toBeInTheDocument();
    expect(mocks.mutateAsync).not.toHaveBeenCalled();
  });

  it('saves the flat billing fields and closes', async () => {
    const user = userEvent.setup();
    const { onOpenChange } = renderDialog(saved);

    await user.type(screen.getByLabelText(/VAT number/), 'NL123456789B01');
    await user.click(submit());

    await waitFor(() => expect(mocks.mutateAsync).toHaveBeenCalledTimes(1));
    expect(mocks.mutateAsync).toHaveBeenCalledWith({
      email: 'billing@acme.nl',
      legalName: 'Acme B.V.',
      addressLine1: 'Keizersgracht 100',
      addressLine2: null,
      country: 'NL',
      city: 'Amsterdam',
      postalCode: '1015 AA',
      state: null,
      vatNumber: 'NL123456789B01',
    });
    expect(mocks.toastSuccess).toHaveBeenCalledWith('Billing details updated');
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('drops unsaved edits: reopening starts from the saved details again', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    const { rerender } = render(<BillingDetailsDialog open onOpenChange={onOpenChange} details={saved} />);

    const company = screen.getByLabelText(/Company name/);
    await user.clear(company);
    await user.type(company, 'Something else');
    expect(company).toHaveValue('Something else');

    rerender(<BillingDetailsDialog open={false} onOpenChange={onOpenChange} details={saved} />);
    rerender(<BillingDetailsDialog open onOpenChange={onOpenChange} details={saved} />);

    expect(await screen.findByLabelText(/Company name/)).toHaveValue('Acme B.V.');
    expect(mocks.mutateAsync).not.toHaveBeenCalled();
  });
});
