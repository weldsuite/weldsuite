import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { CommerceChannel } from '@/hooks/queries/use-commerce-channels-queries';

const env = vi.hoisted(() => ({
  allowed: new Set<string>(),
  channels: { data: { data: [] as unknown[] }, isPending: false, isError: false, refetch: vi.fn() },
  create: vi.fn(),
  update: vi.fn(),
  archive: vi.fn(),
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));

vi.mock('sonner', () => ({ toast }));
vi.mock('@weldsuite/permissions/react', () => ({
  usePermissionsMaybe: () => ({ can: (permission: string) => env.allowed.has(permission) }),
}));
vi.mock('@/hooks/queries/use-commerce-orders-queries', () => ({
  useCommerceSettings: () => ({ data: { data: { defaultCurrency: 'EUR' } } }),
}));
vi.mock('@/hooks/queries/use-commerce-channels-queries', () => ({
  useCommerceChannels: () => env.channels,
  useCreateCommerceChannel: () => ({ mutateAsync: env.create }),
  useUpdateCommerceChannel: () => ({ mutateAsync: env.update }),
  useDeleteCommerceChannel: () => ({ mutateAsync: env.archive }),
}));
vi.mock('./channel-detail', () => ({ ChannelDetail: ({ channelId }: { channelId: string }) => <p>detail of {channelId}</p> }));

import { ChannelsTab } from './channels-tab';

const channel = (over: Partial<CommerceChannel> = {}): CommerceChannel => ({
  id: 'ch_1',
  name: 'Webshop',
  type: 'storefront',
  audience: 'b2c',
  status: 'active',
  currency: 'EUR',
  pricesIncludeTax: true,
  sellingCountries: ['NL', 'BE'],
  guestCheckout: true,
  paymentMethods: ['mollie'],
  connectionId: null,
  activeKeyCount: 2,
  createdAt: '2026-11-01T10:00:00Z',
  updatedAt: '2026-11-01T10:00:00Z',
  ...over,
});

// Radix Select reads pointer capture and scrolls the chosen option into view; jsdom has neither.
beforeAll(() => {
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.setPointerCapture ??= () => undefined;
  Element.prototype.releasePointerCapture ??= () => undefined;
  Element.prototype.scrollIntoView ??= () => undefined;
});

beforeEach(() => {
  env.allowed = new Set(['commerce_channels:read', 'commerce_channels:create', 'commerce_channels:update', 'commerce_channels:delete']);
  env.channels = { data: { data: [channel()] }, isPending: false, isError: false, refetch: vi.fn() };
  for (const fn of [env.create, env.update, env.archive]) fn.mockReset();
  toast.success.mockReset();
  toast.error.mockReset();
});

describe('ChannelsTab', () => {
  it('lists the channels with type, audience, status, currency, countries and active keys', () => {
    render(<ChannelsTab onOpenChannel={vi.fn()} />);
    const row = screen.getAllByRole('row')[1];
    for (const text of ['Webshop', 'Storefront', 'Consumers (B2C)', 'Active', 'EUR', '2 countries', '2']) {
      expect(within(row).getByText(text)).toBeTruthy();
    }
  });

  it('opens a channel from its name', async () => {
    const onOpen = vi.fn();
    const user = userEvent.setup();
    render(<ChannelsTab onOpenChannel={onOpen} />);
    await user.click(screen.getByRole('button', { name: 'Webshop' }));
    expect(onOpen).toHaveBeenCalledWith('ch_1');
  });

  it('shows the detail of the open channel', () => {
    render(<ChannelsTab channelId="ch_9" onOpenChannel={vi.fn()} />);
    expect(screen.getByText('detail of ch_9')).toBeTruthy();
  });

  it('says so without read access', () => {
    env.allowed = new Set();
    render(<ChannelsTab onOpenChannel={vi.fn()} />);
    expect(screen.getByText('You do not have access to the sales channels.')).toBeTruthy();
  });

  it('hides create, edit and archive from a member who may only read', () => {
    env.allowed = new Set(['commerce_channels:read']);
    render(<ChannelsTab onOpenChannel={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'New channel' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Edit Webshop' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Archive Webshop' })).toBeNull();
  });

  it('shows an empty state with a create button, and an error with a retry', async () => {
    env.channels = { ...env.channels, data: { data: [] } };
    const { unmount } = render(<ChannelsTab onOpenChannel={vi.fn()} />);
    expect(screen.getByText('No channels yet')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'New channel' })).toBeTruthy();
    unmount();
    env.channels = { ...env.channels, isError: true };
    const user = userEvent.setup();
    render(<ChannelsTab onOpenChannel={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: /retry|try again/i }));
    expect(env.channels.refetch).toHaveBeenCalled();
  });

  it('archives after a confirmation', async () => {
    env.archive.mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(<ChannelsTab onOpenChannel={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'Archive Webshop' }));
    expect(env.archive).not.toHaveBeenCalled();
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Archive' }));
    await waitFor(() => expect(env.archive).toHaveBeenCalledWith('ch_1'));
    expect(toast.success).toHaveBeenCalledWith('Channel archived');
  });

  it('creates a channel in the default currency, with VAT in the prices, and opens it', async () => {
    env.create.mockResolvedValue({ data: { id: 'ch_new' } });
    const onOpen = vi.fn();
    const user = userEvent.setup();
    render(<ChannelsTab onOpenChannel={onOpen} />);
    await user.click(screen.getByRole('button', { name: 'New channel' }));
    expect(screen.getByLabelText('Currency')).toHaveProperty('value', 'EUR');
    expect(screen.getByRole('switch', { name: 'Prices include VAT' }).getAttribute('aria-checked')).toBe('true');
    await user.type(screen.getByLabelText('Name'), 'Shop NL');
    await user.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() =>
      expect(env.create).toHaveBeenCalledWith({
        name: 'Shop NL',
        type: 'storefront',
        audience: 'b2c',
        status: 'draft',
        currency: 'EUR',
        pricesIncludeTax: true,
        sellingCountries: [],
        guestCheckout: true,
        paymentMethods: ['mollie'],
      }),
    );
    await waitFor(() => expect(onOpen).toHaveBeenCalledWith('ch_new'));
  });

  it('turns VAT off with a business audience, offers invoice only then', async () => {
    const user = userEvent.setup();
    render(<ChannelsTab onOpenChannel={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'New channel' }));
    expect(screen.getByRole('checkbox', { name: /Pay on invoice/ })).toHaveProperty('disabled', true);
    await user.click(screen.getByRole('combobox', { name: 'Audience' }));
    await user.click(await screen.findByRole('option', { name: 'Businesses (B2B)' }));
    expect(screen.getByRole('switch', { name: 'Prices include VAT' }).getAttribute('aria-checked')).toBe('false');
    expect(screen.getByRole('checkbox', { name: /Pay on invoice/ })).toHaveProperty('disabled', false);
  });

  it('lists what an incomplete active storefront is missing', async () => {
    env.create.mockRejectedValue({
      status: 409,
      body: { error: { code: 'CHANNEL_INCOMPLETE', message: 'incomplete', details: { missing: ['sellingCountries'] } } },
    });
    const user = userEvent.setup();
    render(<ChannelsTab onOpenChannel={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'New channel' }));
    await user.type(screen.getByLabelText('Name'), 'Shop');
    await user.click(screen.getByRole('button', { name: 'Create' }));
    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText('At least one selling country')).toBeTruthy();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('puts a locked currency on the currency field', async () => {
    env.update.mockRejectedValue({ status: 409, body: { error: { code: 'CURRENCY_LOCKED', message: 'locked' } } });
    const user = userEvent.setup();
    render(<ChannelsTab onOpenChannel={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'Edit Webshop' }));
    await user.clear(screen.getByLabelText('Currency'));
    await user.type(screen.getByLabelText('Currency'), 'usd');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('The currency cannot change once the channel has orders.')).toBeTruthy();
    expect(screen.getByLabelText('Currency').getAttribute('aria-invalid')).toBe('true');
  });

  it('shows another failure in a toast', async () => {
    env.create.mockRejectedValue(new Error('Server on fire'));
    const user = userEvent.setup();
    render(<ChannelsTab onOpenChannel={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'New channel' }));
    await user.type(screen.getByLabelText('Name'), 'Shop');
    await user.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Server on fire'));
  });

  it('lets a connector channel change only its name and status', async () => {
    env.channels = { ...env.channels, data: { data: [channel({ id: 'ch_s', name: 'Shopify NL', type: 'shopify' })] } };
    env.update.mockResolvedValue({ data: {} });
    const user = userEvent.setup();
    render(<ChannelsTab onOpenChannel={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'Edit Shopify NL' }));
    expect(screen.queryByLabelText('Currency')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(env.update).toHaveBeenCalledWith({ id: 'ch_s', data: { name: 'Shopify NL', status: 'active' } }));
  });
});
