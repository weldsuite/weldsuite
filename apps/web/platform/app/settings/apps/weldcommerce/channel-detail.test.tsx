import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { CommerceChannel } from '@/hooks/queries/use-commerce-channels-queries';

const env = vi.hoisted(() => ({
  query: { data: undefined as undefined | { data: unknown }, isPending: false, isError: false, refetch: vi.fn() },
}));

vi.mock('@/hooks/queries/use-commerce-channels-queries', () => ({ useCommerceChannel: () => env.query }));
vi.mock('./channel-keys-section', () => ({ ChannelKeysSection: () => <p>keys section</p> }));
vi.mock('./channel-shipping-section', () => ({ ChannelShippingSection: () => <p>shipping section</p> }));
vi.mock('./channel-dialog', () => ({ ChannelDialog: () => <p>channel dialog</p> }));

import { ChannelDetail } from './channel-detail';

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
  activeKeyCount: 1,
  createdAt: '2026-11-01T10:00:00Z',
  updatedAt: '2026-11-01T10:00:00Z',
  ...over,
});

function renderDetail(props: Partial<Parameters<typeof ChannelDetail>[0]> = {}) {
  const onBack = vi.fn();
  render(<ChannelDetail channelId="ch_1" onBack={onBack} canCreate canUpdate canDelete {...props} />);
  return { onBack, user: userEvent.setup() };
}

beforeEach(() => {
  env.query = { data: { data: channel() }, isPending: false, isError: false, refetch: vi.fn() };
});

describe('ChannelDetail', () => {
  it('summarises a storefront and shows its keys and shipping rates', () => {
    renderDetail();
    expect(screen.getByRole('heading', { name: 'Webshop' })).toBeTruthy();
    expect(screen.getByText('Netherlands, Belgium')).toBeTruthy();
    expect(screen.getByText('Include VAT')).toBeTruthy();
    expect(screen.getByText('keys section')).toBeTruthy();
    expect(screen.getByText('shipping section')).toBeTruthy();
  });

  it('says a manual channel has no keys or shipping rates', () => {
    env.query = { ...env.query, data: { data: channel({ type: 'manual' }) } };
    renderDetail();
    expect(screen.getByText('Only storefront channels have storefront keys and shipping rates.')).toBeTruthy();
    expect(screen.queryByText('keys section')).toBeNull();
  });

  it('goes back to the list', async () => {
    const { user, onBack } = renderDetail();
    await user.click(screen.getByRole('button', { name: 'All channels' }));
    expect(onBack).toHaveBeenCalled();
  });

  it('opens the edit dialog only for a member who may update', async () => {
    const { user } = renderDetail();
    await user.click(screen.getByRole('button', { name: 'Edit' }));
    expect(screen.getByText('channel dialog')).toBeTruthy();
  });

  it('hides Edit without update rights', () => {
    renderDetail({ canUpdate: false });
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
  });

  it('shows an error with a retry and a way back', async () => {
    env.query = { ...env.query, data: undefined, isError: true };
    const { user } = renderDetail();
    await user.click(screen.getByRole('button', { name: /retry|try again/i }));
    expect(env.query.refetch).toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'All channels' })).toBeTruthy();
  });
});
