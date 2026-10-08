import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { en } from '@weldsuite/i18n/locales/en';

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), delete: vi.fn() }));
vi.mock('@/lib/api/weldbooks-client', () => ({ weldbooksApi: api, setWeldbooksEntityId: vi.fn() }));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, search, params, children }: { to: string; search?: Record<string, string>; params?: Record<string, string>; children: React.ReactNode }) => {
    const path = params ? Object.entries(params).reduce((acc, [key, value]) => acc.replace(`$${key}`, value), to) : to;
    return <a href={search ? `${path}?${new URLSearchParams(search).toString()}` : path}>{children}</a>;
  },
}));

import { RegistrationCheck } from './registration-check';
import { AddressCheck, addressInput } from './address-check';
import { makeSettings, renderWithProviders } from '../setup/test-support';

const tr = en.weldbooksUs.salesTax.setup.engine.registrations;
const ta = en.weldbooksUs.salesTax.setup.engine.address;
const stripe = makeSettings({ engine: 'stripe_tax', hasCredentials: true });
const avalara = makeSettings({ engine: 'avalara', hasCredentials: true, config: { companyCode: 'WELD', environment: 'sandbox' } });

beforeEach(() => {
  api.post.mockReset();
});

describe('RegistrationCheck', () => {
  it('tells a manual entity there is nothing to compare, with no button', () => {
    renderWithProviders(<RegistrationCheck settings={makeSettings()} canRun />);
    expect(screen.getByText(tr.manual)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: tr.run })).not.toBeInTheDocument();
  });

  it('does not offer the check to a member who cannot update', () => {
    renderWithProviders(<RegistrationCheck settings={stripe} canRun={false} />);
    expect(screen.queryByRole('button', { name: tr.run })).not.toBeInTheDocument();
  });

  it('compares the provider with the agencies and offers to create the ones missing here', async () => {
    const user = userEvent.setup();
    api.post.mockResolvedValue({
      data: {
        engine: 'stripe_tax',
        matched: [{ agencyId: 'sta_tx', stateCode: 'TX', name: 'Texas Comptroller', providerRef: 'taxreg_tx' }],
        missingInProvider: [{ agencyId: 'sta_wa', stateCode: 'WA', name: 'Washington DOR' }],
        missingInWeldBooks: [{ stateCode: 'CA', providerRef: 'taxreg_ca' }],
        inSync: false,
      },
    });
    renderWithProviders(<RegistrationCheck settings={stripe} canRun />);

    await user.click(screen.getByRole('button', { name: tr.run }));

    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/sales-tax/registration-check'));
    const result = await screen.findByTestId('registration-result');
    expect(result).toHaveTextContent('Your agencies and the registrations at Stripe Tax differ.');

    const missingHere = within(screen.getByRole('region', { name: 'Registered at Stripe Tax, missing here' }));
    expect(missingHere.getByText(/California \(CA\)/)).toBeInTheDocument();
    expect(missingHere.getByText('taxreg_ca')).toBeInTheDocument();
    expect(missingHere.getByRole('link', { name: tr.createAgency })).toHaveAttribute(
      'href',
      '/weldbooks/sales-tax/agencies/new?state=CA',
    );

    const missingThere = within(screen.getByRole('region', { name: 'Registered here, missing at Stripe Tax' }));
    expect(missingThere.getByText(/Washington \(WA\)/)).toBeInTheDocument();
    expect(missingThere.getByRole('link', { name: tr.openAgency })).toHaveAttribute('href', '/weldbooks/sales-tax/agencies/sta_wa');
    expect(screen.getByText('Stripe Tax will not calculate tax for these states. Add the registration there.')).toBeInTheDocument();

    const matched = within(screen.getByRole('region', { name: tr.matched }));
    expect(matched.getByText('taxreg_tx')).toBeInTheDocument();
  });

  it('says the registrations match when they do, without empty tables', async () => {
    const user = userEvent.setup();
    api.post.mockResolvedValue({
      data: {
        engine: 'avalara',
        matched: [{ agencyId: 'sta_tx', stateCode: 'TX', name: 'Texas Comptroller', providerRef: null }],
        missingInProvider: [],
        missingInWeldBooks: [],
        inSync: true,
      },
    });
    renderWithProviders(<RegistrationCheck settings={avalara} canRun />);
    await user.click(screen.getByRole('button', { name: tr.run }));

    expect(await screen.findByText('Your agencies and the registrations at Avalara AvaTax match.')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: /missing/ })).not.toBeInTheDocument();
  });

  it('shows the server sentence when the check fails', async () => {
    const user = userEvent.setup();
    api.post.mockRejectedValue(new Error('Stripe rejected the API key'));
    renderWithProviders(<RegistrationCheck settings={stripe} canRun />);
    await user.click(screen.getByRole('button', { name: tr.run }));
    expect(await screen.findByText('Stripe rejected the API key')).toBeInTheDocument();
  });
});

describe('AddressCheck', () => {
  it('is only for Avalara', () => {
    renderWithProviders(<AddressCheck settings={stripe} />);
    expect(screen.getByText(ta.unavailable)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: ta.validate })).not.toBeInTheDocument();
  });

  it('builds the address without the fields left blank', () => {
    expect(addressInput({ line1: ' 100 Congress Ave ', city: '', state: 'tx', postalCode: ' 78701 ' })).toEqual({
      country: 'US',
      line1: '100 Congress Ave',
      state: 'TX',
      postalCode: '78701',
    });
  });

  it('sends the address and shows how Avalara read it', async () => {
    const user = userEvent.setup();
    api.post.mockResolvedValue({
      data: {
        engine: 'avalara',
        valid: true,
        normalized: { line1: '100 Congress Ave', city: 'Austin', state: 'TX', postalCode: '78701-3984' },
        messages: ['Address was normalized'],
      },
    });
    renderWithProviders(<AddressCheck settings={avalara} />);

    expect(screen.getByRole('button', { name: ta.validate })).toBeDisabled();
    await user.type(screen.getByLabelText(ta.line1), '100 congress');
    await user.type(screen.getByLabelText(ta.city), 'Austin');
    await user.type(screen.getByLabelText(ta.state), 'tx');
    await user.type(screen.getByLabelText(ta.postalCode), '78701');
    await user.click(screen.getByRole('button', { name: ta.validate }));

    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
    expect(api.post).toHaveBeenCalledWith('/sales-tax/validate-address', {
      address: { country: 'US', line1: '100 congress', city: 'Austin', state: 'TX', postalCode: '78701' },
    });
    const result = await screen.findByTestId('address-result');
    expect(result).toHaveTextContent(ta.valid);
    expect(result).toHaveTextContent('100 Congress Ave, Austin, TX 78701-3984');
    expect(result).toHaveTextContent('Address was normalized');
  });

  it('says when Avalara cannot match the address', async () => {
    const user = userEvent.setup();
    api.post.mockResolvedValue({ data: { engine: 'avalara', valid: false, messages: ['The address could not be resolved'] } });
    renderWithProviders(<AddressCheck settings={avalara} />);

    await user.type(screen.getByLabelText(ta.line1), '1 Nowhere Rd');
    await user.click(screen.getByRole('button', { name: ta.validate }));

    expect(await screen.findByText(ta.invalid)).toBeInTheDocument();
    expect(screen.getByText('The address could not be resolved')).toBeInTheDocument();
  });
});
