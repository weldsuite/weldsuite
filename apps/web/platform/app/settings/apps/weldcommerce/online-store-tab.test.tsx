import type { ReactNode } from 'react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { OnlineStoreSite, StorefrontHost, StorefrontHostsConfig } from '@/hooks/queries/use-online-store-queries';

const query = <T,>(data: T) => ({ data: { data }, isPending: false, isError: false, refetch: vi.fn() });

const env = vi.hoisted(() => ({
  allowed: new Set<string>(),
  sites: null as unknown,
  config: null as unknown,
  hosts: null as unknown,
  deployments: null as unknown,
  createHost: vi.fn(),
  refreshHost: vi.fn(),
  primaryHost: vi.fn(),
  deleteHost: vi.fn(),
  updateSite: vi.fn(),
  promote: vi.fn(),
  deleteDeployment: vi.fn(),
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));

vi.mock('sonner', () => ({ toast }));
vi.mock('@weldsuite/permissions/react', () => ({
  usePermissionsMaybe: () => ({ can: (permission: string) => env.allowed.has(permission), isLoading: false }),
}));
vi.mock('@/hooks/queries/use-online-store-queries', () => ({
  useOnlineStoreSites: () => env.sites,
  useStorefrontHostsConfig: () => env.config,
  useStorefrontHosts: () => env.hosts,
  useStoreDeployments: () => env.deployments,
  useCreateStorefrontHost: () => ({ mutateAsync: env.createHost }),
  useRefreshStorefrontHost: () => ({ mutateAsync: env.refreshHost, isPending: false }),
  useMakeStorefrontHostPrimary: () => ({ mutateAsync: env.primaryHost }),
  useDeleteStorefrontHost: () => ({ mutateAsync: env.deleteHost }),
  useUpdateOnlineStoreSite: () => ({ mutateAsync: env.updateSite }),
  usePromoteDeployment: () => ({ mutateAsync: env.promote }),
  useDeleteDeployment: () => ({ mutateAsync: env.deleteDeployment }),
  onlineStoreErrorCode: (err: { body?: { error?: { code?: string } } }) => err?.body?.error?.code,
}));
vi.mock('@/lib/router', () => ({
  Link: ({ href, children }: { href: string; children: ReactNode }) => <a href={href}>{children}</a>,
}));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, search, children, ...rest }: { to: string; search?: Record<string, string>; children: ReactNode }) => (
    <a href={`${to}?${new URLSearchParams(search).toString()}`} {...rest}>
      {children}
    </a>
  ),
}));

import { OnlineStoreTab } from './online-store-tab';

const site = (over: Partial<OnlineStoreSite> = {}): OnlineStoreSite => ({
  id: 'sfs_1',
  channelId: 'ch_1',
  channelName: 'Webshop',
  channelStatus: 'active',
  mode: 'builder',
  locale: 'en',
  theme: 'atelier',
  visibility: 'live',
  hasPassword: false,
  draftRevision: 1,
  draftUpdatedAt: '2026-11-20T10:00:00Z',
  publishedVersionId: null,
  publishedVersionNumber: null,
  publishedAt: null,
  hasUnpublishedChanges: true,
  activeDeploymentId: null,
  primaryHost: null,
  previewHost: null,
  createdAt: '2026-11-01T10:00:00Z',
  updatedAt: '2026-11-20T10:00:00Z',
  ...over,
});

const config = (over: Partial<StorefrontHostsConfig> = {}): StorefrontHostsConfig => ({
  available: true,
  baseDomain: 'weldshop.eu',
  cnameTarget: 'shops.weldsuite.eu',
  apexAddresses: ['203.0.113.10'],
  customDomains: true,
  ...over,
});

const customHost = (over: Partial<StorefrontHost> = {}): StorefrontHost => ({
  id: 'sfh_2',
  siteId: 'sfs_1',
  hostname: 'shop.example.com',
  kind: 'custom',
  isPrimary: false,
  status: 'pending',
  sslStatus: null,
  lastError: 'The TXT record was not found.',
  lastCheckedAt: '2026-11-22T10:00:00Z',
  url: 'https://shop.example.com',
  dnsRecords: [
    { type: 'TXT', name: '_weldcommerce.shop.example.com', value: 'weldcommerce-verify=abc123', purpose: 'ownership' },
    { type: 'CNAME', name: 'shop.example.com', value: 'shops.weldsuite.eu', purpose: 'routing' },
  ],
  createdAt: '2026-11-22T09:00:00Z',
  ...over,
});

