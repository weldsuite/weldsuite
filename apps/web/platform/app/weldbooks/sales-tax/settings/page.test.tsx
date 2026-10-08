import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { en } from '@weldsuite/i18n/locales/en';

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), delete: vi.fn() }));
vi.mock('@/lib/api/weldbooks-client', () => ({ weldbooksApi: api, setWeldbooksEntityId: vi.fn() }));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, params, children, ...rest }: { to: string; params?: Record<string, string>; children: React.ReactNode; className?: string }) => (
    <a href={params ? Object.entries(params).reduce((acc, [key, value]) => acc.replace(`$${key}`, value), to) : to} className={rest.className}>
      {children}
    </a>
  ),
}));
const permissions = vi.hoisted(() => ({ allowed: new Set<string>() }));
vi.mock('@weldsuite/permissions/react', () => ({
  usePermissions: () => ({ can: (permission: string) => permissions.allowed.has(permission) }),
}));
const jurisdiction = vi.hoisted(() => ({ salesTax: true }));
vi.mock('@/lib/weldbooks/use-jurisdiction', () => ({
  useCurrentJurisdiction: () => ({ features: { salesTax: jurisdiction.salesTax }, isResolved: true, isError: false }),
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

import SalesTaxEngineSettingsPage from './page';
import { installPointerPolyfills, makeSettings, renderWithProviders } from '../setup/test-support';

const te = en.weldbooksUs.salesTax.setup.engine;

beforeAll(installPointerPolyfills);

beforeEach(() => {
  api.get.mockReset();
  jurisdiction.salesTax = true;
  permissions.allowed = new Set(['taxes:read', 'taxes:update']);
});

describe('SalesTaxEngineSettingsPage', () => {
  it('shows the engine choice with the manual warning, the registration check and the registered states', async () => {
    api.get.mockResolvedValue({
      data: makeSettings({
        agencies: [
          {
            id: 'sta_tx',
            stateCode: 'TX',
            level: 'state',
            name: 'Texas Comptroller',
            status: 'registered',
            registeredFrom: '2026-01-01',
            registeredUntil: null,
            providerRegistrationRef: null,
          },
        ],
        registeredStates: ['TX'],
      }),
    });
    renderWithProviders(<SalesTaxEngineSettingsPage />);

    expect(await screen.findByRole('heading', { name: te.title })).toBeInTheDocument();
    expect(await screen.findByTestId('manual-warning')).toBeInTheDocument();
    expect(screen.getByText(te.registrations.title)).toBeInTheDocument();
    expect(screen.getByText(te.address.unavailable)).toBeInTheDocument();
    const state = screen.getByRole('link', { name: /Texas/ });
    expect(state).toHaveAttribute('href', '/weldbooks/sales-tax/agencies/sta_tx');
  });

  it('says plainly that the manual engine is the user\'s responsibility and that multi-state sellers need a provider', async () => {
    api.get.mockResolvedValue({ data: makeSettings() });
    renderWithProviders(<SalesTaxEngineSettingsPage />);

    const warning = await screen.findByTestId('manual-warning');
    expect(warning).toHaveTextContent('the rates are your responsibility');
    expect(warning).toHaveTextContent('If you sell in many states, use Stripe Tax or Avalara');
  });

  it('shows the address check and the registration check for Avalara', async () => {
    api.get.mockResolvedValue({ data: makeSettings({ engine: 'avalara', hasCredentials: true, config: { companyCode: 'WELD', environment: 'sandbox' } }) });
    renderWithProviders(<SalesTaxEngineSettingsPage />);

    expect(await screen.findByRole('button', { name: te.registrations.run })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: te.address.validate })).toBeInTheDocument();
  });

  it('is read-only for a member who cannot update', async () => {
    permissions.allowed = new Set(['taxes:read']);
    api.get.mockResolvedValue({ data: makeSettings({ engine: 'stripe_tax', hasCredentials: true }) });
    renderWithProviders(<SalesTaxEngineSettingsPage />);

    await screen.findByTestId('credentials-stored');
    expect(screen.queryByRole('button', { name: te.save })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: te.registrations.run })).not.toBeInTheDocument();
    expect(screen.getAllByRole('radio').every((radio) => radio.hasAttribute('disabled'))).toBe(true);
  });

  it('offers to try again when the settings cannot be loaded', async () => {
    const user = userEvent.setup();
    api.get.mockRejectedValueOnce(new Error('boom'));
    renderWithProviders(<SalesTaxEngineSettingsPage />);

    expect(await screen.findByText(te.loadError)).toBeInTheDocument();
    api.get.mockResolvedValue({ data: makeSettings() });
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByTestId('manual-warning')).toBeInTheDocument();
  });

  it('is only for a US entity', () => {
    jurisdiction.salesTax = false;
    renderWithProviders(<SalesTaxEngineSettingsPage />);
    expect(screen.getByText(en.weldbooksUs.salesTax.setup.common.usOnly)).toBeInTheDocument();
    expect(api.get).not.toHaveBeenCalled();
  });
});
