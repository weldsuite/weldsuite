import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), delete: vi.fn() }));
vi.mock('@/lib/api/weldbooks-client', () => ({ weldbooksApi: api, setWeldbooksEntityId: vi.fn() }));
const permissions = vi.hoisted(() => ({ allowed: new Set<string>() }));
vi.mock('@weldsuite/permissions/react', () => ({
  usePermissions: () => ({ can: (permission: string) => permissions.allowed.has(permission) }),
}));
vi.mock('@/lib/weldbooks/use-weldbooks-format', () => ({
  useWeldbooksFormat: () => ({
    formatDate: (value: string) => value,
    formatDateTime: (value: string) => value,
    formatMoney: (value: string) => value,
    today: () => '2026-10-08',
  }),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, children, ...rest }: { to: string; children: ReactNode }) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
}));

import { BankFeedsStrip, latestSync } from './bank-feeds-strip';
import { installPointerPolyfills, makeConnection, makeProvider, renderWithProviders } from './test-support';

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

function routes(options: { connections?: unknown; providers?: unknown } = {}) {
  api.get.mockImplementation(async (path: string) => {
    if (path === '/bank-connections') {
      if (options.connections instanceof Error) throw options.connections;
      return { data: options.connections ?? [] };
    }
    if (path.startsWith('/bank-connections/providers')) {
      return { data: options.providers ?? { country: 'US', providers: [makeProvider('plaid', 'plaid_link')] } };
    }
    return { data: [] };
  });
}

/** Waits until both queries settled, so "renders nothing" is not just "still loading". */
async function settled() {
  await waitFor(() => {
    expect(api.get).toHaveBeenCalledWith('/bank-connections');
    expect(api.get.mock.calls.some(([path]) => String(path).startsWith('/bank-connections/providers'))).toBe(true);
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeAll(installPointerPolyfills);

beforeEach(() => {
  api.get.mockReset();
  permissions.allowed = new Set(['banking:read', 'banking:create']);
});

describe('latestSync', () => {
  it('picks the most recent sync and ignores connections that never synced', () => {
    expect(
      latestSync([
        makeConnection({ lastSyncedAt: '2026-10-07T10:00:00.000Z' }),
        makeConnection({ lastSyncedAt: null }),
        makeConnection({ lastSyncedAt: '2026-10-08T09:00:00.000Z' }),
      ]),
    ).toBe('2026-10-08T09:00:00.000Z');
    expect(latestSync([makeConnection({ lastSyncedAt: null })])).toBeNull();
  });
});

describe('BankFeedsStrip', () => {
  it('summarizes the connected banks in one line, with the latest sync and a link to manage them', async () => {
    routes({
      connections: [
        makeConnection({ lastSyncedAt: minutesAgo(30) }),
        makeConnection({ id: 'bkc_2', institutionName: 'Second Bank', lastSyncedAt: minutesAgo(5) }),
      ],
    });
    renderWithProviders(<BankFeedsStrip hasAccounts />);

    const strip = await screen.findByRole('region', { name: 'Bank feeds' });
    expect(strip).toHaveTextContent('2 banks connected');
    expect(strip).toHaveTextContent('synced 5 minutes ago');
    expect(strip).not.toHaveTextContent(/attention/);
    expect(screen.getByRole('link', { name: 'Manage bank feeds' })).toHaveAttribute('href', '/weldbooks/banking/feeds');
  });

  it('counts the banks that need a sign-in or failed, and leaves ended connections out', async () => {
    routes({
      connections: [
        makeConnection({ status: 'reauth_required' }),
        makeConnection({ id: 'bkc_2', status: 'error' }),
        makeConnection({ id: 'bkc_3', status: 'active' }),
        makeConnection({ id: 'bkc_4', status: 'revoked' }),
      ],
    });
    renderWithProviders(<BankFeedsStrip hasAccounts />);

    const strip = await screen.findByRole('region', { name: 'Bank feeds' });
    expect(strip).toHaveTextContent('3 banks connected');
    expect(strip).toHaveTextContent('not synced yet');
    expect(strip).toHaveTextContent('2 need attention');
  });

  it('offers Connect bank when there are accounts but no bank feed', async () => {
    routes({ connections: [] });
    renderWithProviders(<BankFeedsStrip hasAccounts />);

    const strip = await screen.findByRole('region', { name: 'Bank feeds' });
    expect(strip).toHaveTextContent('Connect your bank and new transactions arrive on their own.');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Connect bank' })).toBeEnabled());
  });

  it('stays away without accounts, so the empty list makes the offer once', async () => {
    routes({ connections: [] });
    const { container } = renderWithProviders(<BankFeedsStrip hasAccounts={false} />);
    await settled();
    expect(container).toBeEmptyDOMElement();
  });

  it('stays away when no provider serves this country, or the user may not connect one', async () => {
    routes({ connections: [], providers: { country: 'BE', providers: [] } });
    const first = renderWithProviders(<BankFeedsStrip hasAccounts />);
    await settled();
    expect(first.container).toBeEmptyDOMElement();
    first.unmount();

    api.get.mockReset();
    routes({ connections: [] });
    permissions.allowed = new Set(['banking:read']);
    const second = renderWithProviders(<BankFeedsStrip hasAccounts />);
    await settled();
    expect(second.container).toBeEmptyDOMElement();
  });

  it('stays away when the connections could not be loaded', async () => {
    routes({ connections: new Error('boom') });
    const { container } = renderWithProviders(<BankFeedsStrip hasAccounts />);
    await settled();
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing, and asks for nothing, for someone who may not read banking', () => {
    permissions.allowed = new Set();
    routes();
    const { container } = renderWithProviders(<BankFeedsStrip hasAccounts />);
    expect(container).toBeEmptyDOMElement();
    expect(api.get).not.toHaveBeenCalled();
  });
});
