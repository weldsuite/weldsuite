import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { CommerceSettings } from '@/hooks/queries/use-commerce-orders-queries';

const env = vi.hoisted(() => ({
  allowed: new Set<string>(['commerce_settings:read', 'commerce_settings:update']),
  available: true,
  access: { isInstalled: true, isLoading: false },
  settings: { data: undefined, isPending: false, isError: false, refetch: vi.fn() } as {
    data?: { data: CommerceSettings };
    isPending: boolean;
    isError: boolean;
    refetch: () => void;
  },
  update: vi.fn(),
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));

vi.mock('sonner', () => ({ toast }));
vi.mock('@weldsuite/permissions/react', () => ({
  usePermissionsMaybe: () => ({ can: (permission: string) => env.allowed.has(permission) }),
}));
vi.mock('@/lib/edition', () => ({ isFeatureAvailable: () => env.available }));
vi.mock('@/hooks/use-app-access', () => ({ useAppAccess: () => env.access }));
vi.mock('@/components/edition-unavailable-page', () => ({ EditionUnavailablePage: () => <p>not on this edition</p> }));
vi.mock('@/hooks/queries/use-commerce-orders-queries', () => ({
  useCommerceSettings: () => env.settings,
  useUpdateCommerceSettings: () => ({ mutateAsync: env.update, isPending: false }),
}));

import WeldCommerceSettingsPage from './page';

const stored: CommerceSettings = { orderNumberPrefix: 'WC-', nextOrderNumber: 1001, defaultCurrency: 'EUR' };

beforeEach(() => {
  env.allowed = new Set(['commerce_settings:read', 'commerce_settings:update']);
  env.available = true;
  env.access = { isInstalled: true, isLoading: false };
  env.settings = { data: { data: stored }, isPending: false, isError: false, refetch: vi.fn() };
  env.update.mockReset();
  env.update.mockImplementation(async (body: Partial<CommerceSettings>) => ({ data: { ...stored, ...body } }));
  toast.success.mockReset();
  toast.error.mockReset();
});

describe('WeldCommerceSettingsPage', () => {
  it('says the module is not available on an edition without it', () => {
    env.available = false;
    render(<WeldCommerceSettingsPage />);
    expect(screen.getByText('not on this edition')).toBeTruthy();
  });

  it('says so when WeldCommerce is not installed', () => {
    env.access = { isInstalled: false, isLoading: false };
    render(<WeldCommerceSettingsPage />);
    expect(screen.getByText('WeldCommerce is not installed in this workspace.')).toBeTruthy();
  });

  it('shows the stored prefix, next number and currency, and what the next order number will look like', () => {
    render(<WeldCommerceSettingsPage />);
    expect(screen.getByLabelText('Order number prefix')).toHaveProperty('value', 'WC-');
    expect(screen.getByLabelText('Next order number')).toHaveProperty('value', '1001');
    expect(screen.getByLabelText('Default currency')).toHaveProperty('value', 'EUR');
    expect(screen.getByText(/The next order gets WC-1001/)).toBeTruthy();
  });

  it('keeps Save off until something changed, and previews a changed prefix', async () => {
    const user = userEvent.setup();
    render(<WeldCommerceSettingsPage />);
    expect(screen.getByRole('button', { name: 'Save' })).toHaveProperty('disabled', true);
    await user.clear(screen.getByLabelText('Order number prefix'));
    await user.type(screen.getByLabelText('Order number prefix'), 'SO-');
    expect(screen.getByRole('button', { name: 'Save' })).toHaveProperty('disabled', false);
    expect(screen.getByText(/The next order gets SO-1001/)).toBeTruthy();
  });

  it('saves the changes and says so', async () => {
    const user = userEvent.setup();
    render(<WeldCommerceSettingsPage />);
    await user.clear(screen.getByLabelText('Order number prefix'));
    await user.type(screen.getByLabelText('Order number prefix'), 'SO-');
    await user.clear(screen.getByLabelText('Next order number'));
    await user.type(screen.getByLabelText('Next order number'), '2000');
    await user.clear(screen.getByLabelText('Default currency'));
    await user.type(screen.getByLabelText('Default currency'), 'usd');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(env.update).toHaveBeenCalled());
    expect(env.update).toHaveBeenCalledWith({ orderNumberPrefix: 'SO-', nextOrderNumber: 2000, defaultCurrency: 'USD' });
    expect(toast.success).toHaveBeenCalledWith('Settings saved');
  });

  it('refuses a currency that is not three letters, without saving', async () => {
    const user = userEvent.setup();
    render(<WeldCommerceSettingsPage />);
    await user.clear(screen.getByLabelText('Default currency'));
    await user.type(screen.getByLabelText('Default currency'), 'EU');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Enter a three-letter currency code.')).toBeTruthy();
    expect(env.update).not.toHaveBeenCalled();
  });

  it('wants a whole next number of 1 or more', async () => {
    const user = userEvent.setup();
    render(<WeldCommerceSettingsPage />);
    await user.clear(screen.getByLabelText('Next order number'));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Enter a whole number of 1 or more.')).toBeTruthy();
    expect(env.update).not.toHaveBeenCalled();
  });

  it('puts a number that would go backwards on the field, in words', async () => {
    env.update.mockRejectedValue({ status: 409, body: { error: { code: 'SEQUENCE_BACKWARDS', message: 'backwards', details: { current: 1500 } } } });
    const user = userEvent.setup();
    render(<WeldCommerceSettingsPage />);
    await user.clear(screen.getByLabelText('Next order number'));
    await user.type(screen.getByLabelText('Next order number'), '5');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('The next order number cannot be lower than the current one (1500).')).toBeTruthy();
    expect(screen.getByLabelText('Next order number').getAttribute('aria-invalid')).toBe('true');
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('shows another failure in a toast', async () => {
    env.update.mockRejectedValue(new Error('Server on fire'));
    const user = userEvent.setup();
    render(<WeldCommerceSettingsPage />);
    await user.type(screen.getByLabelText('Order number prefix'), 'X');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Server on fire'));
  });

  it('is read-only for a member who may read but not update', () => {
    env.allowed = new Set(['commerce_settings:read']);
    render(<WeldCommerceSettingsPage />);
    expect(screen.getByText('You can view these settings but not change them.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
    // Disabled by the fieldset around the form.
    expect(screen.getByLabelText('Order number prefix').matches(':disabled')).toBe(true);
  });

  it('shows an error with a retry when the settings cannot be loaded', async () => {
    env.settings = { isPending: false, isError: true, refetch: vi.fn() };
    const user = userEvent.setup();
    render(<WeldCommerceSettingsPage />);
    expect(screen.getByText('Could not load the WeldCommerce settings.')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: /retry|try again/i }));
    expect(env.settings.refetch).toHaveBeenCalled();
  });
});
