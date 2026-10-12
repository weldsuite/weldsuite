import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nProvider } from '@weldsuite/i18n/provider';
import { ApiError } from '@weldsuite/api-client';
import {
  WELDREACH_DEFAULT_LIMITS,
  type ReachDomain,
  type ReachMailbox,
} from '@weldsuite/app-api-client/schemas/reach';

const api = vi.hoisted(() => ({
  reach: {
    access: vi.fn(),
    listDomains: vi.fn(),
    listMailboxes: vi.fn(),
    domainCandidates: vi.fn(),
    refreshDomainDns: vi.fn(),
    disconnectDomain: vi.fn(),
    pauseMailbox: vi.fn(),
    resumeMailbox: vi.fn(),
    deleteMailbox: vi.fn(),
    createMailbox: vi.fn(),
    updateMailbox: vi.fn(),
    connectDomain: vi.fn(),
  },
}));
const permissions = vi.hoisted(() => ({ can: vi.fn() }));
vi.mock('@/lib/api/use-app-api', () => ({ useAppApi: () => api }));
vi.mock('@weldsuite/permissions/react', () => ({ usePermissions: () => ({ can: permissions.can, isOwner: false }) }));
vi.mock('@/contexts/breadcrumb-context', () => ({ useBreadcrumbs: vi.fn() }));
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn(), useSearch: () => ({}) }));
vi.mock('@/lib/router', () => ({
  Link: ({ href, children }: { href: string; children?: React.ReactNode }) => <a href={href}>{children}</a>,
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

import ReachMailboxesPage from './page';

const NOW = new Date('2026-10-12T10:00:00.000Z');

function domain(overrides: Partial<ReachDomain> = {}): ReachDomain {
  return {
    id: 'rdm_1',
    hostDomainId: 'dom_1',
    name: 'getacme.com',
    mailpoolDomainId: 'mp_1',
    status: 'active',
    dnsStatus: { spf: true, dkim: true, dmarc: false, mx: true, checkedAt: NOW.toISOString() },
    dmarcPolicy: null,
    connectedAt: '2026-10-01T00:00:00.000Z',
    lastError: null,
    mailboxCount: 2,
    createdAt: '2026-10-01T00:00:00.000Z',
    ...overrides,
  };
}

function mailbox(overrides: Partial<ReachMailbox> = {}): ReachMailbox {
  return {
    id: 'rmb_1',
    domainId: 'rdm_1',
    domainName: 'getacme.com',
    email: 'anna@getacme.com',
    firstName: 'Anna',
    lastName: 'de Vries',
    signature: null,
    type: 'shared',
    status: 'active',
    warmupDay: 14,
    warmupStatus: null,
    dailyCap: 30,
    rampCurrent: 20,
    sentToday: 12,
    lastSentAt: null,
    pausedReason: null,
    lastError: null,
    createdAt: '2026-10-01T00:00:00.000Z',
    ...overrides,
  };
}

function list<T>(data: T[]) {
  return { data, pagination: { totalCount: data.length, hasMore: false, cursor: null } };
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retryDelay: 0 }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <I18nProvider initialLanguage="en">
        <ReachMailboxesPage />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

beforeAll(() => {
  const proto = window.HTMLElement.prototype as unknown as Record<string, unknown>;
  proto.hasPointerCapture ??= () => false;
  proto.setPointerCapture ??= () => undefined;
  proto.releasePointerCapture ??= () => undefined;
  proto.scrollIntoView ??= () => undefined;
});

beforeEach(() => {
  for (const fn of Object.values(api.reach)) fn.mockReset();
  toast.success.mockReset();
  toast.error.mockReset();
  permissions.can.mockReset();
  permissions.can.mockReturnValue(true);
  api.reach.access.mockResolvedValue({
    data: {
      status: 'approved',
      limits: { ...WELDREACH_DEFAULT_LIMITS, maxMailboxes: 10, maxDomains: 3 },
      usage: { domains: 1, mailboxes: 2, sendsToday: 12 },
      sendingEnabled: true,
    },
  });
  api.reach.listDomains.mockResolvedValue(list([domain()]));
  api.reach.listMailboxes.mockResolvedValue(
    list([
      mailbox(),
      mailbox({ id: 'rmb_2', email: 'ben@getacme.com', firstName: 'Ben', status: 'warming', warmupDay: 6, sentToday: 0, rampCurrent: 10 }),
    ]),
  );
  api.reach.domainCandidates.mockResolvedValue(list([]));
});

afterEach(cleanup);

describe('Mailboxes & domains page', () => {
  it('lists domains with their DNS checks and mailboxes with warmup progress and today\'s sends', async () => {
    renderPage();

    expect(await screen.findByText('getacme.com', { selector: 'p' })).toBeInTheDocument();
    // SPF, DKIM, MX pass; DMARC does not: each states it in words for screen readers.
    expect(screen.getByText('SPF is in place')).toBeInTheDocument();
    expect(screen.getByText('DMARC is missing or wrong')).toBeInTheDocument();

    expect(await screen.findByText('anna@getacme.com')).toBeInTheDocument();
    expect(screen.getByText('Day 6 of 14')).toBeInTheDocument();
    expect(screen.getByText('12 of 20')).toBeInTheDocument();
    expect(screen.getByText('Ready')).toBeInTheDocument();
    expect(screen.getByText('Warming up')).toBeInTheDocument();
    expect(screen.getByText('1 of 3 domains connected.', { exact: false })).toBeInTheDocument();
  });

  it('shows empty states with a way forward', async () => {
    api.reach.listDomains.mockResolvedValue(list([]));
    api.reach.listMailboxes.mockResolvedValue(list([]));
    renderPage();

    expect(await screen.findByText('No domains connected yet.')).toBeInTheDocument();
    expect(await screen.findByText('No mailboxes yet.')).toBeInTheDocument();
    expect(screen.getByText('Connect a domain first, then create your first mailbox.')).toBeInTheDocument();
    // Nothing to create a mailbox on yet.
    expect(screen.getByRole('button', { name: 'New mailbox' })).toBeDisabled();
  });

  it('offers a retry when loading fails', async () => {
    api.reach.listMailboxes.mockRejectedValue(new ApiError('boom', 500, { error: { code: 'INTERNAL' } }));
    renderPage();

    expect(await screen.findByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('hides every write action from someone who can only read', async () => {
    permissions.can.mockImplementation((key: string) => key.endsWith(':read'));
    renderPage();

    await screen.findByText('anna@getacme.com');
    expect(screen.queryByRole('button', { name: 'New mailbox' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Connect domain' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open menu' })).not.toBeInTheDocument();
  });

  it('pauses an active mailbox and resumes a paused one', async () => {
    api.reach.pauseMailbox.mockResolvedValue({ data: mailbox({ status: 'paused' }) });
    const user = userEvent.setup();
    renderPage();

    await screen.findByText('anna@getacme.com');
    await user.click(screen.getAllByRole('button', { name: 'Open menu' })[1]);
    await user.click(await screen.findByRole('menuitem', { name: 'Pause' }));

    await waitFor(() => expect(api.reach.pauseMailbox).toHaveBeenCalledWith('rmb_1'));
    expect(toast.success).toHaveBeenCalledWith('Mailbox paused.');
  });

  it('deletes a mailbox only after confirming that billing stops', async () => {
    api.reach.deleteMailbox.mockResolvedValue({});
    const user = userEvent.setup();
    renderPage();

    await screen.findByText('anna@getacme.com');
    await user.click(screen.getAllByRole('button', { name: 'Open menu' })[1]);
    await user.click(await screen.findByRole('menuitem', { name: 'Delete' }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Delete anna@getacme.com?')).toBeInTheDocument();
    expect(within(dialog).getByText(/billing for it stops/)).toBeInTheDocument();
    expect(api.reach.deleteMailbox).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole('button', { name: 'Delete mailbox' }));
    await waitFor(() => expect(api.reach.deleteMailbox).toHaveBeenCalledWith('rmb_1'));
  });

  it('does not let a domain with mailboxes be disconnected', async () => {
    const user = userEvent.setup();
    renderPage();

    await screen.findByText('getacme.com', { selector: 'p' });
    await user.click(screen.getAllByRole('button', { name: 'Open menu' })[0]);
    const item = await screen.findByRole('menuitem', { name: 'Disconnect' });
    expect(item).toHaveAttribute('aria-disabled', 'true');
  });

  it('explains a 409 DOMAIN_HAS_MAILBOXES from the server', async () => {
    api.reach.listDomains.mockResolvedValue(list([domain({ mailboxCount: 0 })]));
    api.reach.disconnectDomain.mockRejectedValue(
      new ApiError('conflict', 409, { error: { code: 'DOMAIN_HAS_MAILBOXES', message: 'conflict' } }),
    );
    const user = userEvent.setup();
    renderPage();

    await screen.findByText('getacme.com', { selector: 'p' });
    await user.click(screen.getAllByRole('button', { name: 'Open menu' })[0]);
    await user.click(await screen.findByRole('menuitem', { name: 'Disconnect' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Disconnect' }));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        'This domain still has mailboxes. Delete them first, then disconnect the domain.',
      ),
    );
  });
});