const freeHost = (over: Partial<StorefrontHost> = {}): StorefrontHost => ({
  ...customHost(),
  id: 'sfh_1',
  hostname: 'webshop.weldshop.eu',
  kind: 'subdomain',
  isPrimary: true,
  status: 'active',
  sslStatus: 'active',
  lastError: null,
  url: 'https://webshop.weldshop.eu',
  dnsRecords: [],
  ...over,
});

beforeAll(() => {
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.setPointerCapture ??= () => undefined;
  Element.prototype.releasePointerCapture ??= () => undefined;
  Element.prototype.scrollIntoView ??= () => undefined;
});

beforeEach(() => {
  env.allowed = new Set(['websites:read', 'websites:manage', 'websites:update', 'websites:delete']);
  env.sites = query([site()]);
  env.config = query(config());
  env.hosts = query([] as StorefrontHost[]);
  env.deployments = query([]);
  for (const fn of [env.createHost, env.refreshHost, env.primaryHost, env.deleteHost, env.updateSite, env.promote, env.deleteDeployment, toast.success, toast.error]) {
    fn.mockReset();
  }
  env.updateSite.mockImplementation(async ({ data }: { data: Partial<OnlineStoreSite> }) => ({ data: { ...site(), ...data } }));
});

describe('OnlineStoreTab', () => {
  it('says there is no access without websites:read', () => {
    env.allowed = new Set();
    render(<OnlineStoreTab onSelectSite={vi.fn()} />);
    expect(screen.getByText('You do not have access to the online store settings.')).toBeTruthy();
  });

  it('points to the online store when there is none yet', () => {
    env.sites = query([]);
    render(<OnlineStoreTab onSelectSite={vi.fn()} />);
    expect(screen.getByText('No online store yet')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Go to the online store' }).getAttribute('href')).toBe('/weldcommerce/online-store');
  });

  it('claims the free address on the base domain', async () => {
    env.createHost.mockResolvedValue({ data: freeHost() });
    const user = userEvent.setup();
    render(<OnlineStoreTab onSelectSite={vi.fn()} />);
    expect(screen.getByText('Every store can have a free address on weldshop.eu.')).toBeTruthy();
    expect(screen.getByText('.weldshop.eu')).toBeTruthy();
    await user.type(screen.getByLabelText('Shop name in the address'), 'Webshop');
    await user.click(screen.getByRole('button', { name: 'Claim address' }));
    await waitFor(() => expect(env.createHost).toHaveBeenCalledWith({ siteId: 'sfs_1', subdomain: 'webshop' }));
    expect(toast.success).toHaveBeenCalledWith('Address claimed');
  });

  it('refuses an invalid name, and puts a taken one on the field', async () => {
    env.createHost.mockRejectedValue({ status: 409, body: { error: { code: 'HOST_TAKEN' } } });
    const user = userEvent.setup();
    render(<OnlineStoreTab onSelectSite={vi.fn()} />);
    await user.type(screen.getByLabelText('Shop name in the address'), '-bad-');
    await user.click(screen.getByRole('button', { name: 'Claim address' }));
    expect(await screen.findByText('Use lowercase letters, numbers and hyphens, starting with a letter or a number.')).toBeTruthy();
    expect(env.createHost).not.toHaveBeenCalled();

    await user.clear(screen.getByLabelText('Shop name in the address'));
    await user.type(screen.getByLabelText('Shop name in the address'), 'taken');
    await user.click(screen.getByRole('button', { name: 'Claim address' }));
    expect(await screen.findByText('This address is already taken.')).toBeTruthy();
    expect(screen.getByLabelText('Shop name in the address').getAttribute('aria-invalid')).toBe('true');
  });

  it('says free addresses are not set up when the installation has none', () => {
    env.config = query(config({ available: false, customDomains: false }));
    render(<OnlineStoreTab onSelectSite={vi.fn()} />);
    expect(screen.getByText('Free addresses are not set up on this installation.')).toBeTruthy();
    expect(screen.getByText('Custom domains are not available on this installation.')).toBeTruthy();
    expect(screen.queryByLabelText('Domain')).toBeNull();
  });

  it('lists a custom domain with the DNS records to create, its status and its last problem', () => {
    env.hosts = query([freeHost(), customHost()]);
    render(<OnlineStoreTab onSelectSite={vi.fn()} />);
    // The claimed free address replaces the claim form.
    expect(screen.queryByLabelText('Shop name in the address')).toBeNull();
    expect(screen.getByRole('link', { name: 'Open webshop.weldshop.eu in a new tab' })).toBeTruthy();

    const card = screen.getByRole('link', { name: 'Open shop.example.com in a new tab' }).closest('li')!;
    expect(within(card).getByText('Waiting for DNS')).toBeTruthy();
    expect(within(card).getByText('Last problem: The TXT record was not found.')).toBeTruthy();
    const rows = within(card).getAllByRole('row');
    expect(rows).toHaveLength(3);
    expect(within(rows[1]!).getByText('TXT')).toBeTruthy();
    expect(within(rows[1]!).getByText('_weldcommerce.shop.example.com')).toBeTruthy();
    expect(within(rows[1]!).getByText('weldcommerce-verify=abc123')).toBeTruthy();
    expect(within(rows[1]!).getByText('Proves the domain is yours')).toBeTruthy();
    expect(within(rows[2]!).getByText('CNAME')).toBeTruthy();
    expect(within(rows[2]!).getByText('shops.weldsuite.eu')).toBeTruthy();
    // Pending, so it cannot be the primary address yet.
    expect(within(card).queryByRole('button', { name: /Make shop.example.com the primary address/ })).toBeNull();
  });

  it('copies a record’s name and value', async () => {
    env.hosts = query([customHost()]);
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);
    render(<OnlineStoreTab onSelectSite={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'Copy the value of the TXT record' }));
    expect(writeText).toHaveBeenCalledWith('weldcommerce-verify=abc123');
    await user.click(screen.getByRole('button', { name: 'Copy the name of the CNAME record' }));
    expect(writeText).toHaveBeenLastCalledWith('shop.example.com');
    expect((await screen.findAllByText('Copied')).length).toBeGreaterThan(0);
  });

  it('shows the apex addresses hint for A records', () => {
    env.hosts = query([
      customHost({
        hostname: 'example.com',
        dnsRecords: [
          { type: 'TXT', name: '_weldcommerce.example.com', value: 'weldcommerce-verify=abc', purpose: 'ownership' },
          { type: 'A', name: 'example.com', value: '203.0.113.10', purpose: 'routing' },
        ],
      }),
    ]);
    render(<OnlineStoreTab onSelectSite={vi.fn()} />);
    expect(screen.getByText('203.0.113.10')).toBeTruthy();
    expect(screen.getByText(/cannot have a CNAME record/)).toBeTruthy();
  });

  it('checks again, makes primary and removes a domain', async () => {
    env.hosts = query([freeHost(), customHost({ status: 'active', sslStatus: 'active', lastError: null })]);
    env.refreshHost.mockResolvedValue({ data: customHost() });
    env.primaryHost.mockResolvedValue({ data: customHost() });
    env.deleteHost.mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(<OnlineStoreTab onSelectSite={vi.fn()} />);
    expect(screen.getAllByText('HTTPS ready')).toHaveLength(2);
    await user.click(screen.getByRole('button', { name: 'Check the DNS records of shop.example.com again' }));
    await waitFor(() => expect(env.refreshHost).toHaveBeenCalledWith({ siteId: 'sfs_1', hostId: 'sfh_2' }));
    await user.click(screen.getByRole('button', { name: 'Make shop.example.com the primary address' }));
    await waitFor(() => expect(env.primaryHost).toHaveBeenCalledWith({ siteId: 'sfs_1', hostId: 'sfh_2' }));
    await user.click(screen.getByRole('button', { name: 'Remove shop.example.com' }));
    const dialog = await screen.findByRole('alertdialog').catch(() => screen.findByRole('dialog'));
    await user.click(within(dialog).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(env.deleteHost).toHaveBeenCalledWith({ siteId: 'sfs_1', hostId: 'sfh_2' }));
  });

  it('adds a custom domain after checking it is a host name', async () => {
    env.createHost.mockResolvedValue({ data: customHost() });
    const user = userEvent.setup();
    render(<OnlineStoreTab onSelectSite={vi.fn()} />);
    await user.type(screen.getByLabelText('Domain'), 'https://shop.example.com/');
    await user.click(screen.getByRole('button', { name: 'Add domain' }));
    expect(await screen.findByText('Enter a domain such as shop.example.com, without https://.')).toBeTruthy();
    expect(env.createHost).not.toHaveBeenCalled();
    await user.clear(screen.getByLabelText('Domain'));
    await user.type(screen.getByLabelText('Domain'), 'Shop.Example.com');
    await user.click(screen.getByRole('button', { name: 'Add domain' }));
    await waitFor(() => expect(env.createHost).toHaveBeenCalledWith({ siteId: 'sfs_1', hostname: 'shop.example.com' }));
  });

  it('lets a member who may only read look, without the forms or actions', () => {
    env.allowed = new Set(['websites:read']);
    env.hosts = query([customHost({ status: 'active' })]);
    render(<OnlineStoreTab onSelectSite={vi.fn()} />);
    expect(screen.queryByLabelText('Shop name in the address')).toBeNull();
    expect(screen.queryByLabelText('Domain')).toBeNull();
    expect(screen.queryByRole('button', { name: /Remove shop.example.com/ })).toBeNull();
    expect(screen.getByText('Only members who manage the online store can change its visibility.')).toBeTruthy();
    // The records stay readable, so someone else can create them.
    expect(screen.getByText('weldcommerce-verify=abc123')).toBeTruthy();
  });

  it('asks for a password when the store gets one, and saves the visibility', async () => {
    const user = userEvent.setup();
    render(<OnlineStoreTab onSelectSite={vi.fn()} />);
    await user.click(screen.getByLabelText('Password: visitors need a password'));
    const visibility = screen.getByRole('form', { name: 'Visibility' });
    await user.click(within(visibility).getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Enter a password of at least 6 characters.')).toBeTruthy();
    expect(env.updateSite).not.toHaveBeenCalled();
    await user.type(within(visibility).getByLabelText('Password'), 'opensesame');
    await user.click(within(visibility).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(env.updateSite).toHaveBeenCalledWith({ siteId: 'sfs_1', data: { visibility: 'password', password: 'opensesame' } }));
  });

  it('keeps an existing password when the field is left empty', async () => {
    env.sites = query([site({ visibility: 'coming_soon', hasPassword: true })]);
    const user = userEvent.setup();
    render(<OnlineStoreTab onSelectSite={vi.fn()} />);
    await user.click(screen.getByLabelText('Password: visitors need a password'));
    expect(screen.getByText('Leave empty to keep the current password.')).toBeTruthy();
    await user.click(within(screen.getByRole('form', { name: 'Visibility' })).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(env.updateSite).toHaveBeenCalledWith({ siteId: 'sfs_1', data: { visibility: 'password' } }));
  });

  it('shows deployments and how to deploy only for a store built with your own code', async () => {
    const { unmount } = render(<OnlineStoreTab onSelectSite={vi.fn()} />);
    expect(screen.queryByText('Deployments')).toBeNull();
    unmount();

    env.sites = query([site({ mode: 'static' })]);
    env.deployments = query([
      {
        id: 'dep_2',
        siteId: 'sfs_1',
        status: 'ready',
        fileCount: 12,
        totalBytes: 2_400_000,
        isProduction: false,
        previewUrl: 'https://dep-2--webshop.weldshop.eu',
        createdAt: '2026-11-22T10:00:00Z',
        promotedAt: null,
        createdByUserId: null,
        createdByKeyId: 'key_1',
        error: null,
      },
      {
        id: 'dep_1',
        siteId: 'sfs_1',
        status: 'ready',
        fileCount: 10,
        totalBytes: 2_000_000,
        isProduction: true,
        previewUrl: null,
        createdAt: '2026-11-21T10:00:00Z',
        promotedAt: '2026-11-21T10:00:00Z',
        createdByUserId: 'usr_1',
        createdByKeyId: null,
        error: null,
      },
    ]);
    env.promote.mockResolvedValue({ data: {} });
    const user = userEvent.setup();
    render(<OnlineStoreTab onSelectSite={vi.fn()} />);
    expect(screen.getByText('Deployments')).toBeTruthy();
    expect(screen.getByText('Production')).toBeTruthy();
    expect(screen.getByText('12 files, 2.4 MB')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Open the channel’s keys' }).getAttribute('href')).toBe('/settings/apps/weldcommerce?tab=channels&channel=ch_1');
    expect(screen.getByLabelText('Deploy command')).toHaveProperty('value', 'WELDCOMMERCE_DEPLOY_KEY=wcd_… weld storefront deploy');
    // The production deployment can be neither promoted nor deleted.
    expect(screen.getAllByRole('button', { name: /^Delete the upload/ })).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: /^Make the upload of .* production$/ }));
    const dialog = await screen.findByRole('alertdialog').catch(() => screen.findByRole('dialog'));
    await user.click(within(dialog).getByRole('button', { name: 'Make production' }));
    await waitFor(() => expect(env.promote).toHaveBeenCalledWith({ siteId: 'sfs_1', deploymentId: 'dep_2' }));
  });

  it('picks the store from ?site= and offers the others', async () => {
    env.sites = query([site(), site({ id: 'sfs_2', channelId: 'ch_2', channelName: 'B2B portal' })]);
    const onSelectSite = vi.fn();
    const user = userEvent.setup();
    render(<OnlineStoreTab siteId="sfs_2" onSelectSite={onSelectSite} />);
    const picker = screen.getByRole('combobox', { name: 'Online store' });
    expect(picker.textContent).toContain('B2B portal');
    await user.click(picker);
    await user.click(await screen.findByRole('option', { name: 'Webshop' }));
    expect(onSelectSite).toHaveBeenCalledWith('sfs_1');
  });
});
