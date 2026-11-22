import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { CommerceChannel, ShippingRate } from '@/hooks/queries/use-commerce-channels-queries';

const env = vi.hoisted(() => ({
  rates: { data: { data: [] as unknown[] }, isPending: false, isError: false, refetch: vi.fn() },
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  reorder: vi.fn(),
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));

vi.mock('sonner', () => ({ toast }));
vi.mock('@/hooks/queries/use-commerce-channels-queries', () => ({
  useShippingRates: () => env.rates,
  useCreateShippingRate: () => ({ mutateAsync: env.create }),
  useUpdateShippingRate: () => ({ mutateAsync: env.update }),
  useDeleteShippingRate: () => ({ mutateAsync: env.remove }),
  useReorderShippingRates: () => ({ mutateAsync: env.reorder, isPending: false }),
}));

import { ChannelShippingSection } from './channel-shipping-section';

const channel: CommerceChannel = {
  id: 'ch_1',
  name: 'Shop',
  type: 'storefront',
  audience: 'b2c',
  status: 'active',
  currency: 'EUR',
  pricesIncludeTax: true,
  sellingCountries: ['NL', 'BE'],
  guestCheckout: true,
  paymentMethods: ['mollie'],
  connectionId: null,
  activeKeyCount: 1,
  createdAt: '2026-11-01T10:00:00Z',
  updatedAt: '2026-11-01T10:00:00Z',
};

const rate = (id: string, position: number, over: Partial<ShippingRate> = {}): ShippingRate => ({
  id,
  channelId: 'ch_1',
  zoneName: `Zone ${id}`,
  countries: ['NL'],
  name: `Rate ${id}`,
  price: '4.95',
  currency: 'EUR',
  freeShippingThreshold: null,
  position,
  active: true,
  ...over,
});

function renderSection(props: Partial<Parameters<typeof ChannelShippingSection>[0]> = {}) {
  return render(<ChannelShippingSection channel={channel} canCreate canUpdate canDelete {...props} />);
}

beforeEach(() => {
  // Out of order on purpose: the list sorts by position.
  env.rates = { data: { data: [rate('b', 2), rate('a', 1, { freeShippingThreshold: '50.00' })] }, isPending: false, isError: false, refetch: vi.fn() };
  for (const fn of [env.create, env.update, env.remove, env.reorder]) fn.mockReset();
  env.reorder.mockResolvedValue(undefined);
  toast.success.mockReset();
  toast.error.mockReset();
});

describe('ChannelShippingSection', () => {
  it('lists the rates by position with their price and free-shipping threshold', () => {
    renderSection();
    const rows = screen.getAllByRole('row').slice(1);
    expect(within(rows[0]).getByText('Zone a')).toBeTruthy();
    expect(within(rows[1]).getByText('Zone b')).toBeTruthy();
    expect(within(rows[0]).getAllByText(/4\.95/).length).toBeGreaterThan(0);
    expect(within(rows[0]).getByText(/50\.00/)).toBeTruthy();
  });

  it('moves a rate down with a button, sends the whole order and announces it once', async () => {
    const user = userEvent.setup();
    renderSection();
    await user.click(screen.getByRole('button', { name: 'Move Zone a, Rate a down' }));
    await waitFor(() => expect(env.reorder).toHaveBeenCalledWith({ channelId: 'ch_1', ids: ['b', 'a'] }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Zone a, Rate a moved to position 2 of 2'));
  });

  it('cannot move the first rate up or the last one down', () => {
    renderSection();
    expect(screen.getByRole('button', { name: 'Move Zone a, Rate a up' })).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: 'Move Zone b, Rate b down' })).toHaveProperty('disabled', true);
  });

  it('shows a failed reorder in a toast', async () => {
    env.reorder.mockRejectedValue(new Error('Server on fire'));
    const user = userEvent.setup();
    renderSection();
    await user.click(screen.getByRole('button', { name: 'Move Zone a, Rate a down' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Server on fire'));
  });

  it('deletes a rate after a confirmation', async () => {
    env.remove.mockResolvedValue(undefined);
    const user = userEvent.setup();
    renderSection();
    await user.click(screen.getByRole('button', { name: 'Delete Zone a, Rate a' }));
    expect(env.remove).not.toHaveBeenCalled();
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(env.remove).toHaveBeenCalledWith({ channelId: 'ch_1', rateId: 'a' }));
    expect(toast.success).toHaveBeenCalledWith('Shipping rate deleted');
  });

  it('adds a rate, with countries limited to the ones the channel sells in', async () => {
    env.create.mockResolvedValue({ data: { id: 'c' } });
    const user = userEvent.setup();
    renderSection();
    await user.click(screen.getByRole('button', { name: 'New rate' }));
    await user.type(screen.getByLabelText('Zone'), 'Benelux');
    await user.type(screen.getByLabelText('Rate name'), 'Standard');
    await user.type(screen.getByLabelText(/^Price/), '4.9');
    await user.click(screen.getByRole('combobox', { name: /Countries/ }));
    expect(await screen.findByText('Belgium')).toBeTruthy();
    expect(screen.queryByText('France')).toBeNull();
    await user.click(screen.getByText('Belgium'));
    await user.keyboard('{Escape}');
    await user.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() =>
      expect(env.create).toHaveBeenCalledWith({
        channelId: 'ch_1',
        data: { zoneName: 'Benelux', countries: ['BE'], name: 'Standard', price: '4.90', freeShippingThreshold: null, active: true },
      }),
    );
  });

  it('refuses a rate without countries or a valid price', async () => {
    const user = userEvent.setup();
    renderSection();
    await user.click(screen.getByRole('button', { name: 'New rate' }));
    await user.type(screen.getByLabelText('Zone'), 'Benelux');
    await user.type(screen.getByLabelText('Rate name'), 'Standard');
    await user.type(screen.getByLabelText(/^Price/), 'abc');
    await user.click(screen.getByRole('button', { name: 'Create' }));
    expect(await screen.findByText('Choose at least one country.')).toBeTruthy();
    expect(screen.getByText('Enter an amount such as 4.95.')).toBeTruthy();
    expect(env.create).not.toHaveBeenCalled();
  });

  it('is read-only without write rights', () => {
    renderSection({ canCreate: false, canUpdate: false, canDelete: false });
    expect(screen.queryByRole('button', { name: 'New rate' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Move/ })).toBeNull();
  });

  it('shows an empty state, and a retryable error', async () => {
    env.rates = { ...env.rates, data: { data: [] } };
    const { unmount } = renderSection();
    expect(screen.getByText('No shipping rates yet')).toBeTruthy();
    unmount();
    env.rates = { ...env.rates, isError: true };
    const user = userEvent.setup();
    renderSection();
    await user.click(screen.getByRole('button', { name: /retry|try again/i }));
    expect(env.rates.refetch).toHaveBeenCalled();
  });
});
