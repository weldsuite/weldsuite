import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { PaymentConnection } from '@/hooks/queries/use-commerce-payments-queries';

const env = vi.hoisted(() => ({
  allowed: new Set<string>(['commerce_settings:read', 'commerce_settings:update']),
  connection: { data: undefined, isPending: false, isError: false, refetch: vi.fn() } as {
    data?: { data: unknown; meta?: { oauthAvailable?: boolean } };
    isPending: boolean;
    isError: boolean;
    refetch: () => void;
  },
  profiles: { data: { data: [] as unknown[] }, isPending: false, isError: false } as {
    data?: { data: unknown[] };
    isPending: boolean;
    isError: boolean;
  },
  authorize: vi.fn(),
  update: vi.fn(),
  disconnect: vi.fn(),
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
const assign = vi.hoisted(() => vi.fn());

vi.mock('sonner', () => ({ toast }));
vi.mock('@weldsuite/permissions/react', () => ({
  usePermissionsMaybe: () => ({ can: (permission: string) => env.allowed.has(permission) }),
}));
vi.mock('@/hooks/queries/use-commerce-payments-queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/hooks/queries/use-commerce-payments-queries')>()),
  usePaymentConnection: () => env.connection,
  useMollieProfiles: () => env.profiles,
  useAuthorizeMollie: () => ({ mutateAsync: env.authorize, isPending: false }),
  useUpdatePaymentConnection: () => ({ mutateAsync: env.update, isPending: false }),
  useDisconnectPayments: () => ({ mutateAsync: env.disconnect, isPending: false }),
}));
vi.mock('./mollie-key-dialog', () => ({
  MollieKeyDialog: () => <div role="dialog">key dialog</div>,
}));

import { PaymentsTab } from './payments-tab';

const connection = (over: Partial<PaymentConnection> = {}): PaymentConnection => ({
  id: 'pc_1',
  provider: 'mollie',
  authMethod: 'oauth',
  status: 'connected',
  testmode: false,
  profileId: 'pfl_1',
  profileName: 'Webshop',
  organizationId: 'org_1',
  organizationName: 'Acme BV',
  connectedAt: '2026-11-20T10:00:00.000Z',
  lastError: null,
  oauthAvailable: true,
  ...over,
});

function give(data: unknown, meta?: { oauthAvailable?: boolean }) {
  env.connection = { data: { data, meta }, isPending: false, isError: false, refetch: vi.fn() };
}

const noop = () => undefined;

// Radix Select reads pointer capture and scrolls the chosen option into view; jsdom has neither.
beforeAll(() => {
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.setPointerCapture ??= () => undefined;
  Element.prototype.releasePointerCapture ??= () => undefined;
  Element.prototype.scrollIntoView ??= () => undefined;
});

beforeEach(() => {
  env.allowed = new Set(['commerce_settings:read', 'commerce_settings:update']);
  give(null, { oauthAvailable: true });
  env.profiles = { data: { data: [{ id: 'pfl_1', name: 'Webshop', website: 'https://shop.example', mode: 'live' }, { id: 'pfl_2', name: 'Outlet', website: null, mode: 'live' }] }, isPending: false, isError: false };
  env.authorize.mockReset();
  env.update.mockReset();
  env.update.mockResolvedValue({ data: {} });
  env.disconnect.mockReset();
  env.disconnect.mockResolvedValue(undefined);
  toast.success.mockReset();
  toast.error.mockReset();
  assign.mockReset();
  Object.defineProperty(window, 'location', { configurable: true, value: { ...window.location, assign } });
});

describe('PaymentsTab states', () => {
  it('says so without read access', () => {
    env.allowed = new Set();
    render(<PaymentsTab onCallbackHandled={noop} />);
    expect(screen.getByText('You do not have access to the payment settings.')).toBeTruthy();
  });

  it('shows a loader, and an error with a retry', async () => {
    env.connection = { isPending: true, isError: false, refetch: vi.fn() };
    const { rerender } = render(<PaymentsTab onCallbackHandled={noop} />);
    expect(screen.queryByText('Mollie is not connected')).toBeNull();
    env.connection = { isPending: false, isError: true, refetch: vi.fn() };
    rerender(<PaymentsTab onCallbackHandled={noop} />);
    expect(screen.getByText('Could not load the Mollie connection.')).toBeTruthy();
    await userEvent.setup().click(screen.getByRole('button', { name: /retry|try again/i }));
    expect(env.connection.refetch).toHaveBeenCalled();
  });
});

