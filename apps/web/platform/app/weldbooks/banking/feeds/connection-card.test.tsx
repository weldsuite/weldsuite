import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), delete: vi.fn() }));
vi.mock('@/lib/api/weldbooks-client', () => ({ weldbooksApi: api, setWeldbooksEntityId: vi.fn() }));
const permissions = vi.hoisted(() => ({ allowed: new Set<string>() }));
vi.mock('@weldsuite/permissions/react', () => ({
  usePermissions: () => ({ can: (permission: string) => permissions.allowed.has(permission) }),
}));
vi.mock('@/lib/weldbooks/use-weldbooks-format', () => ({
  useWeldbooksFormat: () => ({
    formatDate: (value: string) => `date:${value.slice(0, 10)}`,
    formatDateTime: (value: string) => `at:${value}`,
    formatMoney: (value: string, currency?: string) => `${currency} ${value}`,
    today: () => '2026-10-08',
  }),
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

import { ConnectionCard } from './connection-card';
import {
  PONTO_CAPABILITIES,
  installPointerPolyfills,
  makeAccount,
  makeBankAccount,
  makeConnection,
  makeProvider,
  renderWithProviders,
} from './test-support';

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

const mapped = makeAccount({
  feedAccountId: 'fa_1',
  bankAccountId: 'ba_1',
  bankAccountName: 'Operating',
  syncFrom: '2026-09-01',
});

function syncOutcome(overrides: Record<string, unknown> = {}) {
  return {
    connectionId: 'bkc_1',
    status: 'active',
    added: 3,
    updated: 1,
    removed: 0,
    pending: 0,
    pendingVoided: 0,
    possibleDuplicates: 0,
    autoReconciled: 0,
    warnings: 0,
    ...overrides,
  };
}

function routes(extra: Record<string, unknown> = {}) {
  api.get.mockImplementation(async (path: string) => {
    if (path.startsWith('/bank-connections/providers')) {
      return { data: { country: 'US', providers: [makeProvider('plaid', 'plaid_link')] } };
    }
    if (path.startsWith('/bank-connections/bkc_1/pending')) return { data: extra.pending ?? [] };
    if (path.startsWith('/bank-accounts')) return { data: [makeBankAccount()] };
    return { data: [] };
  });
}

beforeAll(installPointerPolyfills);

beforeEach(() => {
  api.get.mockReset();
  api.post.mockReset();
  api.delete.mockReset();
  toast.success.mockReset();
  toast.error.mockReset();
  toast.info.mockReset();
  permissions.allowed = new Set(['banking:read', 'banking:create', 'banking:update', 'banking:manage']);
  routes();
});

describe('ConnectionCard health', () => {
  it('shows who it is connected through, when it last synced, and each account', () => {
    renderWithProviders(
      <ConnectionCard
        connection={makeConnection({
          lastSyncedAt: new Date(Date.now() - 5 * MINUTE).toISOString(),
          accounts: [mapped, makeAccount({ feedAccountId: 'fa_2', name: 'Rainy Day', mask: '9999' })],
        })}
      />,
    );

    const card = screen.getByRole('region', { name: 'First Platypus Bank' });
    expect(within(card).getByText('Connected')).toBeInTheDocument();
    expect(within(card).getByText(/via Plaid/)).toHaveTextContent('Last synced 5 minutes ago');
    expect(within(card).getByText('Linked to Operating')).toBeInTheDocument();
    expect(within(card).getByText('Importing from date:2026-09-01')).toBeInTheDocument();
    expect(within(card).getByText('Not linked')).toBeInTheDocument();
  });

  it('says a bank was never synced', () => {
    renderWithProviders(<ConnectionCard connection={makeConnection({ accounts: [mapped] })} />);
    expect(screen.getByText(/Not synced yet/)).toBeInTheDocument();
  });

  it('asks the user to sign in again when the bank needs it, and offers no sync meanwhile', async () => {
    renderWithProviders(<ConnectionCard connection={makeConnection({ status: 'reauth_required', accounts: [mapped] })} />);

    expect(screen.getByText('Reconnect needed')).toBeInTheDocument();
    expect(screen.getByText('Sign in to your bank again')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Reconnect' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Sync now' })).not.toBeInTheDocument();
  });

  it('counts the days left on an expiring consent and offers to renew it', async () => {
    renderWithProviders(
      <ConnectionCard
        connection={makeConnection({
          status: 'expiring',
          consentExpiresAt: new Date(Date.now() + 4.5 * DAY).toISOString(),
          accounts: [mapped],
        })}
      />,
    );

    expect(screen.getByText('Expiring soon')).toBeInTheDocument();
    expect(screen.getByText('Access to First Platypus Bank ends in 5 days. Renew it to keep transactions flowing.')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Renew access' })).toBeInTheDocument();
    // An expiring consent still reads data.
    expect(screen.getByRole('button', { name: 'Sync now' })).toBeInTheDocument();
  });

  it.each([
    ['revoked', 'Access revoked', 'Access was revoked'],
    ['disconnected', 'Disconnected', 'Importing is switched off'],
  ] as const)('offers to connect again when the connection is %s', async (status, badge, banner) => {
    renderWithProviders(<ConnectionCard connection={makeConnection({ status, accounts: [mapped] })} />);

    expect(screen.getAllByText(badge).length).toBeGreaterThan(0);
    expect(screen.getByText(new RegExp(banner))).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Connect again' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Sync now' })).not.toBeInTheDocument();
  });

  it('shows the last error of a failing connection', () => {
    renderWithProviders(
      <ConnectionCard connection={makeConnection({ status: 'error', lastError: 'ITEM_NOT_FOUND', accounts: [mapped] })} />,
    );
    expect(screen.getByText('The last sync did not work')).toBeInTheDocument();
    expect(screen.getByText('Reported: ITEM_NOT_FOUND')).toBeInTheDocument();
  });

  it('lists the notes of recent syncs on demand', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <ConnectionCard
        connection={makeConnection({
          accounts: [mapped],
          warnings: [
            { at: '2026-10-07T08:00:00.000Z', code: 'removed_after_reconcile', message: 'A reconciled transaction was removed by the bank' },
            { at: '2026-10-08T08:00:00.000Z', code: 'possible_duplicate', message: 'Possible duplicate of an imported line' },
          ],
        })}
      />,
    );

    expect(screen.queryByText('Possible duplicate of an imported line')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Notes from recent syncs/ }));
    const items = screen.getAllByRole('listitem').map((li) => li.textContent);
    // Newest first.
    expect(items.filter((text) => text?.includes('duplicate') || text?.includes('removed'))).toEqual([
      'at:2026-10-08T08:00:00.000ZPossible duplicate of an imported line',
      'at:2026-10-07T08:00:00.000ZA reconciled transaction was removed by the bank',
    ]);
  });
});

