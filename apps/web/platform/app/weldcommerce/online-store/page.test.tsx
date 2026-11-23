import type { ReactNode } from 'react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { CommerceChannel } from '@/hooks/queries/use-commerce-channels-queries';
import type { OnlineStoreSite } from '@/hooks/queries/use-online-store-queries';

const env = vi.hoisted(() => ({
  allowed: new Set<string>(),
  sites: { data: { data: [] as unknown[] }, isPending: false, isError: false, refetch: vi.fn() },
  channels: { data: { data: [] as unknown[] }, isPending: false, isError: false, refetch: vi.fn() },
  create: vi.fn(),
  publish: vi.fn(),
  push: vi.fn(),
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));

vi.mock('sonner', () => ({ toast }));
vi.mock('@weldsuite/permissions/react', () => ({
  usePermissionsMaybe: () => ({ can: (permission: string) => env.allowed.has(permission), isLoading: false }),
}));
vi.mock('@/hooks/queries/use-online-store-queries', () => ({
  useOnlineStoreSites: () => env.sites,
  useCreateOnlineStoreSite: () => ({ mutateAsync: env.create }),
  usePublishSite: () => ({ mutateAsync: env.publish }),
  onlineStoreErrorCode: (err: { body?: { error?: { code?: string } } }) => err?.body?.error?.code,
}));
vi.mock('@/hooks/queries/use-commerce-channels-queries', () => ({ useCommerceChannels: () => env.channels }));
vi.mock('@/lib/router', () => ({
  Link: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
  useRouter: () => ({ push: env.push }),
}));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, search, children, onClick, ...rest }: { to: string; search?: Record<string, string>; children: ReactNode; onClick?: () => void }) => (
    <a
      href={`${to}?${new URLSearchParams(search).toString()}`}
      onClick={(event) => {
        event.preventDefault();
        onClick?.();
      }}
      {...rest}
    >
      {children}
    </a>
  ),
}));

import OnlineStorePage, { storeCards } from './page';

const channel = (over: Partial<CommerceChannel> = {}): CommerceChannel =>
  ({
    id: 'ch_1',
    name: 'Webshop',
    type: 'storefront',
    audience: 'b2c',
    status: 'active',
    currency: 'EUR',
    ...over,
  }) as CommerceChannel;

const site = (over: Partial<OnlineStoreSite> = {}): OnlineStoreSite => ({
  id: 'sfs_1',
  channelId: 'ch_1',
  channelName: 'Webshop',
  channelStatus: 'active',
  mode: 'builder',
  locale: 'nl',
  theme: 'atelier',
  visibility: 'live',
  hasPassword: false,
  draftRevision: 3,
  draftUpdatedAt: '2026-11-20T10:00:00Z',
  publishedVersionId: 'sfv_2',
  publishedVersionNumber: 2,
  publishedAt: '2026-11-20T10:00:00Z',
  hasUnpublishedChanges: true,
  activeDeploymentId: null,
  primaryHost: 'webshop.weldshop.eu',
  previewHost: 'webshop.weldshop.eu',
  createdAt: '2026-11-01T10:00:00Z',
  updatedAt: '2026-11-20T10:00:00Z',
  ...over,
});

// Radix reads pointer capture; jsdom has none.
beforeAll(() => {
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.setPointerCapture ??= () => undefined;
  Element.prototype.releasePointerCapture ??= () => undefined;
  Element.prototype.scrollIntoView ??= () => undefined;
});

beforeEach(() => {
  env.allowed = new Set(['websites:read', 'commerce_channels:read']);
  env.sites = { data: { data: [] }, isPending: false, isError: false, refetch: vi.fn() };
  env.channels = { data: { data: [] }, isPending: false, isError: false, refetch: vi.fn() };
  for (const fn of [env.create, env.publish, env.push, toast.success, toast.error]) fn.mockReset();
});

describe('storeCards', () => {
  it('has a card per native, not archived storefront channel and per store, by name', () => {
    const cards = storeCards(
      [
        channel({ id: 'ch_b', name: 'B2B portal' }),
        channel({ id: 'ch_m', name: 'Phone orders', type: 'manual' }),
        channel({ id: 'ch_s', name: 'Shopify', type: 'shopify' }),
        channel({ id: 'ch_x', name: 'Old shop', status: 'archived' }),
        channel({ id: 'ch_1', name: 'Webshop' }),
      ],
      [site({ channelId: 'ch_1' }), site({ id: 'sfs_9', channelId: 'ch_hidden', channelName: 'Another shop' })],
    );
    expect(cards.map((card) => [card.channelId, card.site?.id ?? null])).toEqual([
      ['ch_hidden', 'sfs_9'],
      ['ch_b', null],
      ['ch_1', 'sfs_1'],
    ]);
  });
});