describe('not connected', () => {
  it('offers Connect with Mollie and an API key', () => {
    render(<PaymentsTab onCallbackHandled={noop} />);
    expect(screen.getByText('Mollie is not connected')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Connect with Mollie' })).toHaveProperty('disabled', false);
    expect(screen.getByRole('button', { name: 'Use an API key' })).toBeTruthy();
  });

  it('disables Connect with Mollie and says why when the install has no Mollie Connect app', () => {
    give(null, { oauthAvailable: false });
    render(<PaymentsTab onCallbackHandled={noop} />);
    const button = screen.getByRole('button', { name: 'Connect with Mollie' });
    expect(button).toHaveProperty('disabled', true);
    expect(button.getAttribute('aria-describedby')).toBe('mollie-oauth-unavailable');
    expect(screen.getByText(/not set up on this installation/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Use an API key' })).toHaveProperty('disabled', false);
  });

  it('sends the member to the Mollie address the API returned', async () => {
    env.authorize.mockResolvedValue({ data: { url: 'https://my.mollie.com/oauth2/authorize?state=s' } });
    const user = userEvent.setup();
    render(<PaymentsTab onCallbackHandled={noop} />);
    await user.click(screen.getByRole('button', { name: 'Connect with Mollie' }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('https://my.mollie.com/oauth2/authorize?state=s'));
    expect(screen.getByRole('button', { name: 'Opening Mollie…' })).toHaveProperty('disabled', true);
  });

  it('does not follow an address that is not https', async () => {
    env.authorize.mockResolvedValue({ data: { url: 'javascript:alert(1)' } });
    const user = userEvent.setup();
    render(<PaymentsTab onCallbackHandled={noop} />);
    await user.click(screen.getByRole('button', { name: 'Connect with Mollie' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Mollie sent an address we cannot open. Please try again.'));
    expect(assign).not.toHaveBeenCalled();
  });

  it('words a failed authorize', async () => {
    env.authorize.mockRejectedValue({ status: 409, body: { error: { code: 'MOLLIE_CONNECT_NOT_CONFIGURED', message: 'x' } } });
    const user = userEvent.setup();
    render(<PaymentsTab onCallbackHandled={noop} />);
    await user.click(screen.getByRole('button', { name: 'Connect with Mollie' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('not set up on this installation')));
  });

  it('opens the API key dialog', async () => {
    const user = userEvent.setup();
    render(<PaymentsTab onCallbackHandled={noop} />);
    await user.click(screen.getByRole('button', { name: 'Use an API key' }));
    expect(screen.getByText('key dialog')).toBeTruthy();
  });

  it('shows no connect buttons to a member who may not update', () => {
    env.allowed = new Set(['commerce_settings:read']);
    render(<PaymentsTab onCallbackHandled={noop} />);
    expect(screen.queryByRole('button', { name: 'Connect with Mollie' })).toBeNull();
    expect(screen.getByText('You can view the Mollie connection but not change it.')).toBeTruthy();
  });

  it('treats a disconnected connection like no connection', () => {
    give(connection({ status: 'disconnected' }));
    render(<PaymentsTab onCallbackHandled={noop} />);
    expect(screen.getByText('Mollie is not connected')).toBeTruthy();
  });
});

describe('connected with Mollie Connect', () => {
  beforeEach(() => give(connection()));

  it('shows the status, the organisation, the profile and a live badge', () => {
    render(<PaymentsTab onCallbackHandled={noop} />);
    expect(screen.getByText('Connected')).toBeTruthy();
    expect(screen.getByText('Live')).toBeTruthy();
    expect(screen.queryByText('TEST MODE')).toBeNull();
    expect(screen.getByText('Acme BV')).toBeTruthy();
    expect(screen.getByText('Connected with Mollie')).toBeTruthy();
  });

  it('shows a clear TEST MODE badge in test mode', () => {
    give(connection({ testmode: true }));
    render(<PaymentsTab onCallbackHandled={noop} />);
    expect(screen.getByText('TEST MODE')).toBeTruthy();
    expect(screen.getByText(/payments are not real/)).toBeTruthy();
  });

  it('switches test mode', async () => {
    const user = userEvent.setup();
    render(<PaymentsTab onCallbackHandled={noop} />);
    await user.click(screen.getByRole('switch', { name: 'Test mode' }));
    expect(env.update).toHaveBeenCalledWith({ testmode: true });
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Test mode is on'));
  });

  it('changes the profile', async () => {
    const user = userEvent.setup();
    render(<PaymentsTab onCallbackHandled={noop} />);
    await user.click(screen.getByRole('combobox', { name: 'Mollie profile' }));
    await user.click(await screen.findByRole('option', { name: 'Outlet' }));
    expect(env.update).toHaveBeenCalledWith({ profileId: 'pfl_2' });
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Mollie profile changed'));
  });

  it('words a refused change', async () => {
    env.update.mockRejectedValue({ status: 409, body: { error: { code: 'TESTMODE_FIXED', message: 'x' } } });
    const user = userEvent.setup();
    render(<PaymentsTab onCallbackHandled={noop} />);
    await user.click(screen.getByRole('switch', { name: 'Test mode' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('The test mode of an API key follows the key.'));
  });

  it('disconnects after a confirmation', async () => {
    const user = userEvent.setup();
    render(<PaymentsTab onCallbackHandled={noop} />);
    await user.click(screen.getByRole('button', { name: 'Disconnect' }));
    expect(env.disconnect).not.toHaveBeenCalled();
    expect(screen.getByText('Disconnect Mollie?')).toBeTruthy();
    await user.click(screen.getAllByRole('button', { name: 'Disconnect' }).at(-1) as HTMLElement);
    await waitFor(() => expect(env.disconnect).toHaveBeenCalled());
    expect(toast.success).toHaveBeenCalledWith('Mollie disconnected');
  });

  it('is read-only for a member who may not update', () => {
    env.allowed = new Set(['commerce_settings:read']);
    render(<PaymentsTab onCallbackHandled={noop} />);
    expect(screen.getByRole('switch', { name: 'Test mode' })).toHaveProperty('disabled', true);
    expect(screen.queryByRole('button', { name: 'Disconnect' })).toBeNull();
    expect(screen.getByText('You can view the Mollie connection but not change it.')).toBeTruthy();
  });
});

describe('connected with an API key', () => {
  it('fixes test mode to the key and explains it', () => {
    give(connection({ authMethod: 'api_key', testmode: true, profileId: null }));
    render(<PaymentsTab onCallbackHandled={noop} />);
    const toggle = screen.getByRole('switch', { name: 'Test mode' });
    expect(toggle).toHaveProperty('disabled', true);
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    expect(screen.getByText(/follows the key/)).toBeTruthy();
    expect(screen.queryByRole('combobox', { name: 'Mollie profile' })).toBeNull();
  });

  it('can replace the key', async () => {
    give(connection({ authMethod: 'api_key' }));
    const user = userEvent.setup();
    render(<PaymentsTab onCallbackHandled={noop} />);
    await user.click(screen.getByRole('button', { name: 'Replace the API key' }));
    expect(screen.getByText('key dialog')).toBeTruthy();
  });
});

describe('needs_reauth', () => {
  it('says Mollie needs a reconnect, with the last error, and offers it', async () => {
    give(connection({ status: 'needs_reauth', lastError: 'invalid_grant' }));
    env.authorize.mockResolvedValue({ data: { url: 'https://my.mollie.com/oauth2/authorize' } });
    const user = userEvent.setup();
    render(<PaymentsTab onCallbackHandled={noop} />);
    expect(screen.getByText('Reconnect needed')).toBeTruthy();
    expect(screen.getByText('Mollie needs you to reconnect')).toBeTruthy();
    expect(screen.getByText('Last error: invalid_grant')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Reconnect with Mollie' }));
    await waitFor(() => expect(assign).toHaveBeenCalled());
  });
});

describe('the Mollie callback', () => {
  it('shows a connected result once and asks for the query string to be cleaned', async () => {
    give(connection());
    const handled = vi.fn();
    const { rerender } = render(<PaymentsTab callback={{ mollie: 'connected' }} onCallbackHandled={handled} />);
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Mollie is connected'));
    expect(handled).toHaveBeenCalledTimes(1);
    expect(screen.getAllByText('Mollie is connected').length).toBeGreaterThan(0);
    rerender(<PaymentsTab callback={{ mollie: 'connected' }} onCallbackHandled={handled} />);
    expect(toast.success).toHaveBeenCalledTimes(1);
  });

  it('shows the reason of an error in a toast and a banner', async () => {
    const handled = vi.fn();
    render(<PaymentsTab callback={{ mollie: 'error', reason: 'access_denied' }} onCallbackHandled={handled} />);
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Mollie could not be connected: access_denied'));
    expect(screen.getByRole('alert').textContent).toContain('access_denied');
    expect(handled).toHaveBeenCalled();
  });

  it('shows a generic error without a reason', async () => {
    render(<PaymentsTab callback={{ mollie: 'error' }} onCallbackHandled={noop} />);
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Mollie could not be connected'));
  });

  it('does nothing without a callback', () => {
    const handled = vi.fn();
    render(<PaymentsTab callback={{}} onCallbackHandled={handled} />);
    expect(handled).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
  });
});