describe('ConnectionCard sync', () => {
  it('syncs now without asking the provider to refresh, and says what changed', async () => {
    const user = userEvent.setup();
    api.post.mockResolvedValue({ data: { outcome: syncOutcome(), connection: makeConnection() } });
    renderWithProviders(<ConnectionCard connection={makeConnection({ accounts: [mapped] })} />);

    await user.click(screen.getByRole('button', { name: 'Sync now' }));

    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Sync finished: 3 new, 1 updated, 0 removed.'));
    expect(api.post).toHaveBeenCalledWith('/bank-connections/bkc_1/sync', { refresh: false });
  });

  it('shows the provider error of a sync that answered 200', async () => {
    const user = userEvent.setup();
    api.post.mockResolvedValue({
      data: { outcome: syncOutcome({ added: 0, updated: 0, error: 'RATE_LIMIT_EXCEEDED' }), connection: makeConnection() },
    });
    renderWithProviders(<ConnectionCard connection={makeConnection({ accounts: [mapped] })} />);

    await user.click(screen.getByRole('button', { name: 'Sync now' }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('The sync did not work: RATE_LIMIT_EXCEEDED'));
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('asks the bank for fresh data only when the provider supports it', async () => {
    const user = userEvent.setup();
    api.post.mockResolvedValue({ data: { outcome: syncOutcome(), connection: makeConnection() } });
    renderWithProviders(<ConnectionCard connection={makeConnection({ accounts: [mapped] })} />);

    await user.click(screen.getByRole('button', { name: 'More actions' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Ask the bank for fresh data' }));

    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/bank-connections/bkc_1/sync', { refresh: true }));
  });

  it('has no refresh item for providers that cannot refresh on demand', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <ConnectionCard
        connection={makeConnection({
          provider: 'ponto',
          capabilities: PONTO_CAPABILITIES,
          accounts: [mapped],
        })}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'More actions' }));
    expect(await screen.findByRole('menuitem', { name: 'Disconnect' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Ask the bank for fresh data' })).not.toBeInTheDocument();
  });

  it('hides sync and the account actions from someone who may only read', () => {
    permissions.allowed = new Set(['banking:read']);
    renderWithProviders(<ConnectionCard connection={makeConnection({ accounts: [mapped, makeAccount({ feedAccountId: 'fa_2' })] })} />);

    expect(screen.queryByRole('button', { name: 'Sync now' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'More actions' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Link accounts' })).not.toBeInTheDocument();
  });
});

describe('ConnectionCard pending transactions', () => {
  it('loads them when opened and shows signed amounts', async () => {
    const user = userEvent.setup();
    routes({
      pending: [
        { id: 'p1', bankAccountId: 'ba_1', date: '2026-10-07', amount: '-42.10', currency: 'USD', description: 'CARD PURCHASE 123', merchantName: 'Blue Bottle' },
        { id: 'p2', bankAccountId: 'ba_1', date: '2026-10-06', amount: '1200.00', currency: 'USD', description: 'ACH CREDIT', merchantName: null },
      ],
    });
    renderWithProviders(<ConnectionCard connection={makeConnection({ accounts: [mapped] })} />);

    expect(api.get).not.toHaveBeenCalledWith('/bank-connections/bkc_1/pending');
    await user.click(screen.getByRole('button', { name: 'Pending transactions' }));

    expect(await screen.findByText('Blue Bottle')).toBeInTheDocument();
    expect(screen.getByText('ACH CREDIT')).toBeInTheDocument();
    expect(screen.getByText('USD -42.10')).toBeInTheDocument();
    expect(screen.getByText('USD 1200.00')).toBeInTheDocument();
  });

  it('says when there are none', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ConnectionCard connection={makeConnection({ accounts: [mapped] })} />);
    await user.click(screen.getByRole('button', { name: 'Pending transactions' }));
    expect(await screen.findByText('No pending transactions.')).toBeInTheDocument();
  });

  it('is left out for providers that report no pending transactions', () => {
    renderWithProviders(
      <ConnectionCard connection={makeConnection({ provider: 'ponto', capabilities: PONTO_CAPABILITIES, accounts: [mapped] })} />,
    );
    expect(screen.queryByRole('button', { name: 'Pending transactions' })).not.toBeInTheDocument();
  });
});

describe('ConnectionCard disconnect and remove', () => {
  it('disconnects after a confirmation that says synced transactions stay', async () => {
    const user = userEvent.setup();
    api.post.mockResolvedValue({ data: makeConnection({ status: 'disconnected' }) });
    renderWithProviders(<ConnectionCard connection={makeConnection({ accounts: [mapped] })} />);

    await user.click(screen.getByRole('button', { name: 'More actions' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Disconnect' }));

    const dialog = await screen.findByRole('dialog', { name: 'Disconnect First Platypus Bank?' });
    expect(within(dialog).getByText(/Everything already imported stays on your bank accounts/)).toBeInTheDocument();
    expect(api.post).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole('button', { name: 'Disconnect' }));

    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/bank-connections/bkc_1/disconnect'));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('First Platypus Bank disconnected.'));
  });

  it('removes the connection after a confirmation', async () => {
    const user = userEvent.setup();
    api.delete.mockResolvedValue(undefined);
    renderWithProviders(<ConnectionCard connection={makeConnection({ accounts: [mapped] })} />);

    await user.click(screen.getByRole('button', { name: 'More actions' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Remove connection' }));

    const dialog = await screen.findByRole('dialog', { name: 'Remove First Platypus Bank?' });
    expect(within(dialog).getByText(/stays on your bank accounts and in your books/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Remove connection' }));

    await waitFor(() => expect(api.delete).toHaveBeenCalledWith('/bank-connections/bkc_1'));
  });

  it('keeps the dialog and reports the failure when the bank cannot be reached', async () => {
    const user = userEvent.setup();
    api.post.mockRejectedValue(Object.assign(new Error('Plaid timeout'), { status: 502, code: 'UPSTREAM_ERROR' }));
    renderWithProviders(<ConnectionCard connection={makeConnection({ accounts: [mapped] })} />);

    await user.click(screen.getByRole('button', { name: 'More actions' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Disconnect' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Disconnect' }));

    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('offers no disconnect or remove without banking:manage', async () => {
    const user = userEvent.setup();
    permissions.allowed = new Set(['banking:read', 'banking:update']);
    renderWithProviders(<ConnectionCard connection={makeConnection({ accounts: [mapped] })} />);

    await user.click(screen.getByRole('button', { name: 'More actions' }));
    expect(await screen.findByRole('menuitem', { name: 'Ask the bank for fresh data' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Disconnect' })).not.toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Remove connection' })).not.toBeInTheDocument();
  });
});

describe('ConnectionCard account linking', () => {
  it('opens the mapping dialog for accounts that are not linked yet', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <ConnectionCard
        connection={makeConnection({ accounts: [mapped, makeAccount({ feedAccountId: 'fa_2', name: 'Rainy Day' })] })}
      />,
    );

    expect(screen.getByText('1 account is not linked to a WeldBooks bank account, so its transactions are not imported.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Link accounts' }));

    const dialog = await screen.findByRole('dialog', { name: 'Link your First Platypus Bank accounts' });
    expect(await within(dialog).findByRole('group', { name: 'Rainy Day' })).toBeInTheDocument();
    expect(within(dialog).queryByRole('group', { name: 'Business Checking' })).not.toBeInTheDocument();
  });
});