describe('OnlineStorePage', () => {
  it('says there is no access without websites:read', () => {
    env.allowed = new Set();
    render(<OnlineStorePage />);
    expect(screen.getByText('You do not have access to the online store.')).toBeTruthy();
  });

  it('points to the channel settings when there is no storefront channel', () => {
    render(<OnlineStorePage />);
    expect(screen.getByText('No storefront channels yet')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Set up a channel' }).getAttribute('href')).toBe('/settings/apps/weldcommerce?tab=channels');
  });

  it('shows an error with a retry when the stores cannot be loaded', async () => {
    env.sites = { ...env.sites, isError: true };
    const user = userEvent.setup();
    render(<OnlineStorePage />);
    await user.click(screen.getByRole('button', { name: /try again/i }));
    expect(env.sites.refetch).toHaveBeenCalled();
  });

  it('shows a built store: what is published, unpublished changes, visibility, its address and where to edit it', () => {
    env.channels = { ...env.channels, data: { data: [channel()] } };
    env.sites = { ...env.sites, data: { data: [site()] } };
    render(<OnlineStorePage />);
    expect(screen.getByText(/Version 2, published/)).toBeTruthy();
    expect(screen.getByText('Unpublished changes')).toBeTruthy();
    expect(screen.getByText('Live')).toBeTruthy();
    expect(screen.getByText('Dutch')).toBeTruthy();
    const address = screen.getByRole('link', { name: 'Open webshop.weldshop.eu in a new tab' });
    expect(address.getAttribute('href')).toBe('https://webshop.weldshop.eu');
    expect(address.getAttribute('target')).toBe('_blank');
    expect(screen.getByRole('link', { name: 'Edit the online store of Webshop' }).getAttribute('href')).toBe('/weldcommerce/online-store/sfs_1/editor');
    expect(screen.getByRole('link', { name: 'Pages' }).getAttribute('href')).toBe('/weldcommerce/online-store/sfs_1/pages');
    expect(screen.getByRole('link', { name: 'Menus' }).getAttribute('href')).toBe('/weldcommerce/online-store/sfs_1/menus');
    expect(screen.getByRole('link', { name: 'Redirects' }).getAttribute('href')).toBe('/weldcommerce/online-store/sfs_1/redirects');
    // Publishing needs websites:manage.
    expect(screen.queryByRole('button', { name: 'Publish' })).toBeNull();
  });

  it('links to Settings for domains and to claim an address, remembering where to come back to', async () => {
    env.sites = { ...env.sites, data: { data: [site({ primaryHost: null })] } };
    const user = userEvent.setup();
    render(<OnlineStorePage />);
    expect(screen.getByText(/No address yet/)).toBeTruthy();
    const claim = screen.getByRole('link', { name: 'Claim an address' });
    expect(claim.getAttribute('href')).toBe('/settings/apps/weldcommerce?tab=online-store&site=sfs_1');
    expect(screen.getByRole('link', { name: 'Domains and visibility' }).getAttribute('href')).toBe('/settings/apps/weldcommerce?tab=online-store');
    await user.click(claim);
    expect(sessionStorage.getItem('settings-return-url')).toBe(window.location.pathname);
  });

  it('shows a store built with your own code with its deployments in Settings, without the editor', () => {
    env.sites = { ...env.sites, data: { data: [site({ mode: 'static', hasUnpublishedChanges: false })] } };
    env.allowed.add('websites:manage');
    render(<OnlineStorePage />);
    expect(screen.getByText('Your own code')).toBeTruthy();
    expect(screen.queryByRole('link', { name: /Edit the online store/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Publish' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Deployments' }).getAttribute('href')).toBe('/settings/apps/weldcommerce?tab=online-store&site=sfs_1');
  });

  it('publishes with a note for a member who manages the store', async () => {
    env.sites = { ...env.sites, data: { data: [site()] } };
    env.allowed.add('websites:manage');
    env.publish.mockResolvedValue({ data: { id: 'sfv_3', number: 3 } });
    const user = userEvent.setup();
    render(<OnlineStorePage />);
    await user.click(screen.getByRole('button', { name: 'Publish' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Note (optional)'), 'Spring sale');
    await user.click(within(dialog).getByRole('button', { name: 'Publish' }));
    await waitFor(() => expect(env.publish).toHaveBeenCalledWith({ siteId: 'sfs_1', note: 'Spring sale' }));
    expect(toast.success).toHaveBeenCalledWith('Published as version 3');
  });

  it('creates a store for a channel without one and opens the editor', async () => {
    env.channels = { ...env.channels, data: { data: [channel()] } };
    env.allowed.add('websites:create');
    env.create.mockResolvedValue({ data: site({ id: 'sfs_new', mode: 'builder' }) });
    const user = userEvent.setup();
    render(<OnlineStorePage />);
    expect(screen.getByText('No online store yet')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Create online store' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByLabelText('German'));
    await user.click(within(dialog).getByRole('button', { name: 'Create online store' }));
    await waitFor(() => expect(env.create).toHaveBeenCalledWith({ channelId: 'ch_1', mode: 'builder', locale: 'de' }));
    expect(env.push).toHaveBeenCalledWith('/weldcommerce/online-store/sfs_new/editor');
  });

  it('says so when the channel already has a store, and offers no create button without websites:create', async () => {
    env.channels = { ...env.channels, data: { data: [channel()] } };
    const { unmount } = render(<OnlineStorePage />);
    expect(screen.queryByRole('button', { name: 'Create online store' })).toBeNull();
    unmount();

    env.allowed.add('websites:create');
    env.create.mockRejectedValue({ status: 409, body: { error: { code: 'SITE_EXISTS' } } });
    const user = userEvent.setup();
    render(<OnlineStorePage />);
    await user.click(screen.getByRole('button', { name: 'Create online store' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByLabelText('Your own code'));
    await user.click(within(dialog).getByRole('button', { name: 'Create online store' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('This channel already has an online store.'));
    expect(env.create).toHaveBeenCalledWith(expect.objectContaining({ mode: 'static' }));
    expect(env.push).not.toHaveBeenCalled();
  });
});
